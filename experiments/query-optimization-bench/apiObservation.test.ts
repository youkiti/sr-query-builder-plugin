/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { esearch, resolveRateLimiter, sharedEutilsRateLimiters } from '../../src/lib/ncbi/eutils';
import { createEvalFetch, evaluateSearch, observeRateLimiter, redact, seedTitles, type ApiEvent, type LimiterEvent } from './ncbiEval';

const empty = () => new Response(JSON.stringify({ esearchresult: { count: '0', idlist: [] } }));
const noWait = { acquire: async () => undefined };

afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

test('既存のリミッタや計測ラッパを持つ deps は取得前に拒否する', () => {
  const fetch = jest.fn();
  const onWait = jest.fn();
  const acquire = jest.fn();
  const wrapped = observeRateLimiter({ fetch }, onWait);
  for (const rateLimiter of [{ acquire }, wrapped]) {
    const deps = { fetch, rateLimiter };
    expect(() => observeRateLimiter(deps, onWait)).toThrow('rateLimiter が既に設定されています');
  }
  expect(acquire).not.toHaveBeenCalled();
  expect(onWait).not.toHaveBeenCalled();
});

test.each([false, true])('計測ラッパと通常経路は既存の同じバケットを消費する（キーあり=%s）', async (hasKey) => {
  sharedEutilsRateLimiters.withApiKey.reset();
  sharedEutilsRateLimiters.withoutApiKey.reset();
  const deps = { fetch: jest.fn(), apiKey: hasKey ? randomUUID() : undefined };
  const shared = hasKey ? sharedEutilsRateLimiters.withApiKey : sharedEutilsRateLimiters.withoutApiKey;
  expect(resolveRateLimiter(deps)).toBe(shared);
  const acquire = jest.spyOn(shared, 'acquire').mockImplementation(async (onWait) => { onWait?.(); });
  jest.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValueOnce(1040)
    .mockReturnValueOnce(1100).mockReturnValueOnce(1175);
  const waits: LimiterEvent[] = [];
  const wrapper = observeRateLimiter(deps, (event) => waits.push(event));
  const onWait = jest.fn();
  await wrapper.acquire();
  await resolveRateLimiter(deps).acquire();
  await wrapper.acquire(onWait);
  expect(acquire).toHaveBeenCalledTimes(3);
  expect(onWait).toHaveBeenCalled();
  expect(waits).toHaveLength(2);
  expect(waits[0]).toMatchObject({ waitedMs: 40, bucket: hasKey ? 'withApiKey' : 'withoutApiKey' });
  expect(waits[1]!.waitedMs).toBe(75);
  expect(JSON.stringify(waits)).not.toContain(deps.apiKey ?? 'api_key');
});

test.each(['short', 'x'.repeat(1501)])('GET/POST の再送を検索単位で数え、送信直前の時刻を残す: %.5s', async (query) => {
  const events: ApiEvent[] = [];
  const starts: string[] = [];
  let call = 0;
  const network: typeof fetch = async () => {
    starts.push(new Date().toISOString());
    return ++call === 1 ? new Response('', { status: 429 }) : empty();
  };
  const observed = createEvalFetch('2021-04-15', network, (event) => events.push(event));
  const deps = { fetch: observed, maxRetries: 1, sleep: async () => undefined, rateLimiter: noWait };
  await evaluateSearch(query, [], deps);
  await evaluateSearch(query, [], deps);
  expect(events.map((event) => event.attempt)).toEqual([1, 2, 1]);
  expect(events.map((event) => event.status)).toEqual([429, 200, 200]);
  expect(events[0]!.requestId).toBe(events[1]!.requestId);
  expect(events[2]!.requestId).not.toBe(events[1]!.requestId);
  expect(events.every((event) => event.method === (query.length > 1500 ? 'POST' : 'GET'))).toBe(true);
  events.forEach((event, index) => expect(Math.abs(Date.parse(event.startedAt) - Date.parse(starts[index]!))).toBeLessThan(10));
});

test('同一検索の並行呼び出しと日付ラッパの入れ子で試行番号が混ざらない', async () => {
  const events: ApiEvent[] = [];
  let call = 0;
  const network: typeof fetch = async () => ++call <= 2 ? new Response('', { status: 429 }) : empty();
  const observed = createEvalFetch('2021-04-15', network, (event) => events.push(event));
  const nested = createEvalFetch('2021-04-15', observed, () => undefined);
  const deps = { fetch: nested, maxRetries: 1, sleep: async () => undefined, rateLimiter: noWait };
  await Promise.all([evaluateSearch('same', [], deps), evaluateSearch('same', [], deps)]);
  const ids = [...new Set(events.map((event) => event.requestId))];
  expect(ids).toHaveLength(2);
  for (const id of ids) expect(events.filter((event) => event.requestId === id).map((event) => event.attempt)).toEqual([1, 2]);
});

test('esummary は試行 1、観測境界外の製品内部呼び出しは不明として記録する', async () => {
  const events: ApiEvent[] = [];
  const observed = createEvalFetch('2021-04-15', jest.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ result: { '1': { title: '題名' } } })))
    .mockResolvedValueOnce(empty()), (event) => events.push(event));
  const deps = { fetch: observed, rateLimiter: noWait };
  await seedTitles(['1'], deps);
  await esearch('query', deps, { retmax: 0 });
  expect(events.map((event) => event.attempt)).toEqual([1, null]);
});

test('API キーの平文とエンコード値を URL・例外・進捗 JSON に残さない', async () => {
  const secret = randomUUID() + '/+';
  const events: ApiEvent[] = [];
  const network = jest.fn().mockRejectedValue(new Error(`通信例外 ${secret} ${encodeURIComponent(secret)}`));
  const observed = createEvalFetch('2021-04-15', network, (event) => events.push(event), [secret]);
  const deps = { fetch: observed, apiKey: secret, rateLimiter: noWait, maxRetries: 0 };
  await evaluateSearch('query', [], deps);
  await evaluateSearch('x'.repeat(1501), [], deps);
  const serialized = events.map((event) => redact(JSON.stringify({ at: new Date().toISOString(), event: { api: 'ncbi', ...event } }), [secret])).join('\n');
  expect(serialized.includes(secret)).toBe(false);
  expect(serialized.includes(encodeURIComponent(secret))).toBe(false);
  expect(events.every((event) => event.status === null && event.error?.includes('[REDACTED]'))).toBe(true);
});

test('fetch の応答待ちを elapsedMs に残し startedAt は完了時刻から独立する', async () => {
  jest.useFakeTimers({ now: Date.UTC(2026, 8, 13) });
  const log = jest.fn();
  const observed = createEvalFetch('2021-04-15', async () => {
    jest.advanceTimersByTime(75);
    return empty();
  }, log);
  await observed('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed');
  expect(log).toHaveBeenCalledWith(expect.objectContaining({ startedAt: '2026-09-13T00:00:00.000Z', elapsedMs: 75 }));
});
