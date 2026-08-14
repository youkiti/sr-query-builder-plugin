import { TokenBucket, exponentialBackoff, retryWithBackoff } from './rateLimit';

/** now / sleep を注入した決定的な擬似クロック。実タイマーを一切使わずに検証するために使う。 */
function makeFakeClock(startMs = 0) {
  let ms = startMs;
  const sleep = jest.fn(async (waitMs: number) => {
    ms += waitMs;
  });
  return { now: () => ms, sleep, advance: (deltaMs: number) => (ms += deltaMs) };
}

describe('exponentialBackoff', () => {
  test('既定 base=1000, factor=2 で 1000, 2000, 4000, ... と増える', () => {
    expect(exponentialBackoff(0)).toBe(1000);
    expect(exponentialBackoff(1)).toBe(2000);
    expect(exponentialBackoff(2)).toBe(4000);
    expect(exponentialBackoff(3)).toBe(8000);
  });

  test('maxMs で頭打ちになる', () => {
    expect(exponentialBackoff(10, { maxMs: 5000 })).toBe(5000);
  });

  test('base / factor を指定できる', () => {
    expect(exponentialBackoff(2, { baseMs: 100, factor: 3 })).toBe(900);
  });
});

describe('retryWithBackoff', () => {
  test('成功なら 1 回呼び出しで値を返す', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    await expect(retryWithBackoff(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('失敗後に成功すると結果を返す', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue('ok');
    const sleep = jest.fn().mockResolvedValue(undefined);
    await expect(retryWithBackoff(fn, { sleep, baseMs: 1 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  test('maxRetries 超過で最後のエラーを throw', async () => {
    const err = new Error('boom');
    const fn = jest.fn().mockRejectedValue(err);
    const sleep = jest.fn().mockResolvedValue(undefined);
    await expect(retryWithBackoff(fn, { sleep, maxRetries: 2, baseMs: 1 })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(3); // 初回 + 2 リトライ
  });

  test('shouldRetry が false ならリトライせず即 throw', async () => {
    const err = new Error('boom');
    const fn = jest.fn().mockRejectedValue(err);
    const shouldRetry = jest.fn().mockReturnValue(false);
    await expect(retryWithBackoff(fn, { shouldRetry, maxRetries: 5, baseMs: 1 })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(shouldRetry).toHaveBeenCalledWith(err, 0);
  });

  test('shouldRetryValue が true の間は値でもリトライする', async () => {
    const fn = jest
      .fn()
      .mockResolvedValueOnce('busy')
      .mockResolvedValueOnce('busy')
      .mockResolvedValue('ok');
    const sleep = jest.fn().mockResolvedValue(undefined);
    const result = await retryWithBackoff(fn, {
      shouldRetryValue: (v) => v === 'busy',
      baseMs: 1,
      sleep,
    });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test('shouldRetryValue が true のまま maxRetries に達したら最後の値を返す', async () => {
    const fn = jest.fn().mockResolvedValue('busy');
    const sleep = jest.fn().mockResolvedValue(undefined);
    const result = await retryWithBackoff(fn, {
      shouldRetryValue: () => true,
      maxRetries: 2,
      baseMs: 1,
      sleep,
    });
    expect(result).toBe('busy');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test('既定 sleep（setTimeout）でも動作する', async () => {
    jest.useFakeTimers();
    try {
      const fn = jest.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValue('ok');
      const promise = retryWithBackoff(fn, { baseMs: 1000 });
      await Promise.resolve();
      jest.runAllTimers();
      await expect(promise).resolves.toBe('ok');
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('TokenBucket', () => {
  test('capacity 分は待たずに連続で acquire できる', async () => {
    const clock = makeFakeClock();
    const bucket = new TokenBucket({ ratePerSecond: 3, now: clock.now, sleep: clock.sleep });
    await bucket.acquire();
    await bucket.acquire();
    await bucket.acquire();
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  test('capacity を使い切ると、次の acquire は不足分だけ待つ', async () => {
    const clock = makeFakeClock();
    const bucket = new TokenBucket({ ratePerSecond: 3, now: clock.now, sleep: clock.sleep });
    await bucket.acquire();
    await bucket.acquire();
    await bucket.acquire();
    await bucket.acquire(); // 4 回目（capacity=3 を超える）

    expect(clock.sleep).toHaveBeenCalledTimes(1);
    expect(clock.sleep.mock.calls[0]?.[0]).toBeCloseTo(1000 / 3, 5); // 1 トークン分 = 1/rate 秒
  });

  test('capacity を省略すると ratePerSecond と同じ既定値になる', async () => {
    const clock = makeFakeClock();
    const bucket = new TokenBucket({ ratePerSecond: 2, now: clock.now, sleep: clock.sleep });
    await bucket.acquire();
    await bucket.acquire();
    expect(clock.sleep).not.toHaveBeenCalled();
    await bucket.acquire(); // 3 回目は capacity=2 を超えるので待つ
    expect(clock.sleep).toHaveBeenCalledTimes(1);
  });

  test('時間が経過すればトークンは補充され、以降は待たずに acquire できる', async () => {
    const clock = makeFakeClock();
    const bucket = new TokenBucket({ ratePerSecond: 3, now: clock.now, sleep: clock.sleep });
    await bucket.acquire();
    await bucket.acquire();
    await bucket.acquire(); // capacity=3 を使い切る

    clock.advance(1000); // 1 秒経過 → capacity 上限（3 トークン）まで補充される

    await bucket.acquire();
    await bucket.acquire();
    await bucket.acquire();
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  test('rate が上がるほど待ち時間は短くなる（10 req/s 相当）', async () => {
    const clock = makeFakeClock();
    const bucket = new TokenBucket({ ratePerSecond: 10, now: clock.now, sleep: clock.sleep });
    for (let i = 0; i < 10; i += 1) {
      await bucket.acquire();
    }
    expect(clock.sleep).not.toHaveBeenCalled();
    await bucket.acquire(); // 11 回目
    expect(clock.sleep.mock.calls[0]?.[0]).toBeCloseTo(1000 / 10, 5);
  });

  test('同時に呼ばれた acquire() は内部キューで順番に処理され、capacity を超えて即時許可しない', async () => {
    const clock = makeFakeClock();
    const bucket = new TokenBucket({ ratePerSecond: 2, capacity: 2, now: clock.now, sleep: clock.sleep });
    const order: number[] = [];
    await Promise.all(
      [0, 1, 2].map(async (i) => {
        await bucket.acquire();
        order.push(i);
      })
    );
    // 3 並列でも capacity=2 を即座に超えて許可しない（3 番目だけ sleep を経由する）
    expect(clock.sleep).toHaveBeenCalledTimes(1);
    expect(order).toEqual([0, 1, 2]); // FIFO で呼び出し順に完了する
  });

  test('reset() でトークンが満タンに戻る（テスト専用）', async () => {
    const clock = makeFakeClock();
    const bucket = new TokenBucket({ ratePerSecond: 1, now: clock.now, sleep: clock.sleep });
    await bucket.acquire(); // capacity=1 を使い切る
    bucket.reset();
    await bucket.acquire(); // reset 済みなので待たずに通る
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  test('now / sleep 省略時は既定（Date.now / setTimeout）で動作する', async () => {
    jest.useFakeTimers();
    try {
      const bucket = new TokenBucket({ ratePerSecond: 1, capacity: 1 });
      await bucket.acquire(); // 1 回目は即座に通る
      const promise = bucket.acquire(); // 2 回目は待つ
      await Promise.resolve();
      jest.advanceTimersByTime(1000);
      await expect(promise).resolves.toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });
});
