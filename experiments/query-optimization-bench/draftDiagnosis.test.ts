/** @jest-environment node */
import { esearch, EutilsError, type EutilsDeps } from '../../src/lib/ncbi/eutils';
import { LlmProviderError } from '../../src/lib/llm';
import { diagnoseFormula, diagnosticOutcome, generationOutcome, FetchFailure, lookupMesh, meshTerm, parseSyntaxMessage } from './draftDiagnosis';

const response = (body: unknown): Response => new Response(JSON.stringify(body));
const deps = (body: unknown): EutilsDeps => ({ fetch: jest.fn(async () => response(body)), maxRetries: 0, rateLimiter: { acquire: async () => undefined } });
const formula = { blocks: [{ id: '1', expression: '"Missing Term"[Mesh]', isCombination: false }], combinationExpression: '#1' };

test.each([
  { phrasesnotfound: ['Missing Term', 'Other, Term', '"Quoted"[Mesh]'] },
  { fieldsnotfound: ['tiabb', 'unknown'] },
])('製品 esearch の実メッセージを解析する: %j', async (errorlist) => {
  let error: unknown;
  try { await esearch('query', deps({ esearchresult: { count: '0', errorlist } }), { retmax: 0 }); }
  catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(EutilsError);
  expect(parseSyntaxMessage((error as Error).message)).toEqual({ phrasesNotFound: errorlist.phrasesnotfound ?? [], fieldsNotFound: errorlist.fieldsnotfound ?? [] });
});

test.each(['Mesh', 'MeSH Terms', 'mh', 'Majr', 'MeSH Major Topic', 'mEsH:NoExp'])('タグの有無とサブヘディングを照合: %s', (tag) => {
  const expression = `other[tiab] OR "Missing Term/drug therapy"[${tag}]`;
  expect(meshTerm('Missing Term', expression)).toBe('Missing Term');
  expect(meshTerm(`"Missing Term/drug therapy"[${tag}]`, expression)).toBe('Missing Term');
  expect(meshTerm('other', expression)).toBeNull();
});

test.each([[0, 'unresolved'], [1, 'resolved'], [2, 'ambiguous'], [10, 'ambiguous']] as const)('辞書件数 %i は %s', async (count, status) => {
  const input = deps({ esearchresult: { count: String(count), idlist: [] } });
  expect((await lookupMesh('Missing Term', formula.blocks[0]!.expression, input)).status).toBe(status);
  const url = new URL(jest.mocked(input.fetch).mock.calls[0]![0] as string);
  expect(url.searchParams.get('db')).toBe('mesh');
  expect(url.searchParams.get('term')).toBe('"Missing Term"[mh]');
  expect(url.searchParams.get('retmax')).toBe('2');
});

test.each([
  ['Wounds and Injuries', 'x[tiab] OR "Wounds and Injuries"[Mesh]'],
  ['Wounds and Injuries', 'x[tiab] OR Wounds and Injuries[Mesh]'],
  ['Neoplasms', 'cancer[tiab] OR Neoplasms[Mesh]'],
  ['Wounds AND Injuries', 'x[tiab] OR "Wounds AND Injuries"[Mesh]'],
  ['and or not', 'x[tiab] OR and or not[Mesh]'],
])('MeSH 語内の演算子を保持する: %s', (term, expression) => {
  expect(meshTerm(term, expression)).toBe(term);
});

test('非 MeSH と照会失敗を区別し、照会も再送ごとに共有枠を通る', async () => {
  const input = deps({});
  input.fetch = jest.fn().mockRejectedValue(new Error('通信断'));
  input.rateLimiter!.acquire = jest.fn(async () => undefined);
  input.maxRetries = 1;
  input.sleep = jest.fn(async () => undefined);
  expect((await lookupMesh('Missing Term', '"Missing Term"[tiab]', input)).status).toBe('not_mesh');
  expect(input.fetch).not.toHaveBeenCalled();
  expect((await lookupMesh('Missing Term', formula.blocks[0]!.expression, input)).status).toBe('lookup_failed');
  expect(input.rateLimiter!.acquire).toHaveBeenCalledTimes(2);
  expect(input.sleep).toHaveBeenCalledWith(1000);
});

test.each([
  [new LlmProviderError('混雑', 'gemini', 429, ''), 'generation_transient'],
  [new LlmProviderError('障害', 'gemini', 501, ''), 'generation_transient'],
  [new FetchFailure('通信断'), 'generation_transient'],
  [new LlmProviderError('不正', 'gemini', 400, ''), 'generation_failed'],
  [new Error('パース失敗'), 'generation_failed'],
])('生成例外を分類する: %s', (error, outcome) => { expect(generationOutcome(error)).toBe(outcome); });

test.each([
  [deps({ esearchresult: { count: '2' } }), 'ok'],
  [deps({ esearchresult: { count: '0' } }), 'zero'],
  [deps({ esearchresult: {} }), 'other_error'],
  [deps({ esearchresult: { errorlist: { phrasesnotfound: ['Missing Term'] } } }), 'syntax_error'],
  [{ ...deps({}), fetch: jest.fn().mockRejectedValue(new FetchFailure('通信断')) }, 'network_error'],
] as const)('診断で到達する結論: %s', async (input, outcome) => {
  const result = await diagnoseFormula(formula, input);
  expect(diagnosticOutcome(result.diagnostics)).toBe(outcome);
  expect(result.diagnostics.map((item) => item.target)).toEqual(['block', 'formula']);
});

test('ネットワーク、構文、ゼロの優先順とその他のエラーを保存する', async () => {
  const input = deps({});
  input.fetch = jest.fn().mockRejectedValueOnce(new EutilsError('構文エラー: 不明なフィールドタグ [x]', 200, true))
    .mockRejectedValueOnce(new EutilsError('一時障害', 503));
  expect(diagnosticOutcome((await diagnoseFormula(formula, input)).diagnostics)).toBe('network_error');
  const other = await diagnoseFormula(formula, deps({ esearchresult: {} }));
  expect(other.diagnostics[0]!.status).toBe('other_error');
  expect(diagnosticOutcome(other.diagnostics)).toBe('other_error');
  input.fetch = jest.fn().mockRejectedValueOnce(new EutilsError('構文エラー: 不明なフィールドタグ [x]', 200, true))
    .mockRejectedValueOnce(new EutilsError('その他のエラー', 200, true));
  const mixed = await diagnoseFormula(formula, input);
  expect(mixed.diagnostics.map((item) => item.status)).toEqual(['syntax_error', 'other_error']);
  expect(diagnosticOutcome(mixed.diagnostics)).toBe('syntax_error');
});
