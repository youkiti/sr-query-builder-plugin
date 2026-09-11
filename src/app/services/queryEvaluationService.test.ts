import * as google from '@/lib/google';
import * as lines from '@/features/validation/checkSearchLines';
import * as final from '@/features/validation/checkFinalQuery';
import type { PubmedFormula } from '@/lib/search-formula-md';
import { evaluateQuery } from './queryEvaluationService';

afterEach(() => jest.restoreAllMocks());

function formula(): PubmedFormula {
  return {
    blocks: [
      { id: '1', expression: 'a[tiab]', isCombination: false },
      { id: '2', expression: 'b[tiab]', isCombination: false },
      { id: '3', expression: '#1 AND #2', isCombination: true },
    ],
    combinationExpression: '#1 AND #2',
  };
}

function setup(bodies: unknown[] = []) {
  const fetch = jest.fn().mockImplementation(async () => ({
    ok: true, status: 200,
    json: async () => bodies.length > 0 ? bodies.shift() : { esearchresult: { count: '0', idlist: [] } },
  }));
  const acquire = jest.fn().mockResolvedValue(undefined);
  const now = jest.fn(() => '2026-09-11T12:00:00.000Z');
  const deps = { eutils: { fetch, rateLimiter: { acquire }, maxRetries: 0 }, now };
  return { fetch, acquire, deps };
}

const response = (count: string, idlist: string[] = []) => ({ esearchresult: { count, idlist } });

test('既存の行計測・最終式検証を再利用し、捕捉とブロック件数を保存せず返す', async () => {
  const append = jest.spyOn(google, 'appendRow');
  const upload = jest.spyOn(google, 'uploadTextFile');
  const checkLines = jest.spyOn(lines, 'checkSearchLines');
  const checkFinal = jest.spyOn(final, 'checkFinalQuery');
  const { fetch, acquire, deps } = setup([
    response('12'), response('8'), response('3'), response('3'), response('1', ['11']),
  ]);
  const setState = jest.fn();
  const result = await evaluateQuery(formula(), ['11', '22', '11'], { ...deps, ...{ store: { setState } } });
  expect(result.status).toBe('success');
  expect(result.lineHits.map((line) => line.hitCount)).toEqual([12, 8, 3]);
  expect(result.finalQuery).toMatchObject({
    status: 'success', totalHits: 3, capturedPmids: ['11'], missedPmids: ['22'], captureRate: 0.5,
  });
  expect(result.seedPmids).toEqual(['11', '22']);
  expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(result.measuredAt).toBe('2026-09-11T12:00:00.000Z');
  expect(checkLines).toHaveBeenCalledWith(formula(), expect.objectContaining({ strictCounts: true }));
  expect(checkFinal).toHaveBeenCalledWith(formula(), ['11', '22'], expect.objectContaining({ strictCounts: true }));
  expect(append).not.toHaveBeenCalled();
  expect(upload).not.toHaveBeenCalled();
  expect(setState).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledTimes(5);
  expect(acquire).toHaveBeenCalledTimes(5);
  for (const [url] of fetch.mock.calls) {
    expect(new URL(url as string).hostname).toBe('eutils.ncbi.nlm.nih.gov');
  }
  expect(deps.eutils).not.toHaveProperty('strictCounts');
});

test('実測 0 件と空シードは成功として返し、既定の時刻を使う', async () => {
  const { deps } = setup();
  const result = await evaluateQuery(formula(), [], { eutils: deps.eutils });
  expect(result.status).toBe('success');
  expect(result.lineHits.every((line) => line.status === 'success' && line.hitCount === 0)).toBe(true);
  expect(result.finalQuery).toMatchObject({ totalHits: 0, capturedPmids: [], missedPmids: [] });
  expect(Number.isNaN(Date.parse(result.measuredAt))).toBe(false);
});

test('件数欠落・不正値を null と失敗状態で返し、他行の実測 0 件を維持する', async () => {
  const { deps } = setup([{}, response('0'), response('0'), response('NaN')]);
  const result = await evaluateQuery(formula(), [], deps);
  expect(result.status).toBe('failure');
  expect(result.lineHits[0]).toMatchObject({ status: 'failure', hitCount: null, error: expect.any(String) });
  expect(result.lineHits[1]).toMatchObject({ status: 'success', hitCount: 0 });
  expect(result.finalQuery).toMatchObject({ status: 'failure', totalHits: null, capturedPmids: null, missedPmids: null });
});

test('シード捕捉計測が失敗しても、未捕捉や総件数 0 とは報告しない', async () => {
  const { deps } = setup([response('1'), response('1'), response('1'), response('1'), {}]);
  const result = await evaluateQuery(formula(), ['11'], deps);
  expect(result.finalQuery).toMatchObject({ status: 'failure', totalHits: null, captureRate: null, missedPmids: null });
});

test('一部行だけ失敗した場合も全体を失敗にし、最終式の成功を保持する', async () => {
  const { deps } = setup([{}, response('0'), response('0'), response('0')]);
  const result = await evaluateQuery(formula(), [], deps);
  expect(result.status).toBe('failure');
  expect(result.finalQuery.status).toBe('success');
});

test('文字列として投げられた例外も失敗状態へ変換する', async () => {
  const { deps } = setup();
  deps.eutils.fetch.mockRejectedValue('通信失敗');
  const result = await evaluateQuery(formula(), [], deps);
  expect(result.finalQuery).toMatchObject({ status: 'failure', error: '通信失敗', totalHits: null });
});

test('fingerprint は同じ式で安定し、式の変更で変わり、待機中の入力変更に影響されない', async () => {
  const { deps } = setup();
  const input = formula();
  const seeds = ['11'];
  const pending = evaluateQuery(input, seeds, deps);
  input.blocks[0]!.expression = 'changed[tiab]';
  seeds.push('22');
  const fixed = await pending;
  const same = await evaluateQuery(formula(), ['11'], deps);
  const changed = await evaluateQuery(input, seeds, deps);
  expect(fixed.fingerprint).toBe(same.fingerprint);
  expect(fixed.fingerprint).not.toBe(changed.fingerprint);
  expect(fixed.lineHits[0]!.expression).toBe('a[tiab]');
  expect(fixed.seedPmids).toEqual(['11']);
});
