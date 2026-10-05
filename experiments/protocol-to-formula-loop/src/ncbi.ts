import { EutilsError, type EutilsDeps } from '../../../src/lib/ncbi/eutils';
import { TokenBucket } from '../../../src/lib/ncbi/rateLimit';
import { createEvalFetch, type ApiEvent } from '../../query-optimization-bench/ncbiEval';

export function isQueryRejection(error: unknown): boolean {
  return error instanceof EutilsError && error.permanent && (error.message.startsWith('構文エラー')
    || error.message.startsWith('esearch エラー:') || error.message === 'esearch in-band エラー');
}

export const REQUEST_TIMEOUT_MS = 30_000;
export function ncbiRate(env: NodeJS.ProcessEnv): number {
  const rate = env.P2F_NCBI_RPS === undefined ? 2 : Number(env.P2F_NCBI_RPS);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error('P2F_NCBI_RPS は正の有限数が必要です');
  return rate;
}

export function timeoutFetch(fetchImpl: typeof fetch, timeoutMs = REQUEST_TIMEOUT_MS): typeof fetch {
  return async (input, init) => {
    const controller = new AbortController();
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    try {
      const response = await fetchImpl(input, { ...init, signal: controller.signal });
      // 本文の受信までをリクエストの制限時間に含める。
      const body = await response.arrayBuffer();
      return new Response(body.byteLength ? body : null, { status: response.status, statusText: response.statusText, headers: response.headers });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  };
}

export interface DepsOptions {
  env: NodeJS.ProcessEnv; fetchImpl: typeof fetch; cutoffDate?: string; onCall?: (event: ApiEvent) => void;
  sleep?: EutilsDeps['sleep']; timeoutMs?: number; now?: () => number;
}
export function createDeps({ env, fetchImpl, cutoffDate, onCall = () => undefined, sleep, timeoutMs, now }: DepsOptions): EutilsDeps {
  const apiKey = env.NCBI_API_KEY;
  const rate = ncbiRate(env);
  const limited = timeoutFetch(fetchImpl, timeoutMs);
  return { apiKey, strictCounts: true, sleep,
    rateLimiter: new TokenBucket({ ratePerSecond: rate, capacity: 1, sleep, now }),
    fetch: cutoffDate ? createEvalFetch(cutoffDate, limited, onCall, [apiKey ?? ''], 'edat') : limited };
}
