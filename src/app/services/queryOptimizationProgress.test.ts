import { withRetry } from '@/lib/llm/retry';
import { runQueryOptimization, type QueryOptimizationDeps, type QueryOptimizationProgress } from './queryOptimizationService';
import type { QueryOptimizationInput } from './queryOptimizationService';

function setup() {
  const input: QueryOptimizationInput = {
    projectId: 'p', runId: 'r', maxHits: 100, seedPmids: ['11'],
    initialFormula: { blocks: [{ id: '1', expression: 'a[tiab]', isCombination: false }], combinationExpression: null },
    approvedBlocks: [{ id: '1', approvedBlockId: '1', label: '疾患' }],
    criteria: { researchQuestion: 'RQ', inclusionCriteria: '組入', exclusionCriteria: '除外' },
  };
  const fetch = jest.fn().mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({
    esearchresult: { count: '1', idlist: ['11'] },
  }) }));
  const chat = jest.fn(async () => ({ text: JSON.stringify({ target_block_id: '1', proposed_expression: 'a[tiab]',
    rationale: '維持', added_terms: [], removed_terms: [], replaced_terms: [], measurement_ids: ['r:initial'] }),
  tokensIn: null, tokensOut: null, raw: {} }));
  const write = jest.fn(async () => undefined);
  const deps: QueryOptimizationDeps = {
    eutils: { fetch, maxRetries: 0, rateLimiter: { acquire: async () => undefined } },
    llmFactory: { model: 'test', forPurpose: (_purpose, onRequestState, attempts) => withRetry({ providerId: 'gemini', model: 'test', chat }, { ...attempts, onRequestState }) },
    checkpoint: { read: async () => undefined, write }, now: () => 1000,
  };
  return { input, deps, fetch, chat, write };
}

afterEach(() => jest.useRealTimers());

test('段階と確定した各試行を通知し、通知の有無・例外で結果や通信数を変えない', async () => {
  jest.useFakeTimers({ now: 1000 });
  const plain = setup();
  const expected = await runQueryOptimization(plain.input, plain.deps);
  expect(expected.status).toBe('achieved');
  const progress: QueryOptimizationProgress[] = [];
  for (const throwing of [false, true]) {
    const fixture = setup();
    const result = await runQueryOptimization(fixture.input, { ...fixture.deps, onProgress: (p) => {
      progress.push(p);
      if (throwing) throw new Error('表示側の失敗');
    } });
    expect(result).toEqual(expected);
    expect(fixture.fetch).toHaveBeenCalledTimes(plain.fetch.mock.calls.length);
    expect(fixture.chat).toHaveBeenCalledTimes(plain.chat.mock.calls.length);
    expect(fixture.write).toHaveBeenCalledTimes(plain.write.mock.calls.length);
  }
  expect(progress.filter((p) => p.trial).map((p) => p.trial!.candidateId)).toEqual([
    'initial', 'candidate-1', 'final-1', 'initial', 'candidate-1', 'final-1',
  ]);
  expect(progress.map((p) => p.step)).toEqual(expect.arrayContaining(['measuring', 'adjusting', 'revalidating', 'review']));
  expect(progress.filter((p) => p.trial).map((p) => [p.trial!.candidateId, p.step])).toEqual([
    ['initial', 'measuring'], ['candidate-1', 'adjusting'], ['final-1', 'revalidating'],
    ['initial', 'measuring'], ['candidate-1', 'adjusting'], ['final-1', 'revalidating'],
  ]);
  expect(progress[0]).toMatchObject({ bestTotalHits: null, bestCapturedSeedCount: null });
  expect(progress[progress.length - 1]).toMatchObject({ bestTotalHits: 1, bestCapturedSeedCount: 1, iterations: 1 });
});

test('通知先が試行を書き換えても最良候補と履歴には戻らない', async () => {
  const fixture = setup();
  const result = await runQueryOptimization(fixture.input, { ...fixture.deps, onProgress: (p) => {
    if (p.trial) p.trial.formula.blocks[0]!.expression = '壊れた式';
  } });
  expect(result.best?.formula.blocks[0]?.expression).toBe('a[tiab]');
  expect(result.trials.every((t) => t.formula.blocks[0]?.expression === 'a[tiab]')).toBe(true);
});

test('試行通知で停止要求を立てると最良候補を保って停止し、AI を呼ばない', async () => {
  const fixture = setup();
  let stop = false;
  const result = await runQueryOptimization(fixture.input, { ...fixture.deps,
    shouldStop: () => stop, onProgress: (p) => { if (p.trial) stop = true; },
  });
  expect(result.status).toBe('stopped');
  expect(result.best?.measurement.totalHits).toBe(1);
  expect(fixture.chat).not.toHaveBeenCalled();
});
