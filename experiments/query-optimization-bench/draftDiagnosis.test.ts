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
  ['x[tiab] OR Diabetic Retinopathy, Proliferative[Mesh] OR y[tiab]', 'Proliferative', 'Diabetic Retinopathy, Proliferative', true],
  ['x[tiab] OR Retinopathy, Nonproliferative, Diabetic[Mesh]', 'Diabetic', 'Retinopathy, Nonproliferative, Diabetic', true],
  ['"Diabetic Retinopathy, Proliferative"[Mesh]', 'Proliferative', null, false],
  ['Retinopathy, Nonproliferative, Diabetic[Mesh] OR Diabetic[Mesh]', 'Diabetic', 'Diabetic', false],
  ['Diabetic[Mesh] OR Retinopathy, Nonproliferative, Diabetic[Mesh]', 'Diabetic', 'Diabetic', false],
  ['x[tiab] OR Retinopathy, Nonproliferative, Diabetic /drug therapy[MeSH:NoExp]', ' diabetic ', 'Retinopathy, Nonproliferative, Diabetic', true],
  ['x[tiab] OR Wounds and Injuries, Other[Mesh]', 'other', 'Wounds and Injuries, Other', true],
  ['x[tiab] OR Diabetic Retinopathy, Proliferative[tiab]', 'Proliferative', null, false],
  ['Retinopathy, Nonproliferative, Diabetic[Mesh]', 'Nonproliferative', null, false],
  ['Diabetic Retinopathy, Proliferative[Mesh]', 'Diabetic Retinopathy, Proliferative', 'Diabetic Retinopathy, Proliferative', false],
] as const)('全体一致を優先し、未引用の最後のカンマ断片だけを照合: %s', async (expression, phrase, term, unquotedComma) => {
  const input = deps({ esearchresult: { count: '0', idlist: [], translationset: [], querytranslation: `"${term}"[mh]`,
    warninglist: { phrasesignored: [], quotedphrasesnotfound: [`"${term}"[mh]`], outputmessages: ['No items found.'] } } });
  expect(meshTerm(phrase, expression)).toBe(term);
  expect(await lookupMesh(phrase, expression, input)).toEqual({ phrase, term, unquotedComma, status: term === null ? 'not_mesh' : 'unresolved', error: null });
  if (term === null) expect(input.fetch).not.toHaveBeenCalled();
  else expect(new URL(jest.mocked(input.fetch).mock.calls[0]![0] as string).searchParams.get('term')).toBe(`"${term}"[mh]`);
});

test.each([
  ['Nonexistent Termxyz Qwerty', 'unresolved', '{"header":{"type":"esearch","version":"0.3"},"esearchresult":{"count":"0","retmax":"0","retstart":"0","idlist":[],"translationset":[],"querytranslation":"(\\"Nonexistent Termxyz Qwerty\\"[mh])","warninglist":{"phrasesignored":[],"quotedphrasesnotfound":["\\"Nonexistent Termxyz Qwerty\\"[mh]"],"outputmessages":["No items found."]}}}'],
  ['Neoplasms', 'resolved', '{"header":{"type":"esearch","version":"0.3"},"esearchresult":{"count":"1","retmax":"1","retstart":"0","idlist":["68009369"],"translationset":[],"translationstack":[{"term":"\\"Neoplasms\\"[mh]","field":"mh","count":"1","explode":"N"},"GROUP"],"querytranslation":"\\"Neoplasms\\"[mh]"}}'],
])('MeSH の実応答を分類する: %s', async (term, status, body) => {
  const input = deps({});
  input.fetch = jest.fn(async () => new Response(body));
  expect((await lookupMesh(term, `"${term}"[mh]`, input)).status).toBe(status);
});

test.each([
  [{ count: '0', errorlist: { phrasesnotfound: ['x'] } }, 'unresolved'],
  [{ errorlist: { phrasesnotfound: ['x'] } }, 'unresolved'],
  [{ count: '1', errorlist: {} }, 'resolved'],
  [{ errorlist: { fieldsnotfound: ['x'] } }, 'lookup_failed'],
  [{ ERROR: 'invalid query' }, 'lookup_failed'],
  [{ count: '0', errorlist: { fieldsnotfound: ['x'], phrasesnotfound: ['x'] } }, 'lookup_failed'],
  [{ ERROR: 'invalid query', errorlist: { phrasesnotfound: ['x'] } }, 'lookup_failed'],
  [{ count: '1', errorlist: { fieldsnotfound: [], phrasesnotfound: [] } }, 'resolved'],
  [{ errorlist: {} }, 'lookup_failed'],
  [{ count: 'invalid', errorlist: {} }, 'lookup_failed'],
  [{ count: '1', errorlist: { other: ['x'] } }, 'resolved'],
])('MeSH の errorlist と件数を分類する: %j', async (result, status) => {
  const input = deps({ esearchresult: result });
  input.maxRetries = 2;
  expect((await lookupMesh('Missing Term', formula.blocks[0]!.expression, input)).status).toBe(status);
  expect(input.fetch).toHaveBeenCalledTimes(1);
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

test('実測の検索バックエンド障害が再送上限まで続くと network_error になる', async () => {
  const input = deps({ esearchresult: { ERROR: 'Search Backend failed: Status: 500' } });
  input.maxRetries = 2;
  input.sleep = jest.fn(async () => undefined);
  const result = await diagnoseFormula(formula, input);
  expect(result.diagnostics.map((item) => item.status)).toEqual(['network_error', 'network_error']);
  expect(diagnosticOutcome(result.diagnostics)).toBe('network_error');
  expect(input.fetch).toHaveBeenCalledTimes(2 * (input.maxRetries + 1));
  expect(input.sleep).toHaveBeenCalledTimes(2 * input.maxRetries);
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
