import * as google from '@/lib/google';
import * as evaluation from './queryEvaluationService';
import * as skill from '@/features/formula/skills/optimizeQuery';
import * as checkpoint from './queryOptimizationCheckpointService';
import type { LLMProvider } from '@/lib/llm';
import { sharedEutilsRateLimiters } from '@/lib/ncbi';
import { validateCombinationExpression } from '@/lib/combination-expression';
import { runQueryOptimization, validateOptimizationCandidate, QueryOptimizationStopError, type QueryOptimizationInput, type QueryOptimizationDeps } from './queryOptimizationService';

interface Outcome { hits: number; captured: string[] }

function setup(outcomes: Record<string, Outcome> = { a: { hits: 200, captured: ['11', '22'] } }, proposals = ['b[tiab]']) {
  const input: QueryOptimizationInput = {
    projectId: 'p', runId: 'run', maxHits: 100, seedPmids: ['11', '22'],
    initialFormula: { blocks: [
      { id: '1', expression: 'a[tiab]', isCombination: false },
      { id: '2', expression: 'fixed[tiab]', isCombination: false },
      { id: 'RCTfilter', expression: 'randomized controlled trial[pt]', isCombination: false },
      { id: '3', expression: '(#1 AND #2) AND #RCTfilter', isCombination: true },
    ], combinationExpression: '(#1 AND #2) AND #RCTfilter' },
    approvedBlocks: [{ id: '1', approvedBlockId: 'approved-1', label: '疾患' }, { id: '2', approvedBlockId: 'approved-2', label: '治療' }],
    criteria: { researchQuestion: '研究課題', inclusionCriteria: '組入', exclusionCriteria: '除外' },
    seedPapers: [{ pmid: '11', title: '研究1' }, { pmid: '22', title: '研究2' }],
    meshContext: [{ id: 'D001', descriptor: 'Disease', label: 'Disease', treeNumbers: ['C01.100'], parentIds: ['D000'], childIds: [], explode: true, note: '取得済み' }],
  };
  const fetch = jest.fn().mockImplementation(async (resource: string) => {
    const query = new URL(resource).searchParams.get('term')!;
    const tagged: readonly string[] = query.match(/[A-Za-z0-9]+\[tiab\]/g) ?? [];
    const key = Object.keys(outcomes).find((term) => tagged.includes(`${term}[tiab]`)) ?? 'a';
    const outcome = outcomes[key]!;
    const capture = query.includes('[uid]');
    return { ok: true, status: 200, json: async () => ({ esearchresult: {
      count: String(capture ? outcome.captured.length : outcome.hits), idlist: capture ? outcome.captured : [],
    } }) };
  });
  let next = 0;
  const chat = jest.fn().mockImplementation(async () => ({
    text: JSON.stringify({ target_block_id: '1', proposed_expression: proposals[Math.min(next++, proposals.length - 1)],
      rationale: '研究基準に沿う変更', added_terms: [], removed_terms: [], replaced_terms: [], measurement_ids: ['run:initial'] }),
    tokensIn: null, tokensOut: null, raw: {},
  }));
  const provider: LLMProvider = { providerId: 'gemini', model: 'test', chat };
  const forPurpose = jest.fn(() => provider);
  const write = jest.fn().mockResolvedValue(undefined);
  const deps: QueryOptimizationDeps = { eutils: { fetch, maxRetries: 0, rateLimiter: { acquire: async () => undefined } },
    llmFactory: { model: 'test', forPurpose }, checkpoint: { read: async () => undefined, write } };
  return { input, deps, fetch, chat, write, forPurpose };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

afterEach(() => jest.restoreAllMocks());

test('初期式が目標内でも AI を呼び、同じ式をキャッシュなしで再検証する。外部保存・store 更新はない', async () => {
  const { input, deps, fetch, chat, forPurpose, write } = setup({ a: { hits: 80, captured: ['11', '22'] } }, ['a[tiab]']);
  const append = jest.spyOn(google, 'appendRow');
  const upload = jest.spyOn(google, 'uploadTextFile');
  const evaluate = jest.spyOn(evaluation, 'evaluateQuery');
  const setState = jest.fn();
  const result = await runQueryOptimization(input, { ...deps, ...{ store: { setState } } });
  expect(result).toMatchObject({ status: 'achieved', stopReason: 'conditions_met', iterations: 1, unmetReasons: [] });
  expect(chat).toHaveBeenCalledTimes(1);
  expect(forPurpose).toHaveBeenCalledWith('optimize_query');
  expect(evaluate).toHaveBeenCalledTimes(3);
  expect(result.trials.map((trial) => trial.candidateId)).toEqual(['initial', 'candidate-1', 'final-1']);
  expect(result.trials[1]?.accepted).toBe(false);
  expect(write).toHaveBeenCalledTimes(4);
  expect(result.apiCalls).toBe(fetch.mock.calls.length + 1);
  for (const [, options] of fetch.mock.calls) expect(options).toEqual({ cache: 'no-store' });
  expect(append).not.toHaveBeenCalled();
  expect(upload).not.toHaveBeenCalled();
  expect(setState).not.toHaveBeenCalled();
  const prompt = chat.mock.calls[0]![0][1].content as string;
  for (const text of ['研究1', 'D001', 'approved-1', '研究課題', '組入', '除外', '100', '"terms"']) expect(prompt).toContain(text);
});

test('未捕捉時は件数が増えてもシード増加を採用し、全件捕捉後は超過分を減らす', async () => {
  const { input, deps, chat } = setup({ a: { hits: 150, captured: ['11'] }, b: { hits: 300, captured: ['11', '22'] },
    c: { hits: 90, captured: ['11', '22'] } }, ['b[tiab]', 'c[tiab]']);
  const result = await runQueryOptimization(input, deps);
  expect(result.status).toBe('achieved');
  expect(result.iterations).toBe(2);
  expect(result.trials.map((trial) => trial.accepted)).toEqual([true, true, true, true]);
  expect(result.best?.formula.blocks[0]?.expression).toBe('c[tiab]');
  expect(chat.mock.calls[1]![0][1].content).toContain('"totalHits": 300');
});

test('上限だけ満たしてシードを失う候補は却下し、次の AI へ前後の実測と理由を返す', async () => {
  const { input, deps, chat } = setup({ a: { hits: 200, captured: ['11', '22'] }, b: { hits: 50, captured: ['11'] },
    c: { hits: 150, captured: ['11', '22'] } }, ['b[tiab]', 'c[tiab]']);
  input.maxIterations = 2;
  const result = await runQueryOptimization(input, deps);
  expect(result).toMatchObject({ status: 'needs_review', stopReason: 'iteration_limit' });
  expect(result.best?.measurement.totalHits).toBe(150);
  expect(result.best?.formula.blocks[0]?.expression).toBe('c[tiab]');
  expect(result.unmetReasons.join(' ')).toContain('最大件数 100');
  const prompt = chat.mock.calls[1]![0][1].content as string;
  for (const text of ['捕捉済みシードを失う: 22', '"accepted": false', '"totalHits": 200', '"totalHits": 50']) expect(prompt).toContain(text);
  expect(result.trials[2]?.before?.totalHits).toBe(200);
});

test('捕捉数が同じでも捕捉集合を入れ替えた候補は却下する', async () => {
  const { input, deps } = setup({ a: { hits: 200, captured: ['11'] }, b: { hits: 50, captured: ['22'] } });
  input.maxIterations = 1;
  const result = await runQueryOptimization(input, deps);
  expect(result.best?.measurement.capturedPmids).toEqual(['11']);
  expect(result.trials[1]?.reason).toContain('シードを失う: 11');
});

test('未捕捉が残る間は件数削減だけを改善とせず、2 回連続で停止する', async () => {
  const { input, deps, chat } = setup({ a: { hits: 200, captured: ['11'] }, b: { hits: 150, captured: ['11'] },
    c: { hits: 50, captured: ['11'] } }, ['b[tiab]', 'c[tiab]']);
  const result = await runQueryOptimization(input, deps);
  expect(result).toMatchObject({ status: 'needs_review', stopReason: 'no_improvement', iterations: 2 });
  expect(chat).toHaveBeenCalledTimes(2);
  expect(result.best?.measurement.totalHits).toBe(200);
  expect(result.unmetReasons.join(' ')).toContain('未捕捉シード: 22');
});

test('目標内での件数削減は改善にせず初期式を最終検証する', async () => {
  const { input, deps } = setup({ a: { hits: 80, captured: ['11', '22'] }, b: { hits: 40, captured: ['11', '22'] } });
  const result = await runQueryOptimization(input, deps);
  expect(result.status).toBe('achieved');
  expect(result.best?.measurement.totalHits).toBe(80);
  expect(result.trials[1]?.accepted).toBe(false);
});

test('同一式への回帰を evaluateQuery の fingerprint で判定する', async () => {
  const { input, deps, chat } = setup({ a: { hits: 200, captured: ['11', '22'] } }, ['a[tiab]']);
  const result = await runQueryOptimization(input, deps);
  expect(result).toMatchObject({ status: 'needs_review', stopReason: 'repeated_formula', iterations: 1 });
  expect(result.trials[0]?.after?.fingerprint).toBe(result.trials[1]?.after?.fingerprint);
  expect(chat).toHaveBeenCalledTimes(1);
});

test('却下済みの式への回帰も停止する', async () => {
  const { input, deps } = setup({ a: { hits: 200, captured: ['11', '22'] }, b: { hits: 300, captured: ['11', '22'] } });
  const result = await runQueryOptimization(input, deps);
  expect(result.stopReason).toBe('repeated_formula');
  expect(result.best?.measurement.totalHits).toBe(200);
});

test('既定 5 回に達したら次の AI 呼び出しを開始しない', async () => {
  const outcomes: Record<string, Outcome> = {};
  ['a', 'b', 'c', 'd', 'e', 'f'].forEach((key, index) => { outcomes[key] = { hits: 1000 - index * 100, captured: ['11', '22'] }; });
  const { input, deps, chat } = setup(outcomes, ['b[tiab]', 'c[tiab]', 'd[tiab]', 'e[tiab]', 'f[tiab]']);
  const result = await runQueryOptimization(input, deps);
  expect(result).toMatchObject({ stopReason: 'iteration_limit', iterations: 5 });
  expect(chat).toHaveBeenCalledTimes(5);
  expect(result.best?.measurement.totalHits).toBe(500);
});

test.each([
  ['new', 'b[tiab]', 'ID'], ['3', '#1 OR #2', '結合行'], ['RCTfilter', 'new[tiab]', 'フィルタ'],
  ['1', '', '単一行'], ['1', 'b[tiab]\n#4 new[tiab]', '単一行'],
  ['1', '#99', '参照'], ['1', '#1', '参照'], ['1', '#3', '循環'],
  ['1', '#2', '参照追加'], ['1', '(b[tiab]', '括弧'], ['1', 'b[tiab] OR', '演算子'],
  ['1', '22[uid]', '許可範囲'], ['1', 'bare text', '許可範囲'],
])('候補 %s=%s は実測前に却下し次の AI 入力へ理由を渡す', async (id, expression, reason) => {
  const { input, deps, chat } = setup();
  const evaluate = jest.spyOn(evaluation, 'evaluateQuery');
  chat.mockResolvedValue({ text: JSON.stringify({ target_block_id: id, proposed_expression: expression }) });
  const result = await runQueryOptimization(input, deps);
  expect(result.stopReason).toBe('no_improvement');
  expect(evaluate).toHaveBeenCalledTimes(1);
  expect(result.trials[1]?.after).toBeNull();
  expect(result.trials[1]?.reason).toContain(reason);
  expect(chat.mock.calls[1]![0][1].content).toContain(result.trials[1]?.reason);
});

test('有効な括弧・AND/OR を持つ概念式は評価できる', async () => {
  const { input, deps } = setup({ a: { hits: 200, captured: ['11', '22'] }, b: { hits: 90, captured: ['11', '22'] } }, ['(b[tiab] OR extra[tiab]) AND more[tiab]']);
  expect((await runQueryOptimization(input, deps)).status).toBe('achieved');
});

test.each(['duplicate', 'unreachable', 'combination', 'empty', 'self', 'cycle', 'unknown', 'mapping', 'missing_mapping'])(
  '初期式の不整合 %s は API 前に入力エラーにする', async (kind) => {
    const { input, deps, fetch, chat } = setup();
    if (kind === 'duplicate') input.initialFormula.blocks[1]!.id = '1';
    if (kind === 'unreachable') input.initialFormula.blocks.push({ id: '99', expression: 'unused[tiab]', isCombination: false });
    if (kind === 'combination') input.initialFormula.combinationExpression = '#1 OR #2';
    if (kind === 'empty') input.initialFormula.blocks = [];
    if (kind === 'self') input.initialFormula.blocks[3]!.expression = '#3';
    if (kind === 'cycle') input.initialFormula.blocks[0]!.expression = '#3';
    if (kind === 'unknown') input.initialFormula.blocks[3]!.expression = '#99';
    if (kind === 'mapping') input.approvedBlocks.push(input.approvedBlocks[0]!);
    if (kind === 'missing_mapping') input.approvedBlocks = [];
    expect((await runQueryOptimization(input, deps)).stopReason).toBe('invalid_input');
    expect(fetch).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
  }
);

test.each([0, -1, 1.5, Number.POSITIVE_INFINITY])('不正な上限 %s を入力エラーにする', async (maxHits) => {
  const { input, deps } = setup();
  input.maxHits = maxHits;
  expect((await runQueryOptimization(input, deps)).stopReason).toBe('invalid_input');
});

test('シード数未満の上限を入力エラーにし、シード 0 件では条件達成にしない', async () => {
  const { input, deps } = setup({ a: { hits: 80, captured: [] } }, ['a[tiab]']);
  input.maxHits = 1;
  expect((await runQueryOptimization(input, deps)).stopReason).toBe('invalid_input');
  input.maxHits = 100;
  input.seedPmids = [];
  const result = await runQueryOptimization(input, deps);
  expect(result.status).toBe('needs_review');
  expect(result.unmetReasons).toContain('シードが未指定です');
});

test('初期測定前の停止は API・チェックポイントを呼ばない', async () => {
  const { input, deps, fetch, chat, write } = setup();
  deps.shouldStop = () => true;
  expect((await runQueryOptimization(input, deps)).status).toBe('stopped');
  expect(fetch).not.toHaveBeenCalled();
  expect(chat).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
});

test.each(['user', 'time'])('AI 待機中の %s 停止後に遅れた応答で候補を更新しない', async (kind) => {
  const { input, deps, chat, write } = setup();
  const waiting = deferred<void>();
  const response = deferred<{ text: string }>();
  let stopped = false;
  let time = 0;
  deps.shouldStop = () => stopped;
  deps.now = () => time;
  deps.maxElapsedMs = 100;
  chat.mockImplementation(() => { waiting.resolve(); return response.promise; });
  const pending = runQueryOptimization(input, deps);
  await waiting.promise;
  if (kind === 'user') stopped = true;
  else time = 100;
  response.resolve({ text: '{"target_block_id":"1","proposed_expression":"b[tiab]"}' });
  const result = await pending;
  expect(result.stopReason).toBe(kind === 'user' ? 'user_stop' : 'time_budget');
  expect(result.best?.formula.blocks[0]?.expression).toBe('a[tiab]');
  expect(result.trials).toHaveLength(1);
  expect(result.iterations).toBe(0);
  expect(write).toHaveBeenCalledTimes(2);
});

test.each(['user', 'time'])('候補測定中の %s 停止で遅い測定結果を破棄する', async (kind) => {
  const { input, deps, write } = setup();
  const original = evaluation.evaluateQuery;
  const waiting = deferred<void>();
  const response = deferred<evaluation.QueryEvaluation>();
  let stopped = false;
  let time = 0;
  deps.shouldStop = () => stopped;
  deps.now = () => time;
  deps.maxElapsedMs = 100;
  jest.spyOn(evaluation, 'evaluateQuery').mockImplementationOnce(original).mockImplementationOnce(async (...args) => {
    const measured = await original(...args);
    waiting.resolve();
    await response.promise;
    return measured;
  });
  const pending = runQueryOptimization(input, deps);
  await waiting.promise;
  if (kind === 'user') stopped = true;
  else time = 100;
  response.resolve({} as evaluation.QueryEvaluation);
  const result = await pending;
  expect(result.stopReason).toBe(kind === 'user' ? 'user_stop' : 'time_budget');
  expect(result.trials).toHaveLength(1);
  expect(write).toHaveBeenCalledTimes(2);
});

test('通信数上限で次の実リクエストを止め、途中評価を採用しない', async () => {
  const { input, deps, fetch, chat } = setup();
  deps.maxApiCalls = 2;
  const result = await runQueryOptimization(input, deps);
  expect(result).toMatchObject({ status: 'needs_review', stopReason: 'api_budget', apiCalls: 2, best: null, trials: [] });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(chat).not.toHaveBeenCalled();
});

test('既定時間上限に達した初期応答も破棄する', async () => {
  const { input, deps, fetch } = setup();
  let time = 0;
  deps.now = () => time;
  fetch.mockImplementationOnce(async () => {
    time = 600000;
    return { ok: true, json: async () => ({ esearchresult: { count: '1', idlist: [] } }) };
  });
  const result = await runQueryOptimization(input, deps);
  expect(result).toMatchObject({ stopReason: 'time_budget', best: null, trials: [] });
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('初期測定完了後の停止は次の AI を呼ばない', async () => {
  const { input, deps, write, chat } = setup();
  let stop = false;
  deps.shouldStop = () => stop;
  write.mockImplementationOnce(async () => { stop = true; });
  const result = await runQueryOptimization(input, deps);
  expect(result.status).toBe('stopped');
  expect(result.best).not.toBeNull();
  expect(chat).not.toHaveBeenCalled();
});

test('上限終了後に返されたオブジェクトを変更しても終了結果は変わらない', async () => {
  const { input, deps, chat } = setup({ a: { hits: 200, captured: ['11', '22'] }, b: { hits: 150, captured: ['11', '22'] } });
  input.maxIterations = 1;
  const proposal: skill.OptimizeQueryProposal = { targetBlockId: '1', proposedExpression: 'b[tiab]',
    rationale: '', addedTerms: [], removedTerms: [], replacedTerms: [], measurementIds: [], meshRequests: [] };
  jest.spyOn(skill, 'optimizeQuery').mockResolvedValue(proposal);
  const result = await runQueryOptimization(input, deps);
  expect(result.stopReason).toBe('iteration_limit');
  const snapshot = JSON.stringify(result);
  proposal.proposedExpression = 'late[tiab]';
  await Promise.resolve();
  expect(JSON.stringify(result)).toBe(snapshot);
  expect(chat).not.toHaveBeenCalled();
});

test.each(['initial', 'candidate', 'llm', 'storage'])('継続不能な %s エラーを区別し、最良の成功測定を維持する', async (kind) => {
  const { input, deps, fetch, chat, write } = setup();
  if (kind === 'initial') fetch.mockRejectedValue(new Error('測定通信失敗'));
  if (kind === 'candidate') chat.mockImplementationOnce(async () => {
    fetch.mockRejectedValue(new Error('測定通信失敗'));
    return { text: '{"target_block_id":"1","proposed_expression":"b[tiab]"}' };
  });
  if (kind === 'llm') chat.mockRejectedValue('LLM 通信失敗');
  if (kind === 'storage') write.mockRejectedValue(new Error('容量不足'));
  const result = await runQueryOptimization(input, deps);
  expect(result).toMatchObject({ status: 'error', stopReason: 'api_error' });
  if (kind === 'initial') expect(result.best).toBeNull();
  else expect(result.best?.formula.blocks[0]?.expression).toBe('a[tiab]');
  if (kind === 'candidate') expect(result.trials[1]?.after?.totalHits).toBeNull();
});

test('最終再検証で条件が崩れたら達成にしない', async () => {
  const { input, deps } = setup({ a: { hits: 80, captured: ['11', '22'] } }, ['a[tiab]']);
  const original = evaluation.evaluateQuery;
  jest.spyOn(evaluation, 'evaluateQuery').mockImplementationOnce(original).mockImplementationOnce(original)
    .mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      if (result.finalQuery.status === 'success') result.finalQuery.totalHits = 120;
      return result;
    });
  const result = await runQueryOptimization(input, deps);
  expect(result).toMatchObject({ status: 'needs_review', stopReason: 'revalidation_failed' });
  expect(result.trials[2]?.after?.totalHits).toBe(120);
  expect(result.unmetReasons.join(' ')).toContain('最大件数 100 件を超えています（実測 120 件）');
  expect(result.best?.measurement.totalHits).toBe(80);
});

test('最終再検証でシード喪失・API 失敗を検出する', async () => {
  const { input, deps, fetch } = setup({ a: { hits: 80, captured: ['11', '22'] } }, ['a[tiab]']);
  const original = evaluation.evaluateQuery;
  jest.spyOn(evaluation, 'evaluateQuery').mockImplementationOnce(original).mockImplementationOnce(original)
    .mockImplementationOnce(async (...args) => {
      fetch.mockRejectedValue(new Error('再検証不能'));
      return original(...args);
    });
  expect((await runQueryOptimization(input, deps)).status).toBe('error');
});

test('待機中の入力変更に影響されず、シード重複を除去する', async () => {
  const { input, deps, chat } = setup({ a: { hits: 80, captured: ['11', '22'] } }, ['a[tiab]']);
  input.seedPmids.push('11');
  const pending = runQueryOptimization(input, deps);
  input.maxHits = 1;
  input.initialFormula.blocks[0]!.expression = 'changed';
  input.seedPmids.push('33');
  input.criteria.researchQuestion = '変更後';
  const result = await pending;
  expect(result.status).toBe('achieved');
  expect(result.best?.evaluation.seedPmids).toEqual(['11', '22']);
  expect(chat.mock.calls[0]![0][1].content).not.toContain('"researchQuestion": "変更後"');
});

test.each(['add', 'remove', 'rename', 'combination', 'filter', 'filter_and', 'flag'])(
  '全候補の保護検査が %s の構造破壊を検出する', (kind) => {
    const { input } = setup();
    const candidate = JSON.parse(JSON.stringify(input.initialFormula)) as typeof input.initialFormula;
    if (kind === 'add') candidate.blocks.push({ id: 'new', expression: 'new[tiab]', isCombination: false });
    if (kind === 'remove') candidate.blocks.splice(0, 1);
    if (kind === 'rename') candidate.blocks[0]!.id = 'renamed';
    if (kind === 'combination') candidate.combinationExpression = '#1 OR #2';
    if (kind === 'filter') candidate.blocks[2]!.expression = 'broken[pt]';
    if (kind === 'filter_and') candidate.blocks[3]!.expression = '#1 AND #2';
    if (kind === 'flag') candidate.blocks[0]!.isCombination = true;
    expect(validateOptimizationCandidate(input.initialFormula, candidate, input.approvedBlocks)).not.toBeNull();
  }
);

test('MeSH の原タグ・NoExp・qualifier を保持して計測し、同じ語は分析内で共有する', async () => {
  const { input, deps, fetch, chat } = setup({ a: { hits: 80, captured: ['11', '22'] } }, ['a[tiab]']);
  const expression = 'a[tiab] OR "Disease/therapy"[Majr:noexp]';
  input.initialFormula.blocks[0]!.expression = expression;
  input.initialFormula.blocks[1]!.expression = expression;
  const result = await runQueryOptimization(input, deps);
  expect(result.status).toBe('achieved');
  const queries = fetch.mock.calls.map(([url]) => new URL(url as string).searchParams.get('term'));
  expect(queries.filter((query) => query === '"Disease/therapy"[Majr:noexp]')).toHaveLength(1);
  expect(chat.mock.calls[0]![0][1].content).toContain('Disease/therapy');
});

test.each(['failure', 'clamped'])('語の %s を 0 件・寄与なしとして AI に渡さない', async (kind) => {
  const { input, deps, fetch, chat } = setup({ a: { hits: 200, captured: ['11', '22'] } }, ['a[tiab]']);
  input.initialFormula.blocks[0]!.expression = 'a[tiab] OR broken[tiab]';
  input.maxIterations = 1;
  const original = fetch.getMockImplementation()!;
  fetch.mockImplementation(async (url: string) => {
    const query = new URL(url).searchParams.get('term');
    if (kind === 'failure' && query === 'broken[tiab]') throw new Error('語の取得失敗');
    if (kind === 'clamped' && query === '(a[tiab]) OR (broken[tiab])') {
      return { ok: true, json: async () => ({ esearchresult: { count: '1', idlist: [] } }) };
    }
    return original(url);
  });
  const optimize = jest.spyOn(skill, 'optimizeQuery');
  await runQueryOptimization(input, deps);
  const broken = optimize.mock.calls[0]![0].measurement?.terms?.find((term) => term.query === 'broken[tiab]');
  expect(broken?.delta).toBeNull();
  expect(broken?.hits).toBe(kind === 'failure' ? null : 200);
  expect(chat.mock.calls[0]![0][1].content).toContain('"delta": "(未計測)"');
});

test('AI が通信予算の最後の呼び出しなら遅い応答を破棄する', async () => {
  const { input, deps, fetch, chat, write } = setup();
  // 初期実測 5 回＋語別 2 回＋AI 1 回で予算を使い切る。
  deps.maxApiCalls = 8;
  const waiting = deferred<void>();
  const response = deferred<{ text: string }>();
  chat.mockImplementation(() => { waiting.resolve(); return response.promise; });
  const pending = runQueryOptimization(input, deps);
  await waiting.promise;
  response.resolve({ text: '{"target_block_id":"1","proposed_expression":"late[tiab]"}' });
  const result = await pending;
  expect(result).toMatchObject({ stopReason: 'api_budget', apiCalls: 8, iterations: 0 });
  expect(fetch).toHaveBeenCalledTimes(7);
  expect(write).toHaveBeenCalledTimes(2);
  expect(result.trials).toHaveLength(1);
  expect(result.best?.formula.blocks[0]?.expression).toBe('a[tiab]');
});

test('停止中に AI が reject してもユーザー停止を優先する', async () => {
  const { input, deps, chat } = setup();
  let stop = false;
  deps.shouldStop = () => stop;
  chat.mockImplementation(async () => { stop = true; throw new Error('遅いエラー'); });
  expect((await runQueryOptimization(input, deps)).stopReason).toBe('user_stop');
});

test('最終再検証中の停止は達成状態とチェックポイントを更新しない', async () => {
  const { input, deps, write } = setup({ a: { hits: 80, captured: ['11', '22'] } }, ['a[tiab]']);
  let stop = false;
  deps.shouldStop = () => stop;
  const original = evaluation.evaluateQuery;
  jest.spyOn(evaluation, 'evaluateQuery').mockImplementationOnce(original).mockImplementationOnce(original)
    .mockImplementationOnce(async (...args) => { const result = await original(...args); stop = true; return result; });
  const result = await runQueryOptimization(input, deps);
  expect(result.status).toBe('stopped');
  expect(result.trials).toHaveLength(2);
  expect(write).toHaveBeenCalledTimes(3);
});

test('途中で改善があれば連続改善なし回数をリセットする', async () => {
  const { input, deps } = setup({ a: { hits: 300, captured: ['11', '22'] }, b: { hits: 400, captured: ['11', '22'] },
    c: { hits: 200, captured: ['11', '22'] }, d: { hits: 250, captured: ['11', '22'] }, e: { hits: 90, captured: ['11', '22'] } },
  ['b[tiab]', 'c[tiab]', 'd[tiab]', 'e[tiab]']);
  const result = await runQueryOptimization(input, deps);
  expect(result).toMatchObject({ status: 'achieved', iterations: 4 });
});

test('書誌・ツリー未指定の単一ブロック式も、欠測を明示して実行できる', async () => {
  const { input, deps, chat } = setup({ a: { hits: 80, captured: ['11', '22'] } }, ['a[tiab]']);
  input.initialFormula.blocks = [input.initialFormula.blocks[0]!];
  input.initialFormula.combinationExpression = null;
  input.approvedBlocks = [input.approvedBlocks[0]!];
  delete input.seedPapers;
  delete input.meshContext;
  expect((await runQueryOptimization(input, deps)).status).toBe('achieved');
  expect(chat.mock.calls[0]![0][1].content).toContain('"title": "(渡されていない)"');
});

test('最終再検証でシードを失ったら要確認へ戻す', async () => {
  const { input, deps } = setup({ a: { hits: 80, captured: ['11', '22'] } }, ['a[tiab]']);
  const original = evaluation.evaluateQuery;
  jest.spyOn(evaluation, 'evaluateQuery').mockImplementationOnce(original).mockImplementationOnce(original)
    .mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      if (result.finalQuery.status === 'success') {
        result.finalQuery.capturedPmids = ['11'];
        result.finalQuery.missedPmids = ['22'];
      }
      return result;
    });
  const result = await runQueryOptimization(input, deps);
  expect(result.stopReason).toBe('revalidation_failed');
  expect(result.trials[2]?.accepted).toBe(false);
  expect(result.unmetReasons).toContain('未捕捉シード: 22');
  expect(result.best?.measurement.capturedPmids).toEqual(['11', '22']);
});

function requestMesh(chat: ReturnType<typeof setup>['chat'], requests: skill.OptimizationMeshRequest[]) {
  chat.mockResolvedValueOnce({ text: JSON.stringify({
    target_block_id: '1', proposed_expression: 'a[tiab]', rationale: '枝を確認してから変更を判断',
    mesh_requests: requests.map((request) => ({ descriptor: request.descriptor, tree_number: request.treeNumber })),
  }) });
}

const meshRequest: skill.OptimizationMeshRequest = { descriptor: 'Disease', treeNumber: 'C01.100' };
const childNode: skill.OptimizationMeshNode = { id: 'D002', descriptor: 'Child', label: 'Child',
  treeNumbers: ['C01.100.200'], parentIds: ['D001'], childIds: [], explode: true, note: '直下を取得済み' };

test('追加取得した枝を次の AI 文脈へ反映し、情報要求だけの同一式では停止しない', async () => {
  const { input, deps, chat, fetch } = setup();
  input.maxIterations = 2;
  requestMesh(chat, [meshRequest]);
  const nodes = [{ ...childNode, treeNumbers: [...childNode.treeNumbers] }, { ...input.meshContext![0]!, treeNumbers: ['C02.200'], childIds: ['D002'] }];
  const fetchMeshContext = jest.fn().mockResolvedValue(nodes);
  deps.fetchMeshContext = fetchMeshContext;
  const optimize = jest.spyOn(skill, 'optimizeQuery');
  const evaluate = jest.spyOn(evaluation, 'evaluateQuery');
  const result = await runQueryOptimization(input, deps);
  expect(fetchMeshContext).toHaveBeenCalledWith(meshRequest);
  expect(optimize.mock.calls[1]![0].meshContext).toEqual([
    expect.objectContaining({ id: 'D001', treeNumbers: ['C01.100', 'C02.200'], childIds: ['D002'] }), childNode,
  ]);
  expect(chat.mock.calls[1]![0][1].content).toContain('追加取得した周辺ノードを文脈へ反映');
  expect(result.apiCalls).toBe(fetch.mock.calls.length + chat.mock.calls.length + 1);
  expect(evaluate).toHaveBeenCalledTimes(2);
  expect(result.trials[1]?.after).toBeNull();
  expect(result.iterations).toBe(2);
  expect(input.meshContext![0]!.childIds).toEqual([]);
  nodes[0]!.treeNumbers.push('late');
  expect(optimize.mock.calls[1]![0].meshContext![1]!.treeNumbers).toEqual(['C01.100.200']);
});

test.each(['missing', 'failure', 'empty', 'unspecified'])('追加取得の %s を黙って無視せず、未取得関係を推測しない', async (kind) => {
  const { input, deps, chat } = setup();
  input.maxIterations = 2;
  requestMesh(chat, [kind === 'unspecified' ? { descriptor: '', treeNumber: '' } : meshRequest]);
  const fetchMeshContext = jest.fn().mockResolvedValue([]);
  if (kind === 'failure') fetchMeshContext.mockRejectedValue('取得先が応答しません');
  if (kind !== 'missing') deps.fetchMeshContext = fetchMeshContext;
  const optimize = jest.spyOn(skill, 'optimizeQuery');
  await runQueryOptimization(input, deps);
  expect(optimize.mock.calls[1]![0].meshContext).toEqual(input.meshContext);
  const note = optimize.mock.calls[1]![0].meshRequestResults![0]!.note;
  expect(note).toContain('未取得');
  expect(note).toContain(kind === 'missing' ? 'callback が注入されていません' : kind === 'failure'
    ? '取得先が応答しません' : kind === 'empty' ? '取得結果が空' : '両方が未指定');
  expect(chat.mock.calls[1]![0][1].content).toContain(note);
  expect(fetchMeshContext).toHaveBeenCalledTimes(kind === 'missing' || kind === 'unspecified' ? 0 : 1);
});

test('1 反復の追加取得を優先順の 3 件までに制限し、残りの打ち切りを明示する', async () => {
  const { input, deps, chat } = setup();
  input.maxIterations = 2;
  const requests = Array.from({ length: 5 }, (_, index) => ({ descriptor: `Disease${index}`, treeNumber: '' }));
  requestMesh(chat, requests);
  const fetchMeshContext = jest.fn().mockResolvedValue([childNode]);
  deps.fetchMeshContext = fetchMeshContext;
  const optimize = jest.spyOn(skill, 'optimizeQuery');
  await runQueryOptimization(input, deps);
  expect(fetchMeshContext.mock.calls).toEqual(requests.slice(0, 3).map((request) => [request]));
  const notes = optimize.mock.calls[1]![0].meshRequestResults!;
  expect(notes).toHaveLength(5);
  for (const note of notes.slice(3)) expect(note.note).toContain('3 件の追加取得上限で打ち切りました');
});

test.each(['success', 'failure'])('追加取得が予算を使い切った場合は %s 応答を破棄する', async (kind) => {
  const { input, deps, chat, write, fetch } = setup();
  requestMesh(chat, [meshRequest, meshRequest]);
  // 初期実測 5 回、語別 2 回、AI 1 回の後、追加取得 1 回で上限。
  deps.maxApiCalls = 9;
  const waiting = deferred<void>();
  const response = deferred<skill.OptimizationMeshNode[]>();
  const fetchMeshContext = jest.fn(() => { waiting.resolve(); return response.promise; });
  deps.fetchMeshContext = fetchMeshContext;
  const pending = runQueryOptimization(input, deps);
  await waiting.promise;
  if (kind === 'success') response.resolve([childNode]);
  else response.reject(new Error('遅い取得失敗'));
  const result = await pending;
  expect(result).toMatchObject({ stopReason: 'api_budget', apiCalls: 9 });
  expect(fetchMeshContext).toHaveBeenCalledTimes(1);
  expect(chat).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledTimes(7);
  expect(write).toHaveBeenCalledTimes(2);
  expect(result.trials).toHaveLength(1);
});

test('追加取得待機中のユーザー停止で取得結果を破棄する', async () => {
  const { input, deps, chat } = setup();
  requestMesh(chat, [meshRequest]);
  let stop = false;
  deps.shouldStop = () => stop;
  deps.fetchMeshContext = async () => { stop = true; return [childNode]; };
  const result = await runQueryOptimization(input, deps);
  expect(result.status).toBe('stopped');
  expect(result.trials).toHaveLength(1);
  expect(chat).toHaveBeenCalledTimes(1);
});

test('反復上限の情報要求は取得せず、打ち切り理由を試行へ残す', async () => {
  const { input, deps, chat } = setup();
  input.maxIterations = 1;
  requestMesh(chat, [meshRequest]);
  const fetchMeshContext = jest.fn().mockResolvedValue([childNode]);
  deps.fetchMeshContext = fetchMeshContext;
  const result = await runQueryOptimization(input, deps);
  expect(result.stopReason).toBe('iteration_limit');
  expect(result.trials[1]?.reason).toContain('反復上限に達したため追加取得を打ち切りました');
  expect(fetchMeshContext).not.toHaveBeenCalled();
});

test.each(['user_stop', 'time_budget', 'api_budget'] as const)('制御例外 %s の型から停止理由を確定する', async (reason) => {
  const { input, deps, chat } = setup();
  const error = new QueryOptimizationStopError(reason);
  expect(error.name).toBe('QueryOptimizationStopError');
  expect(error.stopReason).toBe(reason);
  expect(error.message).toMatch(/ユーザー|時間|通信回数/);
  expect(error.message).not.toContain(reason);
  // callback と実予算の状態とは独立に、捕捉した例外型から停止理由を取り出す。
  chat.mockRejectedValue(error);
  const result = await runQueryOptimization(input, deps);
  expect(result.stopReason).toBe(reason);
  expect(result.unmetReasons).toContain(error.message);
});

test('追加取得 callback が返した制御例外も取得失敗へ変換せず伝播する', async () => {
  const { input, deps, chat } = setup();
  requestMesh(chat, [meshRequest]);
  deps.fetchMeshContext = async () => { throw new QueryOptimizationStopError('time_budget'); };
  expect((await runQueryOptimization(input, deps)).stopReason).toBe('time_budget');
});

test('停止が行ごとの測定失敗に変換されても、再試行の待機を開始せず停止理由を返す', async () => {
  const { input, deps, fetch } = setup();
  let stop = false;
  deps.shouldStop = () => stop;
  deps.eutils.maxRetries = 5;
  const sleep = jest.fn().mockResolvedValue(undefined);
  deps.eutils.sleep = sleep;
  fetch.mockImplementationOnce(async () => {
    stop = true;
    return { ok: true, json: async () => ({ esearchresult: { count: '1', idlist: [] } }) };
  });
  const result = await runQueryOptimization(input, deps);
  expect(result).toMatchObject({ stopReason: 'user_stop', best: null, trials: [] });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(sleep).not.toHaveBeenCalled();
});

test('記録済み試行は後の語別計測で変化せず、同じ最良式の語を再計測しない', async () => {
  const { input, deps, fetch } = setup({ a: { hits: 300, captured: ['11', '22'] },
    b: { hits: 400, captured: ['11', '22'] }, c: { hits: 200, captured: ['11', '22'] },
    d: { hits: 250, captured: ['11', '22'] }, e: { hits: 240, captured: ['11', '22'] } },
  ['b[tiab]', 'c[tiab]', 'd[tiab]', 'e[tiab]']);
  const recorded: { trial: skill.OptimizationTrial; json: string }[] = [];
  const save = checkpoint.saveQueryOptimizationCheckpoint;
  jest.spyOn(checkpoint, 'saveQueryOptimizationCheckpoint').mockImplementation(async (...args) => {
    for (const trial of args[3]) {
      if (!recorded.some((entry) => entry.trial === trial)) recorded.push({ trial, json: JSON.stringify(trial) });
    }
    return save(...args);
  });
  const optimize = jest.spyOn(skill, 'optimizeQuery');
  const result = await runQueryOptimization(input, deps);
  expect(result.stopReason).toBe('no_improvement');
  for (const { trial, json } of recorded) expect(JSON.stringify(trial)).toBe(json);
  expect(result.trials[0]!.after).not.toHaveProperty('terms');
  expect(result.trials[2]!.after).not.toHaveProperty('terms');
  expect(optimize.mock.calls[0]![0].measurement!.terms).toBe(optimize.mock.calls[1]![0].measurement!.terms);
  expect(optimize.mock.calls[2]![0].measurement!.terms).toBe(optimize.mock.calls[3]![0].measurement!.terms);
  const queries = fetch.mock.calls.map(([url]) => new URL(url as string).searchParams.get('term'));
  expect(queries.filter((query) => query === 'a[tiab]')).toHaveLength(2);
  expect(queries.filter((query) => query === 'c[tiab]')).toHaveLength(2);
});

test('入力固定は書誌・承認対応・MeSH の入れ子もコピーする', async () => {
  const { input, deps, chat } = setup();
  input.maxIterations = 1;
  const pending = runQueryOptimization(input, deps);
  input.seedPapers![0]!.title = '変更後の書誌';
  input.approvedBlocks[0]!.label = '変更後のラベル';
  input.meshContext![0]!.treeNumbers.push('C99');
  input.meshContext![0]!.parentIds.push('mutated');
  await pending;
  const prompt = chat.mock.calls[0]![0][1].content as string;
  for (const value of ['変更後の書誌', '変更後のラベル', 'C99', 'mutated']) expect(prompt).not.toContain(value);
});

test('初期ツリーが未提供でも追加取得した実在ノードを渡せる', async () => {
  const { input, deps, chat } = setup();
  input.maxIterations = 2;
  delete input.meshContext;
  requestMesh(chat, [meshRequest]);
  deps.fetchMeshContext = async () => [childNode];
  const optimize = jest.spyOn(skill, 'optimizeQuery');
  await runQueryOptimization(input, deps);
  expect(optimize.mock.calls[0]![0].meshContext).toBeUndefined();
  expect(optimize.mock.calls[1]![0].meshContext).toEqual([childNode]);
});

test('通常の NCBI 再試行は注入した待機を使い、停止制御と区別する', async () => {
  const { input, deps, fetch } = setup();
  input.maxIterations = 1;
  deps.eutils.maxRetries = 1;
  const sleep = jest.fn().mockResolvedValue(undefined);
  deps.eutils.sleep = sleep;
  fetch.mockRejectedValueOnce(new Error('一時的な通信失敗'));
  const result = await runQueryOptimization(input, deps);
  expect(result.stopReason).toBe('iteration_limit');
  expect(sleep).toHaveBeenCalledWith(1000);
  expect(result.best).not.toBeNull();
});

test.each([
  'asthma[tiab] NOT pediatric[tiab]',
  '(asthma[tiab] OR wheeze[tiab]) NOT (pediatric[tiab] OR child[tiab])',
  'asthma[tiab] AND NOT pediatric[tiab]',
])('概念式の NOT を検査用にだけ正規化し、原文を実測する: %s', async (expression) => {
  const { input, deps, fetch } = setup({ a: { hits: 200, captured: ['11', '22'] },
    asthma: { hits: 90, captured: ['11', '22'] } }, [expression]);
  const result = await runQueryOptimization(input, deps);
  expect(result.status).toBe('achieved');
  expect(result.best?.formula.blocks[0]!.expression).toBe(expression);
  expect(fetch.mock.calls.some(([url]) => new URL(url as string).searchParams.get('term') === expression)).toBe(true);
});

test('二項 NOT の結合行は従来の文法で拒否し、概念式の末尾 NOT も拒否する', () => {
  const { input } = setup();
  expect(validateCombinationExpression('#1 NOT #2', new Set(['1', '2'])).errors.length).toBeGreaterThan(0);
  const formula = { ...input.initialFormula, blocks: input.initialFormula.blocks.map((block) => ({ ...block })) };
  formula.blocks[3]!.expression = '(#1 NOT #2) AND #RCTfilter';
  formula.combinationExpression = formula.blocks[3]!.expression;
  expect(validateOptimizationCandidate(formula, formula, input.approvedBlocks)).toContain('結合構文');
  const proposal: skill.OptimizeQueryProposal = { targetBlockId: '1', proposedExpression: 'a[tiab] NOT',
    addedTerms: [], removedTerms: [], replacedTerms: [], rationale: '', measurementIds: [], meshRequests: [] };
  const candidate = { ...input.initialFormula, blocks: input.initialFormula.blocks.map((block) => ({ ...block })) };
  candidate.blocks[0]!.expression = proposal.proposedExpression;
  expect(validateOptimizationCandidate(input.initialFormula, candidate, input.approvedBlocks, proposal)).toContain('不正');
});

test('候補の in-band エラーは却下して実測理由を次の AI へ渡し、最良式から続ける', async () => {
  const { input, deps, fetch, chat } = setup({ a: { hits: 200, captured: ['11', '22'] },
    c: { hits: 90, captured: ['11', '22'] } }, ['"Misspelled disease"[Mesh]', 'c[tiab]']);
  const original = fetch.getMockImplementation()!;
  fetch.mockImplementation(async (url: string) => {
    if (new URL(url).searchParams.get('term')!.includes('Misspelled disease')) {
      return { ok: true, status: 200, json: async () => ({ esearchresult: {
        errorlist: { phrasesnotfound: ['Misspelled disease'] },
      } }) };
    }
    return original(url);
  });
  const optimize = jest.spyOn(skill, 'optimizeQuery');
  const result = await runQueryOptimization(input, deps);
  expect(result).toMatchObject({ status: 'achieved', iterations: 2 });
  expect(result.trials[1]).toMatchObject({ accepted: false, reason: expect.stringContaining('Misspelled disease') });
  expect(optimize.mock.calls[1]![0].formula.blocks[0]!.expression).toBe('a[tiab]');
  expect(optimize.mock.calls[1]![0].measurement!.totalHits).toBe(200);
  expect(chat.mock.calls[1]![0][1].content).toContain('候補の測定に失敗したため却下しました');
  expect(chat.mock.calls[1]![0][1].content).toContain('Misspelled disease');
  expect(result.best?.measurement.totalHits).toBe(90);
});

test('同じ候補で測定が連続して失敗したら、回帰より API エラーを優先する', async () => {
  const { input, deps, fetch, chat } = setup();
  const original = fetch.getMockImplementation()!;
  fetch.mockImplementation(async (url: string) => {
    if (new URL(url).searchParams.get('term')!.includes('b[tiab]')) throw new Error('一時的な通信障害');
    return original(url);
  });
  const result = await runQueryOptimization(input, deps);
  expect(result).toMatchObject({ status: 'error', stopReason: 'api_error', iterations: 2 });
  expect(chat).toHaveBeenCalledTimes(2);
  expect(result.trials.slice(1).every((trial) => !trial.accepted)).toBe(true);
  expect(result.best?.measurement.totalHits).toBe(200);
});

test('成功測定を挟めば連続失敗数をリセットする', async () => {
  const { input, deps, fetch } = setup({ a: { hits: 400, captured: ['11', '22'] },
    c: { hits: 200, captured: ['11', '22'] }, e: { hits: 90, captured: ['11', '22'] } },
  ['b[tiab]', 'c[tiab]', 'd[tiab]', 'e[tiab]']);
  const original = fetch.getMockImplementation()!;
  fetch.mockImplementation(async (url: string) => {
    if (/\b[bd]\[tiab\]/.test(new URL(url).searchParams.get('term')!)) throw new Error('候補の測定失敗');
    return original(url);
  });
  const result = await runQueryOptimization(input, deps);
  expect(result).toMatchObject({ status: 'achieved', iterations: 4 });
});

test.each(['achieved', 'needs_review', 'stopped', 'error'] as const)('終了状態 %s の復元は中断ではなく完了済みになる', async (status) => {
  const { input, deps, chat, write } = setup({ a: { hits: status === 'achieved' ? 80 : 200, captured: ['11', '22'] } }, ['a[tiab]']);
  const data: Record<string, unknown> = {};
  let stop = false;
  deps.shouldStop = () => stop;
  deps.checkpoint.read = async <T>(key: string) => data[key] as T | undefined;
  write.mockImplementation(async (items: Record<string, unknown>) => {
    Object.assign(data, items);
    if (status === 'stopped') stop = true;
  });
  if (status === 'error') chat.mockRejectedValue(new Error('LLM 通信障害'));
  const result = await runQueryOptimization(input, deps);
  expect(result.status).toBe(status);
  const restored = await checkpoint.getQueryOptimizationCheckpoint(input.projectId, deps.checkpoint);
  expect(restored).toMatchObject({ status: 'completed', needsRevalidation: true,
    completion: { status, stopReason: result.stopReason } });
  expect(restored?.trials.length).toBe(result.trials.length);
  expect(JSON.stringify(restored)).not.toContain('"terms"');
});

test('終了状態の保存に失敗しても結果を失わず、その事実を返す', async () => {
  const { input, deps, write } = setup({ a: { hits: 80, captured: ['11', '22'] } }, ['a[tiab]']);
  write.mockImplementation(async (items: Record<string, checkpoint.QueryOptimizationCheckpoint>) => {
    if (Object.values(items)[0]?.completion) throw new Error('容量不足');
  });
  const result = await runQueryOptimization(input, deps);
  expect(result.status).toBe('achieved');
  expect(result.unmetReasons).toContain('終了記録の保存に失敗しました: 容量不足');
  expect(result.best?.measurement.totalHits).toBe(80);
});

test.each([1, 5])('目標内で MeSH 要求を返しても、反復上限 %s の範囲で最終再検証へ進む', async (limit) => {
  const { input, deps, chat } = setup({ a: { hits: 80, captured: ['11', '22'] } });
  input.maxIterations = limit;
  requestMesh(chat, [meshRequest]);
  const evaluate = jest.spyOn(evaluation, 'evaluateQuery');
  const result = await runQueryOptimization(input, deps);
  expect(result).toMatchObject({ status: 'achieved', stopReason: 'conditions_met', iterations: 1 });
  expect(chat).toHaveBeenCalledTimes(1);
  expect(evaluate).toHaveBeenCalledTimes(2);
  expect(result.trials[1]!.after).toBeNull();
  expect(result.trials[2]!.candidateId).toBe('final-1');
});

test('非承認ブロックと研究デザインフィルタの語別計測をしない', async () => {
  const { input, deps, fetch } = setup({ a: { hits: 80, captured: ['11', '22'] } }, ['a[tiab]']);
  input.approvedBlocks = [input.approvedBlocks[0]!];
  input.initialFormula.blocks[1]!.expression = 'unapproved[tiab] OR "Other concept"[Mesh]';
  input.initialFormula.blocks[2]!.expression = 'filterword[tiab] OR "Filter heading"[Mesh]';
  const optimize = jest.spyOn(skill, 'optimizeQuery');
  const result = await runQueryOptimization(input, deps);
  expect(result.status).toBe('achieved');
  expect(optimize.mock.calls[0]![0].measurement!.terms!.map((term) => term.blockId)).toEqual(['1']);
  const queries = fetch.mock.calls.map(([url]) => new URL(url as string).searchParams.get('term'));
  for (const term of ['unapproved[tiab]', '"Other concept"[Mesh]', 'filterword[tiab]', '"Filter heading"[Mesh]']) {
    expect(queries).not.toContain(term);
  }
  expect(queries).toContain(input.initialFormula.blocks[1]!.expression);
  expect(queries).toContain(input.initialFormula.blocks[2]!.expression);
});

test('停止後は残りの行や最終式のレート制限待機を開始しない', async () => {
  const { input, deps, fetch } = setup();
  let stop = false;
  deps.shouldStop = () => stop;
  const acquire = jest.fn().mockResolvedValue(undefined);
  deps.eutils.rateLimiter = { acquire };
  const original = fetch.getMockImplementation()!;
  fetch.mockImplementationOnce(async (url: string) => { stop = true; return original(url); });
  expect((await runQueryOptimization(input, deps)).stopReason).toBe('user_stop');
  expect(acquire).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('レート制限待機中に停止した場合も fetch と後続 acquire を開始しない', async () => {
  const { input, deps, fetch } = setup();
  let stop = false;
  deps.shouldStop = () => stop;
  const acquire = jest.fn(async () => { stop = true; });
  deps.eutils.rateLimiter = { acquire };
  const result = await runQueryOptimization(input, deps);
  expect(result.status).toBe('stopped');
  expect(acquire).toHaveBeenCalledTimes(1);
  expect(fetch).not.toHaveBeenCalled();
});

test.each([false, true])('リミッタ未注入時は API キー有無 %s に応じた共有リミッタを維持する', async (hasKey) => {
  const { input, deps, fetch } = setup({ a: { hits: 80, captured: ['11', '22'] } }, ['a[tiab]']);
  delete deps.eutils.rateLimiter;
  if (hasKey) deps.eutils.apiKey = 'test-key';
  const withoutKey = jest.spyOn(sharedEutilsRateLimiters.withoutApiKey, 'acquire').mockResolvedValue(undefined);
  const withKey = jest.spyOn(sharedEutilsRateLimiters.withApiKey, 'acquire').mockResolvedValue(undefined);
  expect((await runQueryOptimization(input, deps)).status).toBe('achieved');
  expect(hasKey ? withKey : withoutKey).toHaveBeenCalledTimes(fetch.mock.calls.length);
  expect(hasKey ? withoutKey : withKey).not.toHaveBeenCalled();
});
