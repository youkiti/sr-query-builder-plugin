import { runQueryOptimization, MAX_TERM_API_CALLS, type QueryOptimizationDeps, type QueryOptimizationInput } from './queryOptimizationService';

function fixture(words: number, mesh: number, rounds: number) {
  const blockExpression = (block: number, version: number) => [
    ...Array.from({ length: words }, (_, i) => `b${block}v${version}word${i}[tiab]`),
    ...Array.from({ length: mesh }, (_, i) => `"Mesh${block}term${i}"[Mesh]`),
  ].join(' OR ');
  const input: QueryOptimizationInput = { projectId: 'p', runId: 'r', maxHits: 100,
    seedPmids: ['11'], maxIterations: rounds,
    initialFormula: { blocks: [...Array.from({ length: 4 }, (_, i) => ({ id: String(i + 1), expression: blockExpression(i + 1, 0), isCombination: false })),
      { id: '5', expression: '#1 AND #2 AND #3 AND #4', isCombination: true }], combinationExpression: '#1 AND #2 AND #3 AND #4' },
    approvedBlocks: Array.from({ length: 4 }, (_, i) => ({ id: String(i + 1), approvedBlockId: String(i + 1), label: '疾患' })),
    criteria: { researchQuestion: 'RQ', inclusionCriteria: '', exclusionCriteria: '' },
  };
  const queries: string[] = [];
  const fetch = jest.fn(async (url) => {
    const query = new URL(String(url)).searchParams.get('term')!;
    queries.push(query);
    const version = Number(/b1v(\d+)word/.exec(query)?.[1] ?? '0');
    const count = query.includes('[uid]') ? 1 : query.includes(' NOT ') ? version + 1 : 100 + (rounds - version) * 100;
    return { ok: true, status: 200, json: async () => ({ esearchresult: { count: String(count), idlist: ['11'] } }) } as Response;
  });
  let version = 0;
  const chat = jest.fn(async () => ({ text: JSON.stringify({ target_block_id: '1', proposed_expression: blockExpression(1, ++version),
    added_terms: [], removed_terms: [], replaced_terms: [], rationale: '基準を維持して調整', measurement_ids: [], mesh_requests: [] }),
    tokensIn: null, tokensOut: null, raw: {} }));
  const deps: QueryOptimizationDeps = { measureTermDetails: true,
    eutils: { fetch, maxRetries: 0, rateLimiter: { acquire: async () => undefined } },
    llmFactory: { model: 'fake', forPurpose: () => ({ providerId: 'gemini', model: 'fake', chat }) },
    checkpoint: { read: async () => undefined, write: async () => undefined },
  };
  return { input, deps, queries, chat };
}

test('F=40 B=4 M=8 で5候補と最終再検証を200通信以内に収め、実測済み候補を失わない', async () => {
  const f = fixture(10, 2, 5);
  const result = await runQueryOptimization(f.input, f.deps);
  expect(result.status).toBe('achieved');
  expect(result.trials.filter((trial) => trial.kind === 'proposal' && trial.accepted)).toHaveLength(5);
  expect(result.trials.map((trial) => trial.kind)).toEqual(['initial', 'proposal', 'proposal', 'proposal', 'proposal', 'proposal', 'final']);
  expect(result.apiCalls).toBe(MAX_TERM_API_CALLS + 7 * (4 + 2) + 5);
  expect(result.apiCalls).toBeLessThan(200);
  expect(result.best?.formula.blocks[0]?.expression).toContain('b1v5word');
  expect(result.unmetReasons.join(' ')).toContain('未測定');
  expect(result.trials[1]?.after?.terms?.find((term) => term.query === 'b1v1word0[tiab]')?.hits).toBeNull();
});

test('不変ブロックの単独・累積・MeSH をrun内で再利用し、固有寄与は最終式ごとに測る', async () => {
  const f = fixture(2, 1, 2);
  const first = await runQueryOptimization(f.input, f.deps);
  expect(first.status).toBe('achieved');
  for (const query of ['b2v0word0[tiab]', '"Mesh2term0"[Mesh]']) {
    expect(f.queries.filter((value) => value === query)).toHaveLength(1);
  }
  const cumulative = f.queries.filter((query) => query.includes('b2v0word0') && query.includes('b2v0word1')
    && !query.includes('Mesh') && !query.includes('NOT') && !query.includes('[uid]'));
  expect(cumulative).toHaveLength(1);
  const contributions = first.trials.filter((trial) => trial.kind === 'proposal')
    .map((trial) => trial.after?.terms?.find((term) => term.query === 'b2v0word0[tiab]')?.finalContribution);
  expect(contributions).toEqual([2, 3]);
  // 別runにはキャッシュを持ち越さない。
  f.input.runId = 'another';
  await runQueryOptimization(f.input, { ...f.deps, llmFactory: { model: 'fake', forPurpose: () => ({ providerId: 'gemini', model: 'fake',
    chat: async () => ({ text: JSON.stringify({ target_block_id: '1', proposed_expression: f.input.initialFormula.blocks[0]!.expression,
      added_terms: [], removed_terms: [], replaced_terms: [], rationale: '', measurement_ids: [], mesh_requests: [] }), tokensIn: null, tokensOut: null, raw: {} }) }) } });
  expect(f.queries.filter((query) => query === '"Mesh2term0"[Mesh]')).toHaveLength(2);
});

test('追加詳細の途中で停止しても実測済みの候補を履歴とbestに残す', async () => {
  const f = fixture(2, 1, 2);
  let stop = false;
  f.deps.onProgress = (progress) => {
    if (progress.step === 'measuring' && progress.task?.kind === 'terms') stop = true;
  };
  f.deps.shouldStop = () => stop;
  const result = await runQueryOptimization(f.input, f.deps);
  expect(result.status).toBe('stopped');
  expect(result.trials[1]).toMatchObject({ kind: 'proposal', accepted: true, after: { totalHits: 200 } });
  expect(result.best?.formula.blocks[0]?.expression).toContain('b1v1word');
});


test('全体の通信上限に候補の詳細計測中に達しても、実測済みの採用候補を保持する', async () => {
  const f = fixture(2, 1, 2);
  // 初期評価6回・初期詳細24回・AI1回・候補評価6回の後、追加詳細1回で上限に達する。
  const result = await runQueryOptimization(f.input, { ...f.deps, maxApiCalls: 38 });
  expect(result.status).toBe('needs_review');
  expect(result.stopReason).toBe('api_budget');
  expect(result.apiCalls).toBe(38);
  expect(result.trials[1]).toMatchObject({ kind: 'proposal', accepted: true, after: { totalHits: 200 } });
  expect(result.best?.formula.blocks[0]?.expression).toContain('b1v1word');
});
