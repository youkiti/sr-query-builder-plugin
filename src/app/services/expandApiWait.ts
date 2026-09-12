import { EUTILS_DEFAULT_MAX_RETRIES, resolveRateLimiter, type EutilsDeps } from '@/lib/ncbi';
import type { ExpandApiWait } from '../store';

/**
 * NCBI 通信のレート制御待ちと自動リトライ待ちを画面へ通知する `EutilsDeps` を作る（issue #109）。
 *
 * 429 は既定で最大 5 回・合計 31 秒待つため、通知が無いと画面は「取得中…」のまま動かず、
 * 待っているのか固まったのか区別できない。`queryOptimizationService` が `#/draft` で
 * 使っているのと同じ手口（rateLimiter と sleep を包む）で、リトライ回数も変えない。
 *
 * 試行回数は sleep の呼び出し回数から数える。`retryWithBackoff` は 1 回の論理呼び出しの
 * 内側でしかリトライしないので、**応答が ok だった時点で数え直す**ことで次の esearch /
 * efetch と混ざらないようにする（HTTP 200 の in-band エラーは ok のまま再試行されるため、
 * その経路だけ「1 回目」に戻って見えることがある）。
 */
export function withExpandApiWait(
  base: EutilsDeps,
  setApiWait: (wait: ExpandApiWait | null) => void
): EutilsDeps {
  const maxAttempts = (base.maxRetries ?? EUTILS_DEFAULT_MAX_RETRIES) + 1;
  const rateLimiter = resolveRateLimiter(base);
  let attempt = 1;
  return {
    ...base,
    rateLimiter: {
      acquire: async () => {
        await rateLimiter.acquire(() =>
          setApiWait({
            source: 'PubMed',
            kind: 'rate_limit',
            attempt: null,
            maxAttempts: null,
            waitMs: null,
          })
        );
        setApiWait(null);
      },
    },
    sleep: async (ms) => {
      attempt += 1;
      setApiWait({ source: 'PubMed', kind: 'retry', attempt, maxAttempts, waitMs: ms });
      await (base.sleep ? base.sleep(ms) : new Promise<void>((r) => setTimeout(r, ms)));
      setApiWait(null);
    },
    fetch: async (resource, init) => {
      const response = await base.fetch(resource, init);
      if (response.ok) attempt = 1;
      return response;
    },
  };
}

