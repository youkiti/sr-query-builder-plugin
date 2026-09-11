import { TokenBucket } from './rateLimit';

test('レート調整は実際に待つ場合だけ通知し、通知の有無・例外で待機を変えない', async () => {
  for (const mode of ['none', 'observe', 'throw']) {
    let now = 0;
    const sleep = jest.fn(async (ms: number) => { now += ms; });
    const limiter = new TokenBucket({ ratePerSecond: 1, capacity: 1, now: () => now, sleep });
    const onWait = jest.fn(() => { if (mode === 'throw') throw new Error('表示失敗'); });
    const callback = mode === 'none' ? undefined : onWait;
    await limiter.acquire(callback);
    expect(onWait).not.toHaveBeenCalled();
    await limiter.acquire(callback);
    expect(sleep.mock.calls).toEqual([[1000]]);
    expect(onWait).toHaveBeenCalledTimes(mode === 'none' ? 0 : 1);
  }
});
