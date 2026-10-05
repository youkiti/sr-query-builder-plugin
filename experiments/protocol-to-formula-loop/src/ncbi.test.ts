/** @jest-environment node */
import { EutilsError } from '../../../src/lib/ncbi/eutils';
import { isQueryRejection, createDeps, ncbiRate, timeoutFetch } from './ncbi';

test('既定・分割したレートを読み、不正値を拒否する', () => {
  expect(ncbiRate({})).toBe(2);
  expect(ncbiRate({ P2F_NCBI_RPS: '0.5' })).toBe(0.5);
  for (const value of ['', ' ', '0', '-1', 'NaN', 'Infinity']) expect(() => ncbiRate({ P2F_NCBI_RPS: value })).toThrow();
});
test('厳密な件数とキーを渡し、日付付きだけ edat にする', async () => {
  const network: typeof fetch = jest.fn(async () => new Response('{}'));
  const call = jest.fn();
  for (const cutoffDate of [undefined, '2020-01-31']) {
    const deps = createDeps({ env: { NCBI_API_KEY: '合成キー', P2F_NCBI_RPS: '0.5' }, fetchImpl: network, cutoffDate, onCall: call });
    expect(deps).toMatchObject({ apiKey: '合成キー', strictCounts: true });
    await deps.rateLimiter!.acquire();
    await deps.fetch('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed');
  }
  const urls = (network as jest.Mock).mock.calls.map(([url]) => new URL(String(url)));
  expect(urls[0]!.searchParams.has('datetype')).toBe(false);
  expect(urls[1]!.searchParams.get('datetype')).toBe('edat');
  expect(call).toHaveBeenCalledTimes(1);
});
test('時間超過で中断し、元の中断シグナルも保持する', async () => {
  jest.useFakeTimers();
  try {
    const network: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
      if (init?.signal?.aborted) reject(new Error('中断'));
      init?.signal?.addEventListener('abort', () => reject(new Error('中断')));
    });
    const pending = timeoutFetch(network, 30_000)('https://example.invalid');
    const assertion = expect(pending).rejects.toThrow('中断');
    await jest.advanceTimersByTimeAsync(30_000);
    await assertion;
    const controller = new AbortController();
    controller.abort();
    await expect(timeoutFetch(network)('https://example.invalid', { signal: controller.signal })).rejects.toThrow('中断');
    expect(jest.getTimerCount()).toBe(0);
  } finally { jest.useRealTimers(); }
});

test('式への恒久的な拒否だけを区別する', () => {
  for (const message of ['構文エラー: 不明なフィールドタグ tiabb', '構文エラー: phrase not found 合成句', 'esearch エラー: 合成拒否', 'esearch in-band エラー']) {
    expect(isQueryRejection(new EutilsError(message, 200, true))).toBe(true);
    expect(isQueryRejection(new EutilsError(message, 200))).toBe(false);
    expect(isQueryRejection(new Error(message))).toBe(false);
  }
  for (const error of [new EutilsError('esearch の件数が欠落しています', 200, true),
    new EutilsError('esearch の PMID 一覧が不正です', 200, true), new EutilsError('HTTP 503', 503),
    new DOMException('制限時間超過', 'TimeoutError'), new Error('一般の例外'), null]) expect(isQueryRejection(error)).toBe(false);
});
test('連続取得の2回目以降は補充を待つ', async () => {
  let now = 0;
  const sleep = jest.fn(async (ms: number) => { now += ms; });
  const deps = createDeps({ env: { P2F_NCBI_RPS: '3' }, fetchImpl: jest.fn(), now: () => now, sleep });
  await deps.rateLimiter!.acquire();
  expect(sleep).not.toHaveBeenCalled();
  await deps.rateLimiter!.acquire();
  expect(now).toBeGreaterThanOrEqual(1000 / 3);
  const second = now;
  await deps.rateLimiter!.acquire();
  expect(now - second).toBeGreaterThanOrEqual(1000 / 3);
  expect(sleep).toHaveBeenCalledTimes(2);
});
