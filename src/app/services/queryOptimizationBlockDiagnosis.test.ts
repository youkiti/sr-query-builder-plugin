import { withRetry } from '@/lib/llm/retry';
import { runQueryOptimization, QueryOptimizationStopError, type QueryOptimizationInput, type QueryOptimizationDeps, type QueryOptimizationProgress } from './queryOptimizationService';

function fixture(proposals = [{ id: '1', expression: 'a[tiab] AND narrow[tiab]' }]) {
  const input: QueryOptimizationInput = { projectId: 'p', runId: 'r', maxHits: 50, maxIterations: proposals.length,
    seedPmids: ['11'], criteria: { researchQuestion: '研究', inclusionCriteria: '', exclusionCriteria: '' },
    approvedBlocks: [{ id: '1', approvedBlockId: '1', label: '疾患' }, { id: '2', approvedBlockId: '2', label: '治療' }],
    initialFormula: { blocks: [{ id: '1', expression: 'a[tiab]', isCombination: false },
      { id: '2', expression: 'b[tiab]', isCombination: false }, { id: 'f', expression: 'trial[pt]', isCombination: false },
      { id: '3', expression: '#1 AND #2 AND #f', isCombination: true }], combinationExpression: '#1 AND #2 AND #f' } };
  const events: string[] = [];
  const progress: QueryOptimizationProgress[] = [];
  const fetch = jest.fn(async (resource, init?: RequestInit) => {
    const url = new URL(String(resource));
    const params = init?.method === 'POST' ? new URLSearchParams(init.body as string) : url.searchParams;
    const query = params.get('term') ?? '';
    events.push(query);
    let count = 210;
    if (query.includes(') NOT (')) {
      const lost = params.get('retmax') !== '0' && query.split(') NOT (')[1]?.includes('held');
      count = lost ? 1 : 0;
    } else if (query.includes('[uid]')) count = 1;
    else if (query.includes('a[tiab]') && query.includes('b[tiab]')) count = query.includes('held') ? 100 : query.includes('narrow') ? 180 : 200;
    return { ok: true, status: 200, json: async () => ({ esearchresult: { count: String(count), idlist: query.includes('[uid]') ? ['11'] : [] } }),
      text: async () => '<PubmedArticleSet/>' } as Response;
  });
  let index = 0;
  const chat = jest.fn(async () => {
    events.push('AI');
    const proposal = proposals[index++]!;
    return { text: JSON.stringify({ target_block_id: proposal.id, proposed_expression: proposal.expression,
      added_terms: [], removed_terms: [], replaced_terms: [], mesh_requests: [], rationale: '狭める' }), tokensIn: null, tokensOut: null, raw: {} };
  });
  const write = jest.fn(async () => undefined);
  const deps: QueryOptimizationDeps = { eutils: { fetch, maxRetries: 0, rateLimiter: { acquire: async () => undefined } },
    llmFactory: { model: 'fake', forPurpose: (_purpose, onRequestState, attempts) => withRetry({ providerId: 'gemini', model: 'fake', chat }, { ...attempts, onRequestState }) },
    checkpoint: { read: async () => undefined, write }, onProgress: (p) => progress.push(p) };
  return { input, deps, fetch, chat, write, events, progress };
}

test('初期測定後・AI 前に診断し、採用後は変わった Q−i だけ再測定して保存する', async () => {
  const f = fixture();
  const result = await runQueryOptimization(f.input, f.deps);
  const without1 = '(b[tiab]) AND (trial[pt])';
  const without2 = '(a[tiab]) AND (trial[pt])';
  expect(f.events.indexOf(without1)).toBeGreaterThan(f.events.findIndex((query) => query.includes('[uid]')));
  expect(f.events.indexOf(without2)).toBeLessThan(f.events.indexOf('AI'));
  expect(f.events.filter((query) => query === without1)).toHaveLength(1);
  expect(f.events).toContain('(a[tiab] AND narrow[tiab]) AND (trial[pt])');
  expect(result.blockDiagnosis?.fingerprint).toBe(result.best?.measurement.fingerprint);
  expect(result.blockDiagnosis?.narrowing.map((row) => row.finalHits)).toEqual([180, 180]);
  expect(f.progress.some((p) => p.blockDiagnosis?.fingerprint === result.blockDiagnosis?.fingerprint)).toBe(true);
  expect(f.write).toHaveBeenLastCalledWith(expect.objectContaining({ queryOptimizationCheckpoint: expect.objectContaining({ blockDiagnosis: result.blockDiagnosis }) }));
});
test('診断ブロックへの保留を改善なしより先に判定する', async () => {
  const f = fixture([{ id: '1', expression: 'a[tiab] AND held1[tiab]' }, { id: '1', expression: 'a[tiab] AND held2[tiab]' }]);
  const result = await runQueryOptimization(f.input, f.deps);
  expect(result).toMatchObject({ status: 'needs_review', stopReason: 'diagnosed_block_held', iterations: 2 });
  expect(result.unmetReasons.join(' ')).toContain('ブロック #1 を狭める案が 2 回続けて保留');
  expect(result.unmetReasons.join(' ')).toContain('目安件数の見直し');
  const index = result.unmetReasons.indexOf('目安件数 50 件を超えています（実測 200 件）');
  expect(index).toBeGreaterThanOrEqual(0);
  expect(result.unmetReasons[index + 1]).toContain('既に捕捉している文献を失わずに件数を減らす変更は見つかりませんでした。');
  expect(result.unmetReasons[index + 2]).toBe('件数を減らす候補を 2 件保留しました（削除影響の確認を参照）。');
});
test('別ブロックの採用で改善なしがゼロに戻っても保留の連続は続く', async () => {
  const f = fixture([{ id: '1', expression: 'a[tiab] AND held1[tiab]' },
    { id: '2', expression: 'b[tiab] AND narrow[tiab]' }, { id: '1', expression: 'a[tiab] AND held2[tiab]' }]);
  const result = await runQueryOptimization(f.input, f.deps);
  expect(result.trials.slice(1).map((trial) => [trial.held, trial.accepted])).toEqual([[true, false], [false, true], [true, false]]);
  expect(result.stopReason).toBe('diagnosed_block_held');
});
test('MeSH 文脈を優先し、足りない descriptor だけ注入先に渡す', async () => {
  const f = fixture([{ id: '1', expression: 'a[tiab] AND narrow[tiab] OR "Child"[Mesh]' }]);
  f.input.initialFormula.blocks[0]!.expression += ' OR "Parent"[Mesh]';
  f.input.initialFormula.blocks[1]!.expression += ' OR "Child"[Mesh]';
  f.input.meshContext = [{ id: 'p', descriptor: 'Parent', label: null, treeNumbers: ['C01'], parentIds: [], childIds: [], explode: true, note: '' }];
  const fetchTrees = jest.fn(async (_descriptors: readonly string[]) => new Map([['Child', ['C01.1']]]));
  f.deps.fetchMeshTreeNumbers = fetchTrees;
  const result = await runQueryOptimization(f.input, f.deps);
  expect(fetchTrees).toHaveBeenCalledTimes(1);
  expect(fetchTrees.mock.calls[0]?.[0]).toEqual(['Child']);
  expect(f.progress.some((p) => p.blockDiagnosis?.overlaps[0]?.kind === 'ancestor')).toBe(true);
  expect(result.blockDiagnosis?.overlaps[0]?.kind).toBe('same');
});
test('追加取得した一部の階層で初回診断の内包を消さず、採用後も保持する', async () => {
  const f = fixture([{ id: '1', expression: 'a[tiab] AND narrow[tiab] OR "Parent"[Mesh]' }]);
  f.input.maxIterations = 2;
  f.input.initialFormula.blocks[0]!.expression += ' OR "Parent"[Mesh]';
  f.input.initialFormula.blocks[1]!.expression += ' OR "Child"[Mesh]';
  f.deps.fetchMeshTreeNumbers = jest.fn(async () => new Map([['Parent', ['C01', 'D01']], ['Child', ['C01.100']]]));
  f.chat.mockResolvedValueOnce({ text: JSON.stringify({ target_block_id: '1', proposed_expression: 'a[tiab]',
    rationale: '階層を確認', mesh_requests: [{ descriptor: 'Parent', tree_number: 'D01' }] }),
    tokensIn: null, tokensOut: null, raw: {} });
  f.deps.fetchMeshContext = jest.fn(async () => [{ id: 'p', descriptor: 'parent', label: null,
    treeNumbers: ['D01'], parentIds: [], childIds: [], explode: true, note: '' }]);
  const result = await runQueryOptimization(f.input, f.deps);
  expect(f.deps.fetchMeshTreeNumbers).toHaveBeenCalledWith(['Parent', 'Child'], expect.anything());
  expect(f.deps.fetchMeshContext).toHaveBeenCalledTimes(1);
  expect(f.progress.some((p) => p.iterations === 0 && p.blockDiagnosis?.overlaps.some((row) => row.kind === 'ancestor'))).toBe(true);
  expect(result.trials.some((trial) => trial.kind === 'proposal' && trial.accepted)).toBe(true);
  expect(result.blockDiagnosis?.overlaps).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'ancestor' })]));
});

test('同じ descriptor の複数ノードの階層を両方の枝の内包に使う', async () => {
  const f = fixture();
  f.input.initialFormula.blocks[0]!.expression += ' OR "Parent"[Mesh]';
  f.input.initialFormula.blocks[1]!.expression += ' OR "ChildC"[Mesh] OR "ChildD"[Mesh]';
  f.input.meshContext = ['C01', 'D01'].map((treeNumber, index) => ({ id: String(index),
    descriptor: index === 0 ? 'Parent' : 'parent', label: null, treeNumbers: [treeNumber],
    parentIds: [], childIds: [], explode: true, note: '' }));
  f.deps.fetchMeshTreeNumbers = async () => new Map([['ChildC', ['C01.100']], ['ChildD', ['D01.100']]]);
  await runQueryOptimization(f.input, f.deps);
  expect(f.progress.some((p) => p.iterations === 0 && p.blockDiagnosis?.overlaps.filter((row) => row.kind === 'ancestor').length === 2)).toBe(true);
});

test('差集合の取得が二回失敗しても診断ブロックの保留による停止にしない', async () => {
  const f = fixture([{ id: '1', expression: 'a[tiab] AND held1[tiab]' }, { id: '1', expression: 'a[tiab] AND held2[tiab]' }]);
  const original = f.deps.eutils.fetch;
  let failures = 0;
  f.deps.eutils.fetch = async (resource, init) => {
    const url = new URL(String(resource));
    const params = init?.method === 'POST' ? new URLSearchParams(init.body as string) : url.searchParams;
    if (url.pathname.includes('esearch') && params.get('term')?.includes(') NOT (') && params.get('retmax') === '10000') {
      failures += 1;
      throw new Error('差集合の取得失敗');
    }
    return original(resource, init);
  };
  const result = await runQueryOptimization(f.input, f.deps);
  expect(failures).toBe(2);
  expect(result.trials.filter((trial) => trial.kind === 'proposal').map((trial) => [trial.held, trial.impact?.lostHits])).toEqual([[true, null], [true, null]]);
  expect(result.stopReason).not.toBe('diagnosed_block_held');
  expect(result.unmetReasons.join(' ')).not.toContain('ブロック #1 を狭める案が 2 回続けて保留');
});

test.each([false, true])('階層取得の例外は失敗理由に落とし、停止例外は停止する: %s', async (stop) => {
  const f = fixture();
  f.input.initialFormula.blocks[0]!.expression += ' OR "Parent"[Mesh]';
  f.input.initialFormula.blocks[1]!.expression += ' OR "Child"[Mesh]';
  f.deps.fetchMeshTreeNumbers = async () => { throw stop ? new QueryOptimizationStopError('user_stop') : new Error('階層の取得失敗'); };
  const result = await runQueryOptimization(f.input, f.deps);
  if (stop) { expect(result.stopReason).toBe('user_stop'); expect(f.chat).not.toHaveBeenCalled(); }
  else expect(f.progress.some((p) => p.blockDiagnosis?.overlaps.some((row) => row.note.includes('階層の取得失敗')))).toBe(true);
});
test('診断全体を実 HTTP 30 回で打ち切り、残りの階層を未判定にする', async () => {
  const f = fixture();
  f.input.initialFormula.blocks[0]!.expression += ' OR ' + Array.from({ length: 35 }, (_, i) => `"Term${i}"[Mesh]`).join(' OR ');
  f.input.initialFormula.blocks[1]!.expression += ' OR "Other"[Mesh]';
  let meshCalls = 0;
  f.deps.fetchMeshTreeNumbers = async (descriptors, eutils) => {
    for (const descriptor of descriptors) { await eutils.fetch(`https://fake.test/esearch?term=${descriptor}`); meshCalls += 1; }
    await eutils.fetch('https://fake.test/esummary'); meshCalls += 1;
    return new Map(descriptors.map((descriptor) => [descriptor, ['C01']]));
  };
  const result = await runQueryOptimization(f.input, f.deps);
  expect(meshCalls).toBe(28);
  expect(f.progress.some((p) => p.blockDiagnosis?.overlaps.some((row) => row.note.includes('診断の通信上限（30 回）')))).toBe(true);
  expect(result.apiCalls).toBe(f.fetch.mock.calls.length + f.chat.mock.calls.length);
});
test('予約予算を残し、採用後に測れない件数を古い値で埋めない', async () => {
  const f = fixture();
  const result = await runQueryOptimization(f.input, { ...f.deps, maxApiCalls: 24 });
  expect(result.best?.formula.blocks[0]?.expression).toContain('narrow');
  expect(result.blockDiagnosis?.narrowing.find((row) => row.blockId === '2')).toMatchObject({ withoutHits: null, ineffective: null, note: expect.stringContaining('式の変更後に再測定していない') });
  expect(result.apiCalls).toBeLessThan(24);
});
test('予約分しかないときは診断を開始せず AI の通信を残す', async () => {
  const f = fixture();
  const result = await runQueryOptimization(f.input, { ...f.deps, maxApiCalls: 10 });
  const initial = f.progress.find((p) => p.blockDiagnosis?.narrowing.every((row) => row.note.includes('通信予算を確保')));
  expect(initial?.blockDiagnosis?.narrowing).toHaveLength(2);
  expect(result.apiCalls).toBeLessThanOrEqual(10);
});

test('Q−i の通信失敗は未判定にし、AI 入力まで処理を続ける', async () => {
  const f = fixture();
  const original = f.deps.eutils.fetch;
  f.deps.eutils.fetch = async (resource, init) => {
    const query = new URL(String(resource)).searchParams.get('term');
    if (query === '(b[tiab]) AND (trial[pt])') throw new Error('件数の取得失敗');
    return original(resource, init);
  };
  await runQueryOptimization(f.input, f.deps);
  expect(f.chat).toHaveBeenCalledTimes(1);
  expect(f.progress.some((p) => p.blockDiagnosis?.narrowing.some((row) =>
    row.blockId === '1' && row.ineffective === null && row.note.includes('件数の取得失敗')))).toBe(true);
});
test('注入した階層取得が予定を超えて通信しようとしても30回で止める', async () => {
  const f = fixture();
  f.input.initialFormula.blocks[0]!.expression += ' OR "Parent"[Mesh]';
  f.input.initialFormula.blocks[1]!.expression += ' OR "Child"[Mesh]';
  let issued = 0;
  f.deps.fetchMeshTreeNumbers = async (_descriptors, eutils) => {
    for (let i = 0; i < 40; i += 1) {
      await eutils.fetch('https://fake.test/mesh');
      issued += 1;
    }
    return new Map();
  };
  const result = await runQueryOptimization(f.input, f.deps);
  expect(issued).toBe(28);
  expect(f.chat).toHaveBeenCalledTimes(1);
  expect(result.blockDiagnosis?.narrowing.find((row) => row.blockId === '2')?.note).toContain('診断の通信上限（30 回）');
});
