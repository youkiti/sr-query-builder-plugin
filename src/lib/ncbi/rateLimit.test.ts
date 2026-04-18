import { exponentialBackoff, retryWithBackoff } from './rateLimit';

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
