import { withRetry } from '@/lib/llm/retry';
import { withSignalDeadline } from '@/lib/llm/signalDeadline';
import { createSetSearch } from '../../../tests/fixtures/pubmedSets';
import { runQueryOptimization, MAX_TERM_API_CALLS, type QueryOptimizationDeps, type QueryOptimizationInput } from './queryOptimizationService';

function fixture(words: number, mesh: number, rounds: number, mode: 'expand' | 'narrow' | 'same' = 'expand') {
  const blockExpression = (block: number, version: number) => [
    ...Array.from({ length: words }, (_, i) => `b${block}v${version}word${i}[tiab]`),
    ...Array.from({ length: mesh }, (_, i) => `"Mesh${block}term${i}"[Mesh]`),
  ].join(' OR ');
  const input: QueryOptimizationInput = { projectId: 'p', runId: 'r', maxHits: mode === 'narrow' ? words + mesh : (words + mesh) * (rounds + 1),
    seedPmids: mode === 'expand' ? Array.from({ length: rounds }, (_, i) => String(1001 + i)) : ['1000'], maxIterations: rounds,
    initialFormula: { blocks: [...Array.from({ length: 4 }, (_, i) => ({ id: String(i + 1), expression: blockExpression(i + 1, 0), isCombination: false })),
      { id: '5', expression: '#1 AND #2 AND #3 AND #4', isCombination: true }], combinationExpression: '#1 AND #2 AND #3 AND #4' },
    approvedBlocks: Array.from({ length: 4 }, (_, i) => ({ id: String(i + 1), approvedBlockId: String(i + 1), label: '疾患' })),
    meshContext: Array.from({ length: 4 }, (_, i) => Array.from({ length: mesh }, (_, j) => ({
      id: `m${i}-${j}`, descriptor: `Mesh${i + 1}term${j}`, label: null, treeNumbers: [`C0${i + 1}.${j}`],
      parentIds: [], childIds: [], explode: true, note: '取得済み',
    }))).flat(),
    criteria: { researchQuestion: 'RQ', inclusionCriteria: '', exclusionCriteria: '' },
  };
  // 同じ語に属する PMID を版ごとに一件増やす。固定ブロックは全版を含む。
  // シードは版 1 以降に属するため、採用の理由は捕捉増加になる。
  const atoms: Record<string, string[]> = {};
  for (let block = 1; block <= 4; block += 1) {
    for (let version = 0; version <= rounds; version += 1) {
      for (let term = 0; term < words + mesh; term += 1) {
        const expression = term < words ? `b${block}v${version}word${term}[tiab]` : `"Mesh${block}term${term - words}"[Mesh]`;
        const depth = term >= words ? 0 : block !== 1 ? rounds
          : mode === 'same' ? 0 : mode === 'narrow' ? rounds - version : version;
        atoms[expression] = Array.from({ length: depth + 1 }, (_, i) => String(1000 + term * 100 + i));
        if (block === 1 && term < words) {
          atoms[expression]!.push(...Array.from({ length: rounds - depth }, (_, i) => String(50000 + term * 100 + i)));
        }
      }
    }
  }
  const sets = createSetSearch((query) => atoms[query]);
  const queries: string[] = [];
  const fetch = jest.fn(async (url, init?: RequestInit) => {
    const params = init?.method === 'POST' ? new URLSearchParams(init.body as string) : new URL(String(url)).searchParams;
    if (String(url).includes('efetch.fcgi')) {
      return { ok: true, status: 200, text: async () => `<PubmedArticleSet>${params.get('id')!.split(',').map((pmid) =>
        `<PubmedArticle><PMID>${pmid}</PMID><ArticleTitle>研究 ${pmid}</ArticleTitle></PubmedArticle>`).join('')}</PubmedArticleSet>` } as Response;
    }
    const query = params.get('term')!;
    queries.push(query);
    return { ok: true, status: 200, json: async () => ({ esearchresult: sets.search(query, Number(params.get('retmax') ?? 20)) }) } as Response;
  });
  let version = 0;
  const chat = jest.fn(async () => ({ text: JSON.stringify({ target_block_id: '1', proposed_expression: blockExpression(1, ++version),
    added_terms: [], removed_terms: [], replaced_terms: Array.from({ length: words }, (_, i) => ({ before: `b1v${version - 1}word${i}[tiab]`, after: `b1v${version}word${i}[tiab]` })), rationale: '基準を維持して調整', measurement_ids: [], mesh_requests: [] }),
    tokensIn: null, tokensOut: null, raw: {} }));
  const deps: QueryOptimizationDeps = { measureTermDetails: true,
    eutils: { fetch, maxRetries: 0, rateLimiter: { acquire: async () => undefined } },
    llmFactory: { model: 'fake', forPurpose: (purpose, onRequestState, attempts) => withRetry(withSignalDeadline({ providerId: 'gemini', model: 'fake',
      chat: purpose === 'annotate_lost_sample' ? async () => ({ text: '{"items":[]}', tokensIn: null, tokensOut: null, raw: {} }) : chat,
    }), { ...attempts, onRequestState }) },
    checkpoint: { read: async () => undefined, write: async () => undefined },
  };
  return { input, deps, queries, chat, atoms, sets };
}

test('F=40 B=4 M=8 で5候補と最終再検証を200通信以内に収め、実測済み候補を失わない', async () => {
  const f = fixture(10, 2, 5);
  const result = await runQueryOptimization(f.input, f.deps);
  expect(result.status).toBe('achieved');
  expect(result.trials.filter((trial) => trial.kind === 'proposal' && trial.accepted)).toHaveLength(5);
  expect(result.trials.map((trial) => trial.kind)).toEqual(['initial', 'proposal', 'proposal', 'proposal', 'proposal', 'proposal', 'final']);
  // 語別92回（確保で抑制）＋評価7回分＋AI5回＋差集合2方向＋診断更新＋未捕捉時の捕捉表・書誌5回分。
  // 未捕捉が残る候補の対象行は採用後に再利用し、全件回収する最後の候補だけ従来より1通信増える。
  expect(result.apiCalls).toBe(92 + 7 * (4 + 2) + 5 + 5 * 2 + 4 + 5 * 3 + 5 * 6 + 1);
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
  await runQueryOptimization(f.input, { ...f.deps, llmFactory: { model: 'fake', forPurpose: (_purpose, onRequestState, attempts) => withRetry(withSignalDeadline({ providerId: 'gemini', model: 'fake',
    chat: async () => ({ text: JSON.stringify({ target_block_id: '1', proposed_expression: f.input.initialFormula.blocks[0]!.expression,
      added_terms: [], removed_terms: [], replaced_terms: [], rationale: '', measurement_ids: [], mesh_requests: [] }), tokensIn: null, tokensOut: null, raw: {} }) }), { ...attempts, onRequestState }) } });
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
  expect(result.trials[1]).toMatchObject({ kind: 'proposal', accepted: true, after: { totalHits: 5 } });
  expect(result.best?.formula.blocks[0]?.expression).toContain('b1v1word');
});


test('全体の通信上限に候補の詳細計測中に達しても、実測済みの採用候補を保持する', async () => {
  const f = fixture(2, 1, 2);
  // 初期評価・未捕捉の捕捉表と書誌・診断・語別計測の後、採用した候補の追加取得中に上限へ達しても保持する。
  const result = await runQueryOptimization(f.input, { ...f.deps, maxApiCalls: 40 });
  expect(result.status).toBe('needs_review');
  expect(result.stopReason).toBe('api_budget');
  expect(result.apiCalls).toBe(40);
  expect(result.trials[1]).toMatchObject({ kind: 'proposal', accepted: true, after: { totalHits: 5 } });
  expect(result.best?.formula.blocks[0]?.expression).toContain('b1v1word');
});

test('予算が限られる場合は全語の固有寄与を優先し、MeSH と個別未測定の語にも結果を残す', async () => {
  const f = fixture(2, 1, 1);
  const result = await runQueryOptimization(f.input, { ...f.deps, maxApiCalls: 46 });
  const terms = result.trials[1]!.before!.terms!;
  expect(terms).toHaveLength(12);
  expect(terms.every((term) => term.finalContribution === 1)).toBe(true);
  expect(terms.find((term) => term.query === '"Mesh1term0"[Mesh]')).toMatchObject({ finalContribution: 1 });
  expect(terms.find((term) => term.query === 'b2v0word0[tiab]')).toMatchObject({ hits: null, delta: null, finalContribution: 1 });
  expect(f.queries.slice(15, 27).every((query) => query.includes(' NOT '))).toBe(true);
  expect(result.unmetReasons.join(' ')).toContain('通信予算を確保するため');
  expect(result.unmetReasons.join(' ')).not.toContain('100 通信の上限');
});

test('実測件数の降順・同数は元の順で全語の寄与と個別分析を測り、表示の行順は維持する', async () => {
  const f = fixture(2, 1, 1);
  for (let block = 1; block <= 4; block += 1) {
    const query = `b${block}v0word1[tiab]`;
    f.atoms[query]!.push(...Array.from({ length: ({ 1: 3, 2: 5, 3: 5, 4: 1 }[block]!) }, (_, i) => String(9000 + block * 100 + i)));
  }
  const result = await runQueryOptimization(f.input, f.deps);
  const contributions = f.queries.slice(15, 27);
  expect(contributions.map((query) => /\(([^()]*) NOT \1\)/.exec(query)?.[1])).toEqual(
    [2, 3, 1, 4].flatMap((id) => [`b${id}v0word0[tiab]`, `b${id}v0word1[tiab]`, `"Mesh${id}term0"[Mesh]`])
  );
  const individual = f.queries.slice(27, 43).filter((query) => /^b\d.*\[tiab\]$/.test(query) && !query.includes(' OR '));
  expect(individual).toEqual([2, 3, 1, 4].flatMap((id) => [`b${id}v0word0[tiab]`, `b${id}v0word1[tiab]`]));
  expect(result.trials[1]!.before!.terms!.map((term) => term.query)).toEqual(
    [1, 2, 3, 4].flatMap((id) => [`b${id}v0word1[tiab]`, `b${id}v0word0[tiab]`, `"Mesh${id}term0"[Mesh]`])
  );
});

test('確保分は全体の半分に制限し、残った語の固有寄与をゼロで埋めない', async () => {
  const f = fixture(2, 1, 1, 'narrow');
  const result = await runQueryOptimization(f.input, { ...f.deps, maxApiCalls: 24 });
  // 全シード捕捉済みで初期実測6回と診断4回。確保を17回から全体24回の半分の12回へ制限し、語別計測を2回行える。
  const terms = result.trials[1]!.before!.terms!;
  expect(f.queries.slice(10, 12).every((query) => query.includes(' NOT '))).toBe(true);
  expect(terms.filter((term) => term.finalContribution === 2)).toHaveLength(2);
  expect(terms.filter((term) => term.finalContribution === null)).toHaveLength(10);
  expect(terms.every((term) => term.hits === null && term.delta === null)).toBe(true);
});

test.each([200, 35])('固有寄与の途中から進捗が増え、予算 %i でも全段階を通して単調で分母を超えない', async (maxApiCalls) => {
  const f = fixture(2, 1, 1);
  const progress: { completed: number; total: number; queries: string[] }[] = [];
  const result = await runQueryOptimization(f.input, { ...f.deps, maxApiCalls, onProgress: (p) => {
    // 初期式の語別計測を、通信状態などによる重複通知も含めて記録する。
    if (p.task?.kind === 'terms' && f.chat.mock.calls.length === 0) {
      progress.push({ completed: p.task.completed, total: p.task.total, queries: [...f.queries] });
    }
  } });
  expect(progress[0]).toMatchObject({ completed: 0, total: 24 });
  expect(progress[progress.length - 1]).toMatchObject({ completed: 24, total: 24 });
  for (let i = 0; i < progress.length; i += 1) {
    expect(progress[i]!.total).toBe(24);
    expect(progress[i]!.completed).toBeGreaterThanOrEqual(i === 0 ? 0 : progress[i - 1]!.completed);
    expect(progress[i]!.completed).toBeLessThanOrEqual(progress[i]!.total);
  }
  expect([...new Set(progress.map((p) => p.completed))]).toEqual(Array.from({ length: 25 }, (_, i) => i));
  const measuredContributions = maxApiCalls === 35 ? 2 : 12;
  for (let completed = 1; completed <= 12; completed += 1) {
    const snapshot = progress.find((p) => p.completed === completed)!;
    // 各固有寄与の取得直後に通知し、個別件数の取得開始まで待たない。
    expect(snapshot.queries).toHaveLength(15 + Math.min(completed, measuredContributions));
    expect(snapshot.queries.slice(15).every((query) => query.includes(' NOT '))).toBe(true);
  }
  const terms = result.trials[1]!.before!.terms!;
  expect(terms.filter((term) => term.finalContribution === 1)).toHaveLength(measuredContributions);
  expect(terms.filter((term) => term.finalContribution === null)).toHaveLength(12 - measuredContributions);
});

test('異常系: 不整合な件数 999 を注入し、最終件数を超える固有寄与は MeSH もフリーワードも未測定として残す', async () => {
  const f = fixture(2, 1, 1);
  const original = f.deps.eutils.fetch;
  f.deps.eutils.fetch = async (url, init) => {
    const response = await original(url, init);
    const query = new URL(String(url)).searchParams.get('term')!;
    if (query.split(' NOT ').length > 2) {
      return { ...response, json: async () => ({ esearchresult: { count: '999', idlist: [] } }) } as Response;
    }
    return response;
  };
  const result = await runQueryOptimization(f.input, f.deps);
  expect(result.trials[1]!.before!.terms!.every((term) => term.finalContribution === null)).toBe(true);
});

test('候補実測と差集合と最終再検証の実コストを残し、確保が発動しない実行との通信数を対比する', async () => {
  const limited = fixture(10, 2, 1);
  const result = await runQueryOptimization(limited.input, { ...limited.deps, maxApiCalls: 40 });
  expect(result.status).toBe('achieved');
  expect(result.trials.map((trial) => trial.kind)).toEqual(['initial', 'proposal', 'final']);
  expect(result.trials[1]!.impact).toMatchObject({ lostHits: 0, gainedHits: 10 });
  // 初期実測6回・捕捉表と書誌6回・診断4回。17回を確保し、初期の語別計測は7回。
  expect(limited.queries.slice(15, 22).every((query) => query.includes(' NOT '))).toBe(true);
  // 全件回収する候補にも対象ブロックの捕捉測定を1通信加える。
  expect(result.apiCalls).toBe(39);
  expect(result.unmetReasons.join(' ')).toContain('通信予算を確保するため');
  const unlimited = fixture(10, 2, 1);
  const withoutReservationStop = await runQueryOptimization(unlimited.input, unlimited.deps);
  expect(withoutReservationStop.status).toBe('achieved');
  expect(withoutReservationStop.apiCalls).toBe(MAX_TERM_API_CALLS + 3 * 6 + 1 + 2 + 4 + 3 + 6 + 1);
  expect(withoutReservationStop.apiCalls).toBeGreaterThan(40);
  // 確保が発動しなければ、40通信目も初期式の語別計測で候補実測へまだ進めない。
  expect(unlimited.queries.slice(15, 40).every((query) => query.includes(' NOT '))).toBe(true);
  expect(withoutReservationStop.unmetReasons.join(' ')).not.toContain('通信予算を確保するため');
});

test('差集合の書誌取得で候補を保留した後も最終再検証1回分の通信を残す', async () => {
  const f = fixture(10, 2, 1, 'narrow');
  const result = await runQueryOptimization(f.input, { ...f.deps, maxApiCalls: 40 });
  expect(result.trials.map((trial) => trial.kind)).toEqual(['initial', 'proposal']);
  expect(result.trials[1]).toMatchObject({ accepted: false, impact: { lostHits: 10, gainedHits: 0,
    inspected: expect.arrayContaining([{ pmid: '1001', title: '研究 1001', year: null }]) } });
  expect(f.deps.eutils.fetch).toHaveBeenCalledWith(expect.stringContaining('efetch.fcgi'), expect.any(Object));
  // 注釈の実送信も 1 通信として数え、最終再検証 6 通信分は残る。
  expect(result.apiCalls).toBe(34);
  expect(40 - result.apiCalls).toBeGreaterThanOrEqual(6);
  expect(result.stopReason).toBe('iteration_limit');
});

test('同じ最良式の反復とブロック間の重複語でも語別クエリを二度送らない', async () => {
  const f = fixture(2, 1, 2, 'same');
  f.input.maxHits = 1;
  f.input.initialFormula.blocks[2]!.expression = f.input.initialFormula.blocks[1]!.expression;
  await runQueryOptimization(f.input, f.deps);
  expect(f.chat).toHaveBeenCalledTimes(2);
  for (const query of ['b2v0word0[tiab]', '"Mesh2term0"[Mesh]', '(b2v0word0[tiab]) OR (b2v0word1[tiab])']) {
    expect(f.queries.filter((value) => value === query)).toHaveLength(1);
  }
  const contributions = f.queries.filter((query) => query.includes(' NOT '));
  expect(contributions).toHaveLength(36);
  expect(new Set(contributions).size).toBe(contributions.length);
});
