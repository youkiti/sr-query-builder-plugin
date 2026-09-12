import type { ExpandApiWait } from '../store';
import { withExpandApiWait } from './expandApiWait';

function okResponse(): Response {
  return { ok: true, status: 200 } as Response;
}

function errorResponse(status: number): Response {
  return { ok: false, status } as Response;
}

function setup(overrides: Parameters<typeof withExpandApiWait>[0] | null = null) {
  const waits: (ExpandApiWait | null)[] = [];
  let waitOnAcquire = false;
  const acquired: (undefined | (() => void))[] = [];
  const fetchMock = jest.fn().mockResolvedValue(okResponse());
  const sleepMock = jest.fn().mockResolvedValue(undefined);
  const base = {
    fetch: fetchMock as unknown as typeof fetch,
    sleep: sleepMock,
    rateLimiter: {
      acquire: async (onWait?: () => void) => {
        acquired.push(onWait);
        // TokenBucket は「実際に待つときだけ」onWait を呼ぶ。その分岐を再現する。
        if (waitOnAcquire) onWait?.();
      },
    },
    ...(overrides ?? {}),
  };
  const deps = withExpandApiWait(base, (wait) => waits.push(wait));
  return {
    deps, waits, acquired, fetchMock, sleepMock,
    setWaitOnAcquire: (value: boolean) => { waitOnAcquire = value; },
  };
}

describe('withExpandApiWait', () => {
  test('レート制御の待機は 429 と区別できる形で通知し、待ち終わりに解除する', async () => {
    const { deps, waits, setWaitOnAcquire } = setup();
    setWaitOnAcquire(true);
    await deps.rateLimiter!.acquire();
    expect(waits).toEqual([
      { source: 'PubMed', kind: 'rate_limit', attempt: null, maxAttempts: null, waitMs: null },
      null,
    ]);
  });

  test('枠が空いていて待たないときは通知せず、解除だけ流す', async () => {
    const { deps, waits } = setup();
    await deps.rateLimiter!.acquire();
    expect(waits).toEqual([null]);
  });

  test('バックオフ待機は待ち時間と「何回目の試行を待っているか」を通知する', async () => {
    const { deps, waits, sleepMock } = setup();
    await deps.sleep!(1000);
    await deps.sleep!(2000);
    expect(sleepMock).toHaveBeenNthCalledWith(1, 1000);
    expect(waits[0]).toEqual({
      source: 'PubMed', kind: 'retry', attempt: 2, maxAttempts: 6, waitMs: 1000,
    });
    expect(waits[2]).toEqual({
      source: 'PubMed', kind: 'retry', attempt: 3, maxAttempts: 6, waitMs: 2000,
    });
    expect(waits[1]).toBeNull();
  });

  test('maxRetries の指定を総試行回数へ反映する', async () => {
    const { deps, waits } = setup({ fetch: jest.fn() as unknown as typeof fetch, maxRetries: 2 });
    await deps.sleep!(1000);
    expect(waits[0]).toMatchObject({ attempt: 2, maxAttempts: 3 });
  });

  test('応答が返った時点で試行回数を数え直し、次の呼び出しと混ぜない', async () => {
    const { deps, waits, fetchMock } = setup();
    fetchMock.mockResolvedValueOnce(errorResponse(429));
    await deps.fetch('u1'); // 1 回目の呼び出し、429
    await deps.sleep!(1000); // 2 回目の試行を待つ
    await deps.fetch('u1'); // 成功 → ここで数え直す
    await deps.fetch('u2'); // 別の呼び出し
    await deps.sleep!(1000);
    expect(waits[0]).toMatchObject({ attempt: 2 });
    expect(waits[2]).toMatchObject({ attempt: 2 });
  });

  test('sleep 未注入でも待機し、リトライ回数は変えない', async () => {
    const { deps, waits } = setup({ fetch: jest.fn() as unknown as typeof fetch, sleep: undefined });
    await deps.sleep!(1);
    expect(waits).toEqual([
      { source: 'PubMed', kind: 'retry', attempt: 2, maxAttempts: 6, waitMs: 1 },
      null,
    ]);
  });

  test('fetch の戻り値をそのまま渡し、呼び出しを増やさない', async () => {
    const { deps, fetchMock } = setup();
    const response = await deps.fetch('u');
    expect(response.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
