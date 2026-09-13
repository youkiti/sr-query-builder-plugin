import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { esearch, EutilsError, resolveRateLimiter, shouldRetryEutils, type EutilsDeps } from '../../src/lib/ncbi/eutils';
import { retryWithBackoff } from '../../src/lib/ncbi/rateLimit';
import type { SearchMeasurement } from './types';

// 1,500 字で切り替え、URL の固定部分・日付・エンコードによる膨張に余裕を残す。
// URL 長の保証値ではなく、長い展開式を GET に載せないための保守的な境界。
export const ESEARCH_POST_THRESHOLD = 1500;

async function evalSearch(query: string, deps: EutilsDeps, retmax: number) {
  deps = { ...deps, fetch: trackAttempts(deps.fetch) };
  if (query.length <= ESEARCH_POST_THRESHOLD) return esearch(query, { ...deps, strictCounts: true }, { retmax });
  const params = new URLSearchParams({ db: 'pubmed', term: query, retmode: 'json', retmax: String(retmax), retstart: '0',
    tool: deps.tool ?? 'sr-query-builder-plugin' });
  if (deps.apiKey) params.set('api_key', deps.apiKey);
  if (deps.email) params.set('email', deps.email);
  return retryWithBackoff(async () => {
    await resolveRateLimiter(deps).acquire();
    const response = await deps.fetch('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString(),
    });
    if (!response.ok) throw new EutilsError(`esearch HTTP ${response.status}`, response.status);
    const body = await response.json() as { error?: unknown; ERROR?: unknown; esearchresult?: {
      count?: unknown; idlist?: unknown; ERROR?: unknown; errorlist?: Record<string, unknown>;
    } };
    const result = body.esearchresult;
    if (body.error) throw new EutilsError('esearch API エラー', response.status);
    if (body.ERROR || result?.ERROR || Object.values(result?.errorlist ?? {}).some((value) =>
      Array.isArray(value) ? value.length > 0 : Boolean(value))) throw new EutilsError('esearch in-band エラー', response.status, true);
    if (typeof result?.count !== 'string' || !/^\d+$/.test(result.count) || !Number.isSafeInteger(Number(result.count))) {
      throw new EutilsError('esearch の件数が欠落しているか、不正な値です', response.status, true);
    }
    const count = Number(result.count);
    const ids = result.idlist;
    if (retmax > 0 && (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !/^[1-9]\d*$/.test(id))
      || new Set(ids).size !== Math.min(retmax, count) || ids.length !== Math.min(retmax, count))) {
      throw new EutilsError('esearch の PMID 一覧が欠落しているか、件数と一致しません', response.status, true);
    }
    return { count, pmids: (Array.isArray(ids) ? ids : []) as string[] };
  }, { sleep: deps.sleep, maxRetries: deps.maxRetries ?? 5, shouldRetry: shouldRetryEutils });
}

export function redact(text: string, secrets: readonly string[] = []): string {
  let safe = text;
  for (const secret of secrets.filter(Boolean)) {
    safe = safe.split(secret).join('[REDACTED]').split(encodeURIComponent(secret)).join('[REDACTED]');
  }
  return safe.replace(/([?&](?:api_key|key)=)[^&\s"'<>\\]*/gi, '$1[REDACTED]');
}

export interface ApiEvent {
  url: string;
  startedAt: string;
  method: string;
  /** 初回は 1。呼び出し単位を観測できない製品内部の再送は null。 */
  attempt: number | null;
  requestId: string | null;
  status: number | null;
  elapsedMs: number;
  error?: string;
}

const attempts = new AsyncLocalStorage<{ attempt: number; requestId: string }>();

/** 検索 1 回の fetch を数える。同一クエリの並行実行や日付ラッパの入れ子でも混同しない。 */
function trackAttempts(fetchImpl: typeof fetch): typeof fetch {
  let attempt = 0;
  const requestId = randomUUID();
  return (input, init) => attempts.run({ attempt: ++attempt, requestId }, () => fetchImpl(input, init));
}

export interface LimiterEvent {
  at: string;
  waitedMs: number;
  bucket: 'withApiKey' | 'withoutApiKey';
}

/** 既定の共有インスタンスを包む。待機と後続 fetch の対応は推測しない。 */
export function observeRateLimiter(deps: Omit<EutilsDeps, 'rateLimiter'>,
  onWait: (event: LimiterEvent) => void): NonNullable<EutilsDeps['rateLimiter']> {
  if ('rateLimiter' in deps && deps.rateLimiter !== undefined) {
    throw new Error('rateLimiter が既に設定されています。計測対象は既定の共有バケットに限ります');
  }
  const shared = resolveRateLimiter(deps);
  const bucket = deps.apiKey ? 'withApiKey' : 'withoutApiKey';
  return { acquire: async (onWaitCallback) => {
    const start = Date.now();
    await shared.acquire(onWaitCallback);
    onWait({ at: new Date().toISOString(), waitedMs: Date.now() - start, bucket });
  } };
}

export function createEvalFetch(searchDate: string, fetchImpl: typeof fetch, onCall: (event: ApiEvent) => void,
  secrets: readonly string[] = []): typeof fetch {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(searchDate) || !Number.isFinite(Date.parse(searchDate))) throw new Error('検索日が不正です');
  return async (input, init) => {
    const request = typeof Request !== 'undefined' && input instanceof Request ? input : null;
    const url = new URL(request ? request.url : String(input));
    let options = init;
    const isSearch = url.hostname === 'eutils.ncbi.nlm.nih.gov' && url.pathname.endsWith('/esearch.fcgi');
    if (isSearch) {
      const isPost = (init?.method ?? request?.method ?? 'GET').toUpperCase() === 'POST';
      const body = isPost ? init?.body ?? (request ? await request.clone().text() : '') : null;
      if (body !== null && typeof body !== 'string' && !(body instanceof URLSearchParams)) throw new Error('ESearch の本文形式が不正です');
      const params = body === null ? url.searchParams : new URLSearchParams(String(body));
      if ((params.get('db') ?? url.searchParams.get('db')) === 'pubmed') {
        params.set('datetype', 'crdt');
        params.set('mindate', '1800/01/01');
        params.set('maxdate', searchDate.replace(/-/g, '/'));
        if (isPost) options = { ...init, body: params.toString() };
      }
    }
    const start = Date.now();
    let status: number | null = null;
    let error: string | undefined;
    try {
      const response = await fetchImpl(request ? new Request(url, request) : url.toString(), options);
      status = response.status;
      return response;
    } catch (err) {
      error = redact(err instanceof Error ? err.message : String(err), secrets);
      throw new Error(error);
    } finally {
      onCall({ url: redact(url.toString(), secrets), startedAt: new Date(start).toISOString(),
        method: (init?.method ?? request?.method ?? 'GET').toUpperCase(),
        attempt: attempts.getStore()?.attempt ?? null, requestId: attempts.getStore()?.requestId ?? null,
        status, elapsedMs: Date.now() - start, ...(error ? { error } : {}) });
    }
  };
}

/** gold との積集合を分割取得する。総 hits が PubMed の取得上限を超えても捕捉 PMID は全件取得できる。 */
export async function capturedGold(query: string, goldPmids: readonly string[], deps: EutilsDeps): Promise<string[]> {
  const pmids = [...new Set(goldPmids)];
  if (pmids.some((pmid) => !/^[1-9]\d*$/.test(pmid))) throw new Error('gold PMID が不正です');
  const captured: string[] = [];
  for (let offset = 0; offset < pmids.length; offset += 100) {
    const chunk = pmids.slice(offset, offset + 100);
    const term = chunk.map((pmid) => `${pmid}[uid]`).join(' OR ');
    const result = await evalSearch(query ? `(${query}) AND (${term})` : `(${term})`, deps, chunk.length);
    const unique = [...new Set(result.pmids)];
    if (unique.length !== result.count || unique.some((pmid) => !chunk.includes(pmid))) {
      throw new Error('捕捉 PMID が欠落しているか、要求した gold と一致しません');
    }
    captured.push(...unique);
  }
  return captured;
}

export async function evaluateSearch(query: string, goldPmids: readonly string[], deps: EutilsDeps): Promise<SearchMeasurement> {
  try {
    if (!query.trim()) throw new Error('検索式が空です');
    const { count: hits } = await evalSearch(query, deps, 0);
    const capturedPmids = hits === 0 ? [] : await capturedGold(query, goldPmids, deps);
    if (capturedPmids.length > hits) throw new Error('捕捉数が総件数を超えています');
    return { status: 'success', hits, capturedPmids };
  } catch (err) {
    return { status: 'failure', error: redact(err instanceof Error ? err.message : String(err), [deps.apiKey ?? '']) };
  }
}

export async function seedTitles(pmids: readonly string[], deps: EutilsDeps): Promise<{ pmid: string; title: string | null }[]> {
  deps = { ...deps, fetch: trackAttempts(deps.fetch) };
  const params = new URLSearchParams({ db: 'pubmed', id: pmids.join(','), retmode: 'json' });
  if (deps.apiKey) params.set('api_key', deps.apiKey);
  await resolveRateLimiter(deps).acquire();
  const response = await deps.fetch(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?${params}`);
  if (!response.ok) throw new Error(`esummary HTTP ${response.status}`);
  const json = await response.json() as { error?: string; result?: Record<string, { title?: string; error?: string }> };
  if (json.error) throw new Error('esummary API エラー');
  return pmids.map((pmid) => {
    const record = json.result?.[pmid];
    if (!record || record.error || typeof record.title !== 'string') throw new Error(`シード ${pmid} のタイトル取得に失敗しました`);
    return { pmid, title: record.title };
  });
}
