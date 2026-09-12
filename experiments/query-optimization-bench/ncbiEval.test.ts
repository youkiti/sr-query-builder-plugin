/** @jest-environment node */
import { capturedGold, createEvalFetch, evaluateSearch, redact, seedTitles } from './ncbiEval';
import type { EutilsDeps } from '../../src/lib/ncbi/eutils';

const response = (count: number, idlist: string[] = []) => new Response(JSON.stringify({ esearchresult: { count: String(count), idlist } }));
const deps = (fetch: typeof globalThis.fetch): EutilsDeps => ({ fetch, maxRetries: 0, rateLimiter: { acquire: async () => undefined } });

test('PubMed esearch だけに日付を付け、ログのキーをマスクする', async () => {
  const fetch = jest.fn().mockResolvedValue(response(0));
  const log = jest.fn();
  const wrapped = createEvalFetch('2021-04-15', fetch, log);
  await wrapped('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&api_key=FAKE');
  const url = new URL(fetch.mock.calls[0]![0] as string);
  expect(Object.fromEntries(url.searchParams)).toMatchObject({ datetype: 'crdt', mindate: '1800/01/01', maxdate: '2021/04/15' });
  expect(log.mock.calls[0]![0].url).not.toContain('FAKE');
  for (const url of ['https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=mesh', 'https://id.nlm.nih.gov/mesh/sparql?query=x', 'https://generativelanguage.googleapis.com/model?key=FAKE']) await wrapped(url);
  expect(fetch.mock.calls.slice(1).every(([url]) => !String(url).includes('maxdate'))).toBe(true);
  expect(JSON.stringify(log.mock.calls)).not.toContain('FAKE');
});
test('Request と POST の本文も日付制約を保持する', async () => {
  const fetch = jest.fn().mockResolvedValue(response(0));
  const wrapped = createEvalFetch('2021-04-15', fetch, () => undefined);
  await wrapped(new Request('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi', { method: 'POST', body: 'db=pubmed&term=test' }));
  expect(new URLSearchParams(fetch.mock.calls[0]![1].body).get('maxdate')).toBe('2021/04/15');
});
test('HTTP 失敗と例外を数え、例外のキーも残さない', async () => {
  const log = jest.fn();
  const wrapped = createEvalFetch('2021-04-15', jest.fn().mockRejectedValue(new Error('url?key=FAKE')), log);
  await expect(wrapped('https://example.org')).rejects.toThrow('[REDACTED]');
  expect(log).toHaveBeenCalledWith(expect.objectContaining({ status: null, elapsedMs: expect.any(Number) }));
  expect(redact('x?key=FAKE&api_key=OTHER')).toBe('x?key=[REDACTED]&api_key=[REDACTED]');
});
test('20 件を超える gold を明示 retmax で全件取得し総 hits は独立に数える', async () => {
  const ids = Array.from({ length: 32 }, (_, i) => String(i + 1));
  const fetch = jest.fn().mockResolvedValueOnce(response(50000)).mockResolvedValueOnce(response(32, ids));
  expect(await evaluateSearch('test', ids, deps(fetch))).toEqual({ status: 'success', hits: 50000, capturedPmids: ids });
  expect(new URL(fetch.mock.calls[1]![0]).searchParams.get('retmax')).toBe('32');
});
test('0 件・捕捉 0 件・API 失敗と部分取得を区別する', async () => {
  expect(await evaluateSearch('test', ['1'], deps(jest.fn().mockResolvedValue(response(0))))).toEqual({ status: 'success', hits: 0, capturedPmids: [] });
  expect(await evaluateSearch('test', ['1'], deps(jest.fn().mockResolvedValueOnce(response(10)).mockResolvedValueOnce(response(0))))).toEqual({ status: 'success', hits: 10, capturedPmids: [] });
  expect((await evaluateSearch('test', ['1'], deps(jest.fn().mockResolvedValue(new Response('', { status: 500 }))))).status).toBe('failure');
  await expect(capturedGold('', ['1', '2'], deps(jest.fn().mockResolvedValue(response(2, ['1']))))).rejects.toThrow('欠落');
});
test('esummary JSON からシードタイトルを取り、欠落時に失敗する', async () => {
  expect(await seedTitles(['1'], deps(jest.fn().mockResolvedValue(new Response(JSON.stringify({ result: { '1': { title: 'Title' } } })))))).toEqual([{ pmid: '1', title: 'Title' }]);
  await expect(seedTitles(['1'], deps(jest.fn().mockResolvedValue(new Response('{}'))))).rejects.toThrow();
});

test('long terms use POST for counts and capture, share the limiter and carry dates in the body', async () => {
  const query = 'x'.repeat(1501);
  const fetch = jest.fn().mockResolvedValueOnce(response(10)).mockResolvedValueOnce(response(1, ['1']));
  const acquire = jest.fn().mockResolvedValue(undefined);
  const wrapped = createEvalFetch('2021-04-15', fetch, () => undefined);
  expect(await evaluateSearch(query, ['1'], { ...deps(wrapped), rateLimiter: { acquire } })).toEqual({ status: 'success', hits: 10, capturedPmids: ['1'] });
  expect(acquire).toHaveBeenCalledTimes(2);
  for (const [url, init] of fetch.mock.calls) {
    expect(String(url)).not.toContain('?');
    expect(init.method).toBe('POST');
    expect(Object.fromEntries(new URLSearchParams(init.body))).toMatchObject({ db: 'pubmed', datetype: 'crdt', mindate: '1800/01/01', maxdate: '2021/04/15' });
  }
  const get = jest.fn().mockResolvedValue(response(0));
  await evaluateSearch('x'.repeat(1500), [], deps(get));
  expect(get.mock.calls[0]![1]).toBeUndefined();
});

test.each([
  { ERROR: 'bad query' }, { error: 'rate limited' },
  { esearchresult: { ERROR: 'bad query', count: '0' } },
  { esearchresult: { count: '0', errorlist: { fieldsnotfound: ['bad'] } } },
  { esearchresult: { count: '0', errorlist: { phrasesnotfound: ['bad'] } } },
  { esearchresult: { count: '2oops' } }, { esearchresult: { count: '-1' } },
  { esearchresult: { count: '9007199254740992' } }, {},
])('POST does not turn errors or invalid counts into zero: %j', async (body) => {
  expect((await evaluateSearch('x'.repeat(1501), [], deps(jest.fn().mockResolvedValue(new Response(JSON.stringify(body)))))).status).toBe('failure');
});

test.each([undefined, ['1'], ['1', '1'], ['01', '2'], ['1', '3']])('POST rejects missing, inconsistent or foreign gold IDs: %j', async (idlist) => {
  const fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({ esearchresult: { count: '2', idlist } })));
  await expect(capturedGold('x'.repeat(1501), ['1', '2'], deps(fetch))).rejects.toThrow();
});


test.each([500, 'rate-limit'])('POST retries transient failures with backoff: %s', async (failure) => {
  const fetch = jest.fn()
    .mockResolvedValueOnce(typeof failure === 'number' ? new Response('', { status: failure })
      : new Response(JSON.stringify({ error: 'API rate limit exceeded' })))
    .mockResolvedValueOnce(new Response('', { status: 500 }))
    .mockResolvedValueOnce(response(0));
  const sleep = jest.fn().mockResolvedValue(undefined);
  const acquire = jest.fn().mockResolvedValue(undefined);
  expect(await evaluateSearch('x'.repeat(1501), [], { ...deps(fetch), maxRetries: 2, sleep, rateLimiter: { acquire } }))
    .toEqual({ status: 'success', hits: 0, capturedPmids: [] });
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(acquire).toHaveBeenCalledTimes(3);
  expect(sleep.mock.calls).toEqual([[1000], [2000]]);
});

test.each([
  { ERROR: 'bad query', count: '0' },
  { count: '0', errorlist: { fieldsnotfound: ['bad'] } },
  { count: '0', errorlist: { phrasesnotfound: ['bad'] } },
  { count: 'invalid' },
])('POST does not retry permanent errors: %j', async (esearchresult) => {
  const fetch = jest.fn().mockImplementation(async () => new Response(JSON.stringify({ esearchresult })));
  const sleep = jest.fn().mockResolvedValue(undefined);
  expect((await evaluateSearch('x'.repeat(1501), [], { ...deps(fetch), maxRetries: 3, sleep })).status).toBe('failure');
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(sleep).not.toHaveBeenCalled();
});
