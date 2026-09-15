import { withRetry } from '@/lib/llm/retry';
import { withSignalDeadline } from '@/lib/llm/signalDeadline';
import { createSetSearch } from '../../../tests/fixtures/pubmedSets';
import { isImprovement, runQueryOptimization, QueryOptimizationStopError,
  type QueryOptimizationDeps, type QueryOptimizationInput } from './queryOptimizationService';
import { expandFormula } from '@/features/validation/expandFormula';

const disease = { id: '1', expression: 'disease[tiab] OR synonym[tiab]' };
const intervention = { id: '2', expression: 'intervention[tiab] OR therapy[tiab]' };

function fixture(proposals = [disease, intervention], seeds = ['11', '22'], blockCount = 2) {
  // 両概念とも 22 を落とす。語の追加でそれぞれ拾えるが、AND の最終式には両方の追加が要る。
  const mapping: Record<string, string[]> = {
    'disease[tiab]': ['11', '901'], 'intervention[tiab]': ['11', '902'],
    'population[tiab]': ['11', '904'], 'participants[tiab]': ['22'],
    'synonym[tiab]': ['22'], 'therapy[tiab]': ['22'], 'extra[tiab]': ['33'], 'irrelevant[tiab]': ['903'],
  };
  const sets = createSetSearch((query) => mapping[query]);
  const input: QueryOptimizationInput = {
    projectId: 'p', runId: 'intermediate', maxHits: 10, maxIterations: proposals.length, seedPmids: seeds,
    criteria: { researchQuestion: '研究', inclusionCriteria: '', exclusionCriteria: '' },
    approvedBlocks: [{ id: '1', approvedBlockId: 'd', label: '疾患' }, { id: '2', approvedBlockId: 'i', label: '介入' }],
    initialFormula: { blocks: [
      { id: '1', expression: 'disease[tiab]', isCombination: false },
      { id: '2', expression: 'intervention[tiab]', isCombination: false },
      { id: '3', expression: '#1 AND #2', isCombination: true },
    ], combinationExpression: '#1 AND #2' },
  };
  if (blockCount === 3) {
    input.approvedBlocks.push({ id: '4', approvedBlockId: 'p', label: '対象集団' });
    input.initialFormula.blocks.splice(2, 0, { id: '4', expression: 'population[tiab]', isCombination: false });
    input.initialFormula.blocks[3]!.expression = '#1 AND #2 AND #4';
    input.initialFormula.combinationExpression = '#1 AND #2 AND #4';
  }
  const events: { round: number; query: string }[] = [];
  let round = 0;
  const fetch = jest.fn(async (resource, init?: RequestInit) => {
    const url = new URL(String(resource));
    if (url.pathname.includes('efetch')) return { ok: true, status: 200, text: async () => '<PubmedArticleSet/>' } as Response;
    const params = init?.method === 'POST' ? new URLSearchParams(init.body as string) : url.searchParams;
    const query = params.get('term')!;
    events.push({ round, query });
    return { ok: true, status: 200, json: async () => ({ esearchresult: sets.search(query, Number(params.get('retmax') ?? 20)) }) } as Response;
  });
  const chat = jest.fn(async () => {
    const proposal = proposals[round++]!;
    return { text: JSON.stringify({ target_block_id: proposal.id, proposed_expression: proposal.expression,
      added_terms: [], removed_terms: [], replaced_terms: [], mesh_requests: [], rationale: '同義語で回収する' }),
    tokensIn: null, tokensOut: null, raw: {} };
  });
  const deps: QueryOptimizationDeps = {
    eutils: { fetch, maxRetries: 0, rateLimiter: { acquire: async () => undefined } },
    llmFactory: { model: 'fake', forPurpose: (_purpose, onRequestState, attempts) =>
      withRetry(withSignalDeadline({ providerId: 'gemini', model: 'fake', chat }), { ...attempts, onRequestState }) },
    checkpoint: { read: async () => undefined, write: async () => undefined },
  };
  return { input, deps, sets, events, fetch, chat };
}

const proposalsOf = (result: Awaited<ReturnType<typeof runQueryOptimization>>) => result.trials.filter((trial) => trial.kind === 'proposal');

test('疾患の中間手を採用し、その式から介入を直して両ブロックで漏れていたシードを回収する', async () => {
  const f = fixture();
  const result = await runQueryOptimization(f.input, f.deps);
  const [first, second] = proposalsOf(result);
  expect(result).toMatchObject({ status: 'achieved', stopReason: 'conditions_met', iterations: 2 });
  expect(first).toMatchObject({ accepted: true, before: { capturedPmids: ['11'] }, after: { capturedPmids: ['11'] },
    impact: { lostHits: 0, gainedHits: 0 } });
  expect(first!.reason).toContain('ブロック #1 のシード捕捉が 1 件から 2 件に増えました');
  expect(first!.reason).toContain('中間手を採用');
  expect(first!.before!.seedCapture!.rows.slice(0, 2).map((row) => row.capturedPmids)).toEqual([['11'], ['11']]);
  expect(first!.after!.seedCapture!.rows.map((row) => row.capturedPmids)).toEqual([['11', '22'], ['11'], ['11']]);
  expect(second).toMatchObject({ accepted: true, before: { capturedPmids: ['11'] }, after: { capturedPmids: ['11', '22'] },
    impact: { lostHits: 0, gainedHits: 1 } });
  expect(second!.formula.blocks[0]!.expression).toBe(disease.expression);
  expect(second!.before!.fingerprint).toBe(first!.after!.fingerprint);
  expect(second!.reason).toContain('ブロック #2 のシード捕捉が 1 件から 2 件に増えました');
  expect(result.best!.measurement.capturedPmids).toEqual(['11', '22']);
  // 同じ集合の最終捕捉数を旧判定に渡すと、中間手は却下される。
  expect(first!.after!.capturedPmids!.length > first!.before!.capturedPmids!.length).toBe(false);
  const interventionOnly = { ...f.input.initialFormula, blocks: f.input.initialFormula.blocks.map((block) =>
    block.id === '2' ? { ...block, expression: intervention.expression } : block) };
  expect(f.sets.lookup(expandFormula(interventionOnly))).toEqual(['11']);
  // 差集合が始まるまでの追加捕捉測定は、最終式の検証に加えて対象の 1 行だけ。
  for (const [index, trial] of [first!, second!].entries()) {
    const queries = f.events.filter((event) => event.round === index + 1).map((event) => event.query);
    const captures = queries.slice(0, queries.findIndex((query) => query.includes(') NOT (')))
      .filter((query) => query.includes('[uid]'));
    expect(captures).toEqual([
      `(${expandFormula(trial.formula)}) AND (11[uid] OR 22[uid])`,
      `(${expandFormula(trial.formula, trial.changes!.targetBlockId)}) AND (11[uid] OR 22[uid])`,
    ]);
  }
  // 採用後も対象行は再取得せず、残りの捕捉表を補う。
  expect(f.events.filter((event) => event.round === 1 && event.query === `(${disease.expression}) AND (11[uid] OR 22[uid])`)).toHaveLength(1);
  expect(result.apiCalls).toBe(f.fetch.mock.calls.length + f.chat.mock.calls.length);
});

test('対象ブロックのシード捕捉を増やさない追加は却下し、他ブロックの捕捉で代用しない', async () => {
  const f = fixture([{ id: '1', expression: 'disease[tiab] OR irrelevant[tiab]' }]);
  const result = await runQueryOptimization(f.input, f.deps);
  const [trial] = proposalsOf(result);
  expect(trial).toMatchObject({ accepted: false, reason: '局面の指標に改善がありません' });
  expect(trial!.impact).toBeUndefined();
  expect(trial!.after!.seedCapture).toBeUndefined();
  const targetCount = f.sets.search(`(${expandFormula(trial!.formula, '1')}) AND (11[uid] OR 22[uid])`).idlist.length;
  expect(isImprovement(trial!.before!, trial!.after!, 10, 1, targetCount)).toBe(false);
  expect(f.events.filter((event) => event.round === 1 && event.query.includes('[uid]'))).toHaveLength(2);
});

test.each(['missing', 'null', 'candidate_failure'] as const)('捕捉表が %s なら同じ集合の最終捕捉増加へフォールバックする', async (kind) => {
  const f = fixture();
  const trials = proposalsOf(await runQueryOptimization(f.input, f.deps));
  for (const [index, trial] of trials.entries()) {
    const target = trial.changes!.targetBlockId;
    const beforeCount = kind === 'missing' || kind === 'null' ? undefined
      : trial.before!.seedCapture!.rows.find((row) => row.blockId === target)!.capturedPmids!.length;
    const afterCount = kind === 'candidate_failure' ? undefined
      : f.sets.search(`(${expandFormula(trial.formula, target)}) AND (11[uid] OR 22[uid])`).idlist.length;
    expect(isImprovement(trial.before!, trial.after!, 10, beforeCount, afterCount)).toBe(index === 1);
  }
});

test.each(['before', 'after'] as const)('対象行の通信失敗（%s）では中間手を採用せず、最終捕捉が増える候補は採用する', async (side) => {
  for (const alreadyCaptures of [false, true]) {
    const f = fixture([disease]);
    if (alreadyCaptures) f.input.initialFormula.blocks[1]!.expression = intervention.expression;
    const failedQuery = `(${side === 'before' ? 'disease[tiab]' : disease.expression}) AND (11[uid] OR 22[uid])`;
    f.deps.eutils.fetch = async (resource, init) => {
      const query = new URL(String(resource)).searchParams.get('term');
      if (query === failedQuery) throw new Error('対象行の測定失敗');
      return f.fetch(resource, init);
    };
    const result = await runQueryOptimization(f.input, f.deps);
    const [trial] = proposalsOf(result);
    expect(trial!.accepted).toBe(alreadyCaptures);
    if (side === 'before') {
      const measurement = trial!.before!;
      expect(measurement.seedCapture!.rows.find((row) => row.blockId === '1')).toMatchObject({
        capturedPmids: null, error: '対象行の測定失敗',
      });
    } else {
      expect(trial!.after!.seedCapture).toBeUndefined();
      expect(trial!.apiEvents).toContainEqual({ source: 'PubMed', status: 'failure' });
    }
  }
});

test('ブロックの捕捉が増えても最終捕捉数が減る候補は改善としない', async () => {
  const f = fixture([disease]);
  const [trial] = proposalsOf(await runQueryOptimization(f.input, f.deps));
  expect(isImprovement(trial!.before!, { ...trial!.after!, capturedPmids: [] }, 10, 1, 2)).toBe(false);
});

test('最終捕捉数が増えない採用が2回続いたら、最良式と中間手の未達理由を残して止める', async () => {
  const f = fixture([disease, { id: '1', expression: `${disease.expression} OR extra[tiab]` }, intervention], ['11', '22', '33']);
  const result = await runQueryOptimization(f.input, f.deps);
  expect(result).toMatchObject({ status: 'needs_review', stopReason: 'seed_capture_stalled', iterations: 2 });
  expect(proposalsOf(result).map((trial) => trial.accepted)).toEqual([true, true]);
  expect(result.best!.measurement.capturedPmids).toEqual(['11']);
  expect(result.best!.formula.blocks[0]!.expression).toContain('extra[tiab]');
  expect(result.unmetReasons).toContain(new QueryOptimizationStopError('seed_capture_stalled').message);
  expect(result.unmetReasons.join(' ')).toContain('中間手を承認済みブロック数と同じ回数続けて採用しましたが、最終式の捕捉数が増えなかった');
  expect(f.chat).toHaveBeenCalledTimes(2);
});

test('最終捕捉が増えた採用で中間手の連続回数を戻す', async () => {
  const f = fixture([disease, intervention, { id: '1', expression: `${disease.expression} OR extra[tiab]` },
    { id: '2', expression: `${intervention.expression} OR extra[tiab]` }], ['11', '22', '33']);
  const result = await runQueryOptimization(f.input, f.deps);
  expect(result).toMatchObject({ status: 'achieved', iterations: 4 });
  expect(proposalsOf(result).map((trial) => trial.after!.capturedPmids!.length)).toEqual([1, 2, 2, 3]);
  expect(proposalsOf(result).every((trial) => trial.accepted)).toBe(true);
});


test.each(['terms', 'capture'] as const)('採用後の %s 計測が停止したら部分表を保存せず、捕捉の診断を判定不能にする', async (stage) => {
  const f = fixture([disease]);
  let stop = false;
  if (stage === 'terms') {
    f.deps.measureTermDetails = true;
    f.deps.onProgress = (progress) => {
      if (progress.iterations === 1 && progress.task?.kind === 'terms') stop = true;
    };
  } else {
    f.deps.eutils.fetch = async (resource, init) => {
      const response = await f.fetch(resource, init);
      const query = new URL(String(resource)).searchParams.get('term');
      if (f.chat.mock.calls.length === 1 && query === '(intervention[tiab]) AND (11[uid] OR 22[uid])') stop = true;
      return response;
    };
  }
  f.deps.shouldStop = () => stop;
  const result = await runQueryOptimization(f.input, f.deps);
  expect(stop).toBe(true);
  expect(result).toMatchObject({ status: 'stopped', stopReason: 'user_stop' });
  expect(proposalsOf(result)[0]).toMatchObject({ accepted: true, after: { capturedPmids: ['11'] } });
  expect(proposalsOf(result)[0]!.reason).toContain('中間手を採用');
  expect(proposalsOf(result)[0]!.after!.seedCapture).toBeUndefined();
  expect(result.best!.formula.blocks[0]!.expression).toBe(disease.expression);
  expect(result.best!.measurement.seedCapture).toBeUndefined();
  expect(result.seedDiagnoses).toEqual([expect.objectContaining({ pmid: '22', blockingBlockIds: null,
    recoverableByTerms: null, note: expect.stringContaining('捕捉表が未測定のため判定不能') })]);
  expect(result.seedDiagnoses![0]!.note).not.toContain('全概念ブロックが捕捉している');
  expect(result.unmetReasons.join(' ')).not.toContain('語の調整では回収できない');
});

test('3ブロックすべてで漏れるシードを3回の修正で回収し、中間手2回では停止しない', async () => {
  const population = { id: '4', expression: 'population[tiab] OR participants[tiab]' };
  const f = fixture([disease, intervention, population], ['11', '22'], 3);
  const result = await runQueryOptimization(f.input, f.deps);
  const trials = proposalsOf(result);
  expect(result).toMatchObject({ status: 'achieved', stopReason: 'conditions_met', iterations: 3 });
  expect(trials.map((trial) => trial.accepted)).toEqual([true, true, true]);
  expect(trials.map((trial) => trial.after!.capturedPmids)).toEqual([['11'], ['11'], ['11', '22']]);
  expect(trials.slice(0, 2).map((trial) => trial.after!.seedCapture!.rows.length)).toEqual([4, 4]);
  expect(trials[0]!.before!.seedCapture!.rows.map((row) => row.capturedPmids)).toEqual([['11'], ['11'], ['11'], ['11']]);
  expect(trials[2]!.formula.blocks.filter((block) => !block.isCombination).map((block) => block.expression))
    .toEqual([disease.expression, intervention.expression, population.expression]);
  expect(result.best!.measurement.missedPmids).toEqual([]);
  expect(f.chat).toHaveBeenCalledTimes(3);
});

test('承認ブロックが1件なら中間手1回で停止し、固定ブロックによる未捕捉を残す', async () => {
  const f = fixture([disease, intervention]);
  f.input.approvedBlocks = [f.input.approvedBlocks[0]!];
  const result = await runQueryOptimization(f.input, f.deps);
  expect(result).toMatchObject({ status: 'needs_review', stopReason: 'seed_capture_stalled', iterations: 1 });
  expect(proposalsOf(result)[0]!.accepted).toBe(true);
  expect(result.best!.measurement.capturedPmids).toEqual(['11']);
  expect(f.chat).toHaveBeenCalledTimes(1);
});
