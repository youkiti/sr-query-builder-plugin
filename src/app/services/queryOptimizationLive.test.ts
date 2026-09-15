import { runQueryOptimization, type QueryOptimizationDeps, type QueryOptimizationInput, type QueryOptimizationProgress } from './queryOptimizationService';
import { withRetry } from '@/lib/llm/retry';
import { LlmProviderError } from '@/lib/llm/LLMProvider';
import type { OptimizationMeshNode } from '@/features/formula/skills/optimizeQuery';

function fixture() {
  const input: QueryOptimizationInput = {
    projectId: 'p', runId: 'r', maxHits: 5, maxIterations: 2, seedPmids: ['11', '22'],
    initialFormula: { blocks: [{ id: '1', expression: 'a[tiab]', isCombination: false }], combinationExpression: null },
    approvedBlocks: [{ id: '1', approvedBlockId: '1', label: '疾患' }],
    criteria: { researchQuestion: 'RQ', inclusionCriteria: '組入', exclusionCriteria: '除外' },
  };
  const fetch = jest.fn(async (url?: unknown) => {
    const impact = url !== undefined && new URL(String(url)).searchParams.get('term')!.includes(') NOT (');
    return { ok: true, status: 200, json: async () => ({
      esearchresult: impact ? { count: '0', idlist: [] } : { count: '10', idlist: ['11', '22'] },
    }) } as Response;
  });
  const proposal = { target_block_id: '1', proposed_expression: 'b[tiab]', rationale: '基準に合わせて修正',
    added_terms: [], removed_terms: [], replaced_terms: [{ before: 'a[tiab]', after: 'b[tiab]' }],
    measurement_ids: ['r:initial'], mesh_requests: [] as { descriptor: string; tree_number: string }[] };
  const response = () => ({ text: JSON.stringify(proposal), tokensIn: null, tokensOut: null, raw: {} });
  const chat = jest.fn(async () => response());
  const deps: QueryOptimizationDeps = {
    eutils: { fetch, sleep: async () => undefined, maxRetries: 1, rateLimiter: { acquire: async () => undefined } },
    llmFactory: { model: 'test', forPurpose: (_purpose, onRequestState, attempts) => withRetry({ providerId: 'gemini', model: 'test', chat }, { ...attempts, onRequestState }) },
    checkpoint: { read: async () => undefined, write: async () => undefined }, now: () => 1000,
  };
  return { input, deps, fetch, proposal, chat, response };
}

test('情報要求は試行数に含めず、変更語と要求の参照だけを試行に保持し、ツリーは run 単位で通知する', async () => {
  const f = fixture();
  f.chat.mockImplementationOnce(async () => ({ ...f.response(), text: JSON.stringify({ ...f.proposal,
    mesh_requests: [{ descriptor: 'Asthma', tree_number: '' }] }) }));
  const node = { id: 'D1', descriptor: 'Asthma', label: 'Asthma', treeNumbers: ['C01'], parentIds: [], childIds: ['D2'], explode: true, note: '直下のみ' };
  const progress: QueryOptimizationProgress[] = [];
  const contexts: OptimizationMeshNode[][] = [];
  const result = await runQueryOptimization(f.input, { ...f.deps, fetchMeshContext: async () => [node],
    onMeshContext: (nodes) => contexts.push(nodes),
    onProgress: (p) => { progress.push(p); if (p.trial?.changes) p.trial.changes.replacedTerms[0]!.after = '破損'; } });
  expect(result.iterations).toBe(2);
  expect(progress[progress.length - 1]?.evaluatedTrials).toBe(1);
  expect(result.trials[1]).toMatchObject({ kind: 'information', after: null, meshRequests: [{ descriptor: 'Asthma', treeNumber: '' }] });
  expect(result.trials[2]).toMatchObject({ kind: 'proposal', changes: { replacedTerms: [{ before: 'a[tiab]', after: 'b[tiab]' }] } });
  expect(contexts).toEqual([[], [node]]);
  for (const trial of result.trials) expect(trial).not.toHaveProperty('meshContext');
});

test('生成する全試行の kind と apiEvents を設定し、変更案には changes を必ず持たせる', async () => {
  const f = fixture();
  f.chat.mockImplementationOnce(async () => ({ ...f.response(), text: JSON.stringify({ ...f.proposal,
    mesh_requests: [{ descriptor: 'Asthma', tree_number: '' }] }) }));
  f.deps.eutils.fetch = jest.fn(async (url) => {
    const term = new URL(String(url)).searchParams.get('term')!;
    return { ok: true, status: 200, json: async () => ({ esearchresult: term.includes(') NOT (')
      ? { count: '0', idlist: [] }
      : { count: term.includes('b[tiab]') ? '5' : '10', idlist: ['11', '22'] },
    }) } as Response;
  });
  const result = await runQueryOptimization(f.input, f.deps);
  expect(result.trials.map((trial) => trial.kind)).toEqual(['initial', 'information', 'proposal', 'final']);
  for (const trial of result.trials) {
    expect(Array.isArray(trial.apiEvents)).toBe(true);
    if (trial.kind === 'proposal') expect(trial.changes).toEqual({ targetBlockId: '1', addedTerms: [], removedTerms: [],
      replacedTerms: [{ before: 'a[tiab]', after: 'b[tiab]' }] });
  }
});

test('run の文脈通知を変更したり例外を投げたりしても、次の取得結果や候補評価を変えない', async () => {
  const f = fixture();
  const parent: OptimizationMeshNode = { id: 'D1', descriptor: 'Parent', label: 'Parent', treeNumbers: ['C01'],
    parentIds: [], childIds: ['D2'], explode: true, note: '親' };
  const child: OptimizationMeshNode = { id: 'D2', descriptor: 'Child', label: 'Child', treeNumbers: ['C01.001'],
    parentIds: ['D1'], childIds: [], explode: false, note: '子' };
  f.input.meshContext = [parent];
  f.chat.mockImplementationOnce(async () => ({ ...f.response(), text: JSON.stringify({ ...f.proposal,
    mesh_requests: [{ descriptor: 'Parent', tree_number: '' }] }) }));
  const snapshots: OptimizationMeshNode[][] = [];
  const result = await runQueryOptimization(f.input, { ...f.deps, fetchMeshContext: async () => [child],
    onMeshContext: (nodes) => {
      snapshots.push(JSON.parse(JSON.stringify(nodes)) as OptimizationMeshNode[]);
      nodes[0]!.label = '破損';
      nodes[0]!.childIds.push('破損');
      throw new Error('表示側の失敗');
    },
  });
  expect(snapshots).toEqual([[parent], [parent, child]]);
  expect(result.stopReason).toBe('iteration_limit');
  expect(result.trials).toHaveLength(3);
});

test('通信再試行とレート調整・取得失敗を分離し、試行数に加算しない', async () => {
  const f = fixture();
  f.fetch.mockResolvedValueOnce({ ok: false, status: 503 } as Response);
  f.deps.eutils.rateLimiter = { acquire: async (onWait) => { onWait?.(); } };
  const progress: QueryOptimizationProgress[] = [];
  const result = await runQueryOptimization(f.input, { ...f.deps, onProgress: (p) => progress.push(p) });
  expect(result.trials[0]?.apiEvents).toEqual(expect.arrayContaining([
    { source: 'PubMed', status: 'rate_limit' }, { source: 'PubMed', status: 'retry' },
  ]));
  expect(progress[progress.length - 1]?.evaluatedTrials).toBe(2);
  expect(progress.some((p) => p.apiWaiting?.status === 'retry')).toBe(true);
  const failing = fixture();
  failing.fetch.mockResolvedValue({ ok: false, status: 503 } as Response);
  const failed = await runQueryOptimization(failing.input, failing.deps);
  expect(failed.trials[0]?.after?.totalHits).toBeNull();
  expect(failed.trials[0]?.apiEvents).toContainEqual({ source: 'PubMed', status: 'failure' });
});

test.each([false, true])('固定作業は確認済みの総数で通知し、最良候補の値は却下候補から更新しない（詳細計測=%s）', async (measureTermDetails) => {
  const f = fixture();
  const progress: QueryOptimizationProgress[] = [];
  const result = await runQueryOptimization(f.input, { ...f.deps, measureTermDetails, onProgress: (p) => progress.push(p) });
  const total = measureTermDetails ? 2 : 1;
  expect(progress.map((p) => p.task)).toEqual(expect.arrayContaining([
    ...Array.from({ length: total + 1 }, (_, completed) => ({ kind: 'terms', completed, total })),
    { kind: 'seeds', completed: 0, total: 2 }, { kind: 'seeds', completed: 2, total: 2 },
  ]));
  expect(result.trials[1]?.accepted).toBe(false);
  expect(progress[progress.length - 1]?.bestTotalHits).toBe(10);
});

test('AI 内部の再試行も取得イベントに記録し、修正案の試行数に加えない', async () => {
  const f = fixture();
  f.chat.mockRejectedValueOnce(new LlmProviderError('再試行', 'gemini', 503, ''));
  f.deps.llmFactory.forPurpose = (_purpose, onRequestState, attempts) => withRetry({ providerId: 'gemini', model: 'test', chat: f.chat },
    { ...attempts, onRequestState, sleep: async () => undefined });
  const progress: QueryOptimizationProgress[] = [];
  const result = await runQueryOptimization(f.input, { ...f.deps, onProgress: (p) => progress.push(p) });
  expect(f.chat).toHaveBeenCalledTimes(3);
  expect(progress[progress.length - 1]?.evaluatedTrials).toBe(2);
  expect(result.trials[1]?.apiEvents).toContainEqual({ source: 'AI', status: 'retry' });
});

test('詳細計測は明示した実行だけで行い、累積 OR 増分とは別の最終式の寄与を測る', async () => {
  const plain = fixture();
  const basic = await runQueryOptimization(plain.input, plain.deps);
  expect(basic.trials[1]?.before?.terms?.[0]?.finalContribution).toBeUndefined();
  const detailed = fixture();
  const queries: string[] = [];
  detailed.deps.eutils.fetch = jest.fn(async (url) => {
    const query = new URL(String(url)).searchParams.get('term')!;
    queries.push(query);
    return { ok: true, status: 200, json: async () => ({ esearchresult: {
      count: query.includes(' NOT ') ? '3' : '10', idlist: ['11', '22'],
    } }) } as Response;
  });
  const result = await runQueryOptimization(detailed.input, { ...detailed.deps, measureTermDetails: true });
  expect(queries).toContain('(a[tiab]) NOT ((a[tiab] NOT a[tiab]))');
  expect(result.trials[1]?.before?.terms?.[0]).toMatchObject({ hits: 10, delta: 10, finalContribution: 3 });
  expect(result.trials[1]?.after?.terms?.[0]).toMatchObject({ query: 'b[tiab]', finalContribution: 3 });
});

test('追加計測の失敗は固有寄与ゼロにしない', async () => {
  const f = fixture();
  f.deps.eutils.fetch = jest.fn(async (url) => {
    const query = new URL(String(url)).searchParams.get('term')!;
    return query.includes(' NOT ') ? { ok: false, status: 500 } as Response : f.fetch();
  });
  const result = await runQueryOptimization(f.input, { ...f.deps, measureTermDetails: true });
  expect(result.trials[1]?.before?.terms?.[0]?.finalContribution).toBeNull();
});

test('AND を含む概念行の固有寄与を推測せず、詳細取得失敗でも実測候補の履歴を残す', async () => {
  const f = fixture();
  f.input.initialFormula.blocks[0]!.expression = 'a[tiab] AND c[tiab]';
  f.proposal.proposed_expression = 'b[tiab] OR "Disease"[Mesh]';
  f.deps.eutils.fetch = jest.fn(async (url) => {
    const query = new URL(String(url)).searchParams.get('term')!;
    return query === '"Disease"[Mesh]' ? { ok: false, status: 500 } as Response : f.fetch();
  });
  const result = await runQueryOptimization(f.input, { ...f.deps, measureTermDetails: true });
  expect(result.trials[1]?.before?.terms?.every((term) => term.finalContribution === null)).toBe(true);
  expect(result.trials[1]?.after?.totalHits).toBe(10);
  expect(result.trials[1]?.after?.terms).toBeUndefined();
  expect(result.trials[1]?.apiEvents).toContainEqual({ source: 'PubMed', status: 'failure' });
});

test('進捗 callback の未指定・例外で候補、通信数、停止理由を変えない', async () => {
  jest.useFakeTimers({ now: 1000 });
  try {
    const plain = fixture();
    const expected = await runQueryOptimization(plain.input, plain.deps);
    const observed = fixture();
    const result = await runQueryOptimization(observed.input, { ...observed.deps, onProgress: () => { throw new Error('表示失敗'); } });
    expect(result).toEqual(expected);
    expect(observed.fetch).toHaveBeenCalledTimes(plain.fetch.mock.calls.length);
  } finally { jest.useRealTimers(); }
});
