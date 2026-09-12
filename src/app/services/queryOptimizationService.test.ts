import * as google from '@/lib/google';
import * as evaluation from './queryEvaluationService';
import * as skill from '@/features/formula/skills/optimizeQuery';
import * as checkpoint from './queryOptimizationCheckpointService';
import type { LLMProvider } from '@/lib/llm';
import { sharedEutilsRateLimiters } from '@/lib/ncbi';
import { validateCombinationExpression } from '@/lib/combination-expression';
import { runQueryOptimization, validateOptimizationCandidate, QueryOptimizationStopError, type QueryOptimizationInput, type QueryOptimizationDeps } from './queryOptimizationService';

interface Outcome { hits: number; captured: string[]; blockCapture?: Record<string, string[]>;
  articles?: Record<string, { abstract?: string; mesh?: string[] }>;
  lost?: { hits: number; pmids?: string[] }; gained?: number }

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
    if (resource.includes('efetch.fcgi')) {
      const pmids = new URL(resource).searchParams.get('id')!.split(',');
      const xml = `<PubmedArticleSet>${pmids.map((pmid) => {
        const article = outcomes.a?.articles?.[pmid];
        return `<PubmedArticle><PMID>${pmid}</PMID><ArticleTitle>研究 ${pmid}</ArticleTitle><PubDate><Year>2024</Year></PubDate>${article?.abstract ? `<Abstract><AbstractText>${article.abstract}</AbstractText></Abstract>` : ''}${(article?.mesh ?? []).map((mesh) => `<MeshHeading><DescriptorName>${mesh}</DescriptorName></MeshHeading>`).join('')}</PubmedArticle>`;
      }).join('')}</PubmedArticleSet>`;
      return { ok: true, status: 200, text: async () => xml };
    }
    const query = new URL(resource).searchParams.get('term')!;
    let depth = 0;
    let marginIndex = -1;
    for (let index = 0; index < query.length; index += 1) {
      if (query[index] === '(') depth += 1;
      if (query[index] === ')') depth -= 1;
      if (depth === 0 && query.startsWith(') NOT (', index)) { marginIndex = index; break; }
    }
    const before = query.slice(0, marginIndex + 1);
    const after = query.slice(marginIndex + ') NOT '.length);
    const keyIn = (side: string) => {
      const tags: readonly string[] = side.match(/[A-Za-z0-9]+\[tiab\]/g) ?? [];
      return Object.keys(outcomes).find((term) => tags.includes(`${term}[tiab]`));
    };
    // 概念式自体の NOT は通常の測定値を返し、前後の候補式が揃う外側の差集合だけを扱う。
    if (marginIndex >= 0 && keyIn(before) && keyIn(after) && keyIn(before) !== keyIn(after)) {
      // 確認用 PMID を要求する方向は後半、逆方向は前半が候補式。
      const lost = new URL(resource).searchParams.get('retmax') !== '0';
      const side = lost ? after : before;
      const candidateKey = keyIn(side)!;
      const candidate = outcomes[candidateKey]!;
      return { ok: true, status: 200, json: async () => ({ esearchresult: {
        count: String(lost ? candidate.lost?.hits ?? 0 : candidate.gained ?? 0),
        idlist: lost ? candidate.lost?.pmids ?? [] : [],
      } }) };
    }
    const tagged: readonly string[] = query.match(/[A-Za-z0-9]+\[tiab\]/g) ?? [];
    const key = Object.keys(outcomes).find((term) => tagged.includes(`${term}[tiab]`)) ?? 'a';
    const outcome = outcomes[key]!;
    const capture = query.includes('[uid]');
    // uid 句より前の展開済み式で、タグ語の組合せから結合行・概念行・フィルタを特定する。
    const expression = query.slice(0, query.lastIndexOf(') AND ('));
    const blockId = expression.includes('fixed[tiab]') && expression.includes('[pt]') ? '3'
      : expression.includes('fixed[tiab]') ? '2' : expression.includes('[pt]') ? 'RCTfilter'
        : /\[tiab\]/.test(expression) ? '1' : undefined;
    const captured = capture && query.includes(') AND (') && blockId
      ? outcome.blockCapture?.[blockId] ?? outcome.captured : outcome.captured;
    return { ok: true, status: 200, json: async () => ({ esearchresult: {
      count: String(capture ? captured.length : outcome.hits), idlist: capture ? captured : [],
    } }) };
  });
  let next = 0;
  const chat = jest.fn().mockImplementation(async () => ({
    text: JSON.stringify({ target_block_id: '1', proposed_expression: proposals[Math.min(next++, proposals.length - 1)],
      rationale: '研究基準に沿う変更', added_terms: [], removed_terms: [],
      replaced_terms: [{ before: next <= 1 ? 'a[tiab]' : proposals[Math.min(next - 2, proposals.length - 1)],
        after: proposals[Math.min(next - 1, proposals.length - 1)] }], measurement_ids: ['run:initial'] }),
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

const captureQueries = (fetch: ReturnType<typeof setup>['fetch']) => fetch.mock.calls
  .map(([url]) => new URL(url as string).searchParams.get('term') ?? '')
  .filter((query) => query.includes('[uid]') && query.includes(') AND ('));

test.each([true, false])('未捕捉 %s のときだけ全ブロックの捕捉表と書誌を取得する', async (missed) => {
  const f = setup({ a: { hits: 200, captured: missed ? ['11'] : ['11', '22'],
    articles: { '22': { abstract: '未捕捉の抄録', mesh: ['Disease'] } } } }, ['a[tiab]']);
  f.input.maxIterations = 1;
  const result = await runQueryOptimization(f.input, f.deps);
  const capture = result.trials[0]!.after!.seedCapture;
  if (missed) {
    expect(capture?.seedPmids).toEqual(['11', '22']);
    expect(capture?.rows.map((row) => row.blockId)).toEqual(['1', '2', 'RCTfilter', '3']);
    expect(capture?.rows.every((row) => row.error === null)).toBe(true);
    const prompt = f.chat.mock.calls[0]![0][1].content as string;
    for (const text of ['シード × ブロック捕捉表', '#1: 捕捉 [11] / 未捕捉 [22]', '未捕捉シードの書誌',
      '"pmid": "22"', '"hasAbstract": true', '未捕捉の抄録', 'Disease']) expect(prompt).toContain(text);
  } else expect(capture).toBeUndefined();
  // 同じ式の候補実測と初期実測の 2 回に、未捕捉時だけ全ブロック分を加える。
  expect(captureQueries(f.fetch)).toHaveLength(2 + (missed ? f.input.initialFormula.blocks.length : 0));
  expect(f.fetch.mock.calls.filter(([url]) => url.includes('efetch.fcgi'))).toHaveLength(missed ? 1 : 0);
  expect(result.apiCalls).toBe(f.fetch.mock.calls.length + 1);
});

test.each(['declared', 'implicit', 'replacement', 'captured'])('削除制御 %s を測定前に適用する', async (kind) => {
  const f = setup({ a: { hits: 200, captured: kind === 'captured' ? ['11', '22'] : ['11'] },
    b: { hits: 150, captured: ['11', '22'] } });
  f.input.initialFormula.blocks[0]!.expression = 'a[tiab] OR x[tiab]';
  f.input.maxIterations = 1;
  f.chat.mockResolvedValue({ text: JSON.stringify({ target_block_id: '1', proposed_expression: 'a[tiab] OR b[tiab]',
    removed_terms: kind === 'declared' || kind === 'captured' ? ['x[tiab]'] : [],
    replaced_terms: kind === 'replacement' ? [{ before: 'x[tiab]', after: 'b[tiab]' }] : [] }) });
  const result = await runQueryOptimization(f.input, f.deps);
  const rejected = kind === 'declared' || kind === 'implicit';
  if (rejected) {
    expect(result.trials[1]).toMatchObject({ kind: 'proposal', accepted: false, after: null });
    expect(result.trials[1]!.reason).toContain('削除案を受け付けません');
    expect(result.trials[1]!.reason).toContain('x[tiab]');
  } else expect(result.trials[1]!.after).not.toBeNull();
  expect(f.fetch.mock.calls.some(([url]) => new URL(url as string).searchParams.get('term')?.includes('b[tiab]'))).toBe(!rejected);
});

test.each([
  ['大文字小文字', 'a[tiab] OR B[tiab]', 'a[tiab] OR b[tiab] OR c[tiab]', []],
  ['連続空白', 'a[tiab] OR "acute respiratory distress"[tiab]', 'a[tiab] OR "acute  respiratory distress"[tiab] OR c[tiab]', []],
  ['置換前の表記', 'a[tiab] OR "Acute  respiratory distress"[tiab]', 'a[tiab] OR c[tiab]',
    [{ before: '"acute respiratory distress"[tiab]', after: 'c[tiab]' }]],
] as const)('%s の揺れを暗黙の削除として却下しない', async (_, before, after, replaced) => {
  const f = setup({ a: { hits: 200, captured: ['11'] } });
  f.input.initialFormula.blocks[0]!.expression = before;
  f.input.maxIterations = 1;
  f.chat.mockResolvedValue({ text: JSON.stringify({ target_block_id: '1', proposed_expression: after,
    added_terms: ['c[tiab]'], removed_terms: [], replaced_terms: replaced }) });
  const result = await runQueryOptimization(f.input, f.deps);
  expect(result.trials[1]).toMatchObject({ kind: 'proposal', after: expect.any(Object) });
  expect(result.trials[1]!.reason).not.toContain('削除案を受け付けません');
});

test('暗黙の削除の却下理由には元の大文字小文字と空白を残す', async () => {
  const f = setup({ a: { hits: 200, captured: ['11'] } });
  f.input.initialFormula.blocks[0]!.expression = 'a[tiab] OR "Acute  respiratory distress"[tiab]';
  f.input.maxIterations = 1;
  f.chat.mockResolvedValue({ text: JSON.stringify({ target_block_id: '1', proposed_expression: 'a[tiab] OR c[tiab]',
    added_terms: ['c[tiab]'], removed_terms: [], replaced_terms: [] }) });
  const result = await runQueryOptimization(f.input, f.deps);
  expect(result.trials[1]).toMatchObject({ accepted: false, after: null });
  expect(result.trials[1]!.reason).toContain('削除案を受け付けません');
  expect(result.trials[1]!.reason).toContain('"Acute  respiratory distress"[tiab]');
});

test('捕捉表の最初の通信中に停止しても初期試行と最良候補を保存する', async () => {
  const f = setup({ a: { hits: 200, captured: ['11'] } });
  const original = f.fetch.getMockImplementation()!;
  let stop = false;
  f.deps.shouldStop = () => stop;
  f.fetch.mockImplementation(async (url: string) => {
    const query = new URL(url).searchParams.get('term') ?? '';
    // 初期実測の最終式捕捉と区別し、捕捉表の先頭の概念行で停止する。
    if (query.includes('[uid]') && query.startsWith('(a[tiab]) AND (')) stop = true;
    return original(url);
  });
  const result = await runQueryOptimization(f.input, f.deps);
  expect(stop).toBe(true);
  expect(captureQueries(f.fetch)).toHaveLength(2);
  expect(result.trials).toHaveLength(1);
  expect(result.trials[0]).toMatchObject({ kind: 'initial', candidateId: 'initial', accepted: true });
  expect(result.best).not.toBeNull();
  expect(result).toMatchObject({ status: 'stopped', stopReason: 'user_stop' });
  expect(f.write).toHaveBeenCalled();
});

test('フィルタ行が未測定なら最終式の未捕捉を結合構造と断定しない', async () => {
  const f = setup({ a: { hits: 200, captured: ['11'], blockCapture: {
    '1': ['11', '22'], '2': ['11', '22'], RCTfilter: ['11', '22'], '3': ['11'],
  } } }, ['a[tiab]']);
  const original = f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation(async (url: string) => {
    const query = new URL(url).searchParams.get('term') ?? '';
    if (query.startsWith('(randomized controlled trial[pt]) AND (')) throw new Error('フィルタ捕捉の通信失敗');
    return original(url);
  });
  const result = await runQueryOptimization(f.input, f.deps);
  expect(result.seedDiagnoses![0]).toMatchObject({ recoverableByTerms: false, blockingBlockIds: ['3'] });
  expect(result.seedDiagnoses![0]!.note).not.toContain('結合構造');
  expect(result.seedDiagnoses![0]!.note).toContain('#RCTfilter は未測定のため判定不能');
});

test('承認外フィルタと結合行が落とすシードを回収不能と診断する', async () => {
  const f = setup({ a: { hits: 200, captured: ['11'], blockCapture: {
    '1': ['11', '22'], '2': ['11', '22'], RCTfilter: ['11'], '3': ['11'],
  }, articles: { '22': { abstract: '抄録', mesh: ['Disease'] } } } }, ['a[tiab]']);
  const result = await runQueryOptimization(f.input, f.deps);
  expect(result.seedDiagnoses).toEqual([expect.objectContaining({ pmid: '22', title: '研究 22', year: 2024,
    hasAbstract: true, meshHeadingCount: 1, recoverableByTerms: false, blockingBlockIds: ['RCTfilter', '3'] })]);
  expect(result.seedDiagnoses![0]!.note).toContain('承認外のブロック（研究デザインフィルタ等）');
  expect(result.seedDiagnoses![0]!.note).not.toContain('結合行');
  expect(result.unmetReasons.join(' ')).toContain('語の調整では回収できないシード');
});

test('承認済み概念ブロックだけが落とすシードは、結合行が最終式で落としていても語で回収できると診断する', async () => {
  const f = setup({ a: { hits: 200, captured: ['11'], blockCapture: {
    '1': ['11'], '2': ['11', '22'], RCTfilter: ['11', '22'], '3': ['11'],
  } } }, ['a[tiab]']);
  const result = await runQueryOptimization(f.input, f.deps);
  expect(result.seedDiagnoses![0]).toMatchObject({ blockingBlockIds: ['1', '3'], recoverableByTerms: true });
  expect(result.seedDiagnoses![0]!.note).toContain('ブロック #1 が落としている');
  expect(result.seedDiagnoses![0]!.note).not.toContain('#3');
});

test('全概念ブロックが捕捉しているのに最終式で未捕捉なら結合構造と診断する', async () => {
  const f = setup({ a: { hits: 200, captured: ['11'], blockCapture: {
    '1': ['11', '22'], '2': ['11', '22'], RCTfilter: ['11', '22'], '3': ['11'],
  } } }, ['a[tiab]']);
  const result = await runQueryOptimization(f.input, f.deps);
  expect(result.seedDiagnoses![0]).toMatchObject({ recoverableByTerms: false, blockingBlockIds: ['3'] });
  expect(result.seedDiagnoses![0]!.note).toContain('結合構造');
});

test.each([false, true])('捕捉表の失敗（全行 %s）を空集合にせず処理を続ける', async (all) => {
  const f = setup({ a: { hits: 200, captured: ['11'] } }, ['a[tiab]']);
  const original = f.fetch.getMockImplementation()!;
  let measuringTable = false;
  f.deps.onProgress = (progress) => {
    if (progress.bestTotalHits !== null && progress.step === 'measuring' && progress.task === null) measuringTable = true;
    if (progress.step === 'adjusting') measuringTable = false;
  };
  f.fetch.mockImplementation(async (url: string) => {
    const query = new URL(url).searchParams.get('term') ?? '';
    if (measuringTable && query.includes('[uid]') && (all || query === '(fixed[tiab]) AND (11[uid] OR 22[uid])')) {
      return { ok: false, status: 414 };
    }
    return original(url);
  });
  const result = await runQueryOptimization(f.input, f.deps);
  const rows = result.trials[0]!.after!.seedCapture!.rows;
  expect(rows.filter((row) => row.capturedPmids === null)).toHaveLength(all ? 4 : 1);
  expect(rows.find((row) => row.blockId === '2')).toMatchObject({ capturedPmids: null, error: expect.stringContaining('414') });
  expect(result.trials[0]!.apiEvents).toContainEqual({ source: 'PubMed', status: 'failure' });
  expect(result.iterations).toBeGreaterThan(0);
  expect(result.seedDiagnoses![0]!.note).toContain('未測定');
  if (all) expect(result.seedDiagnoses![0]).toMatchObject({ blockingBlockIds: null, recoverableByTerms: null });
});

test.each([false, true])('採用後に未捕捉が残る %s なら捕捉表を更新し書誌を現在分に絞る', async (remaining) => {
  const f = setup({ a: { hits: 200, captured: ['11'], articles: {
    '22': { abstract: '回収するシード' }, '33': { abstract: '残るシード' },
  } }, b: { hits: 300, captured: ['11', '22'] } }, ['b[tiab]', 'b[tiab]']);
  if (remaining) f.input.seedPmids.push('33');
  f.input.maxIterations = 2;
  const result = await runQueryOptimization(f.input, f.deps);
  expect(result.trials[1]!.accepted).toBe(true);
  expect(result.trials[1]!.after!.seedCapture !== undefined).toBe(remaining);
  expect(result.trials[0]!.after!.seedCapture!.rows[0]!.capturedPmids).toEqual(['11']);
  if (remaining) expect(result.trials[1]!.after!.seedCapture!.rows[0]!.capturedPmids).toEqual(['11', '22']);
  const current = (f.chat.mock.calls[1]![0][1].content as string).split('未捕捉シードの書誌:\n')[1]!.split('\n周辺 MeSH')[0]!;
  expect(current).not.toContain('"pmid": "22"');
  if (remaining) expect(current).toContain('"pmid": "33"');
  else expect(current).toContain('(なし)');
  expect(f.fetch.mock.calls.filter(([url]) => url.includes('efetch.fcgi'))).toHaveLength(1);
});

test.each(['capture', 'bibliography'])('追加取得 %s 中の停止例外を再送出して run を停止する', async (phase) => {
  const f = setup({ a: { hits: 200, captured: ['11'] } });
  const original = f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation(async (url: string) => {
    const query = new URL(url).searchParams.get('term') ?? '';
    if ((phase === 'capture' && query === '(a[tiab]) AND (11[uid] OR 22[uid])')
      || (phase === 'bibliography' && url.includes('efetch.fcgi'))) throw new QueryOptimizationStopError('user_stop');
    return original(url);
  });
  const result = await runQueryOptimization(f.input, f.deps);
  expect(result.stopReason).toBe('user_stop');
  expect(f.chat).not.toHaveBeenCalled();
});

test.each([false, true])('未捕捉書誌の取得失敗 %s と抄録の切り詰めを記録する', async (failure) => {
  const f = setup({ a: { hits: 200, captured: ['11'], articles: { '22': { abstract: '長'.repeat(1501) } } } }, ['a[tiab]']);
  if (failure) {
    const original = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (url: string) => url.includes('efetch.fcgi') ? { ok: false, status: 414 } : original(url));
  }
  const result = await runQueryOptimization(f.input, f.deps);
  const prompt = f.chat.mock.calls[0]![0][1].content as string;
  if (failure) {
    expect(prompt).toContain('書誌の取得に失敗:');
    expect(result.seedDiagnoses![0]!.meshHeadingCount).toBeNull();
    expect(result.trials[0]!.apiEvents).toContainEqual({ source: 'PubMed', status: 'failure' });
  } else {
    expect(prompt).toContain('抄録を 1500 文字で切り詰め');
    expect(prompt).toContain('長'.repeat(1500));
    expect(prompt).not.toContain('長'.repeat(1501));
  }
});

test('シードを維持して上限を満たす候補も失う集合があれば保留し書誌を提示する', async () => {
  const { input, deps, fetch } = setup({ a: { hits: 200, captured: ['11', '22'] },
    b: { hits: 50, captured: ['11', '22'], lost: { hits: 150, pmids: ['901', '902'] }, gained: 0 } });
  input.maxIterations = 1;
  const result = await runQueryOptimization(input, deps);
  expect(result.trials[1]).toMatchObject({ accepted: false, held: true, impact: {
    lostHits: 150, gainedHits: 0, error: null, inspected: [
      { pmid: '901', title: '研究 901', year: 2024 }, { pmid: '902', title: '研究 902', year: 2024 },
    ],
  } });
  expect(result.trials[1]?.reason).toContain('失う集合 150 件');
  expect(result.trials[1]?.reason).toContain('書誌を確認した件数 2 / 全体 150');
  expect(result.best?.measurement.totalHits).toBe(200);
  expect(result.status).toBe('needs_review');
  expect(result.unmetReasons).toContain('レビュー候補として保留: candidate-1（失う 150 件・増える 0 件）');
  expect(fetch.mock.calls.some(([url]) => url.includes('efetch.fcgi') && decodeURIComponent(url).includes('901,902'))).toBe(true);
  expect(result.apiCalls).toBe(fetch.mock.calls.length + 1);
});

test.each(['both', 'gained', 'efetch'])('差集合・書誌取得の失敗 %s は実測済み件数を保ち保留する', async (failure) => {
  const { input, deps, fetch } = setup({ a: { hits: 200, captured: ['11', '22'] },
    b: { hits: 50, captured: ['11', '22'], lost: { hits: failure === 'gained' ? 0 : 150, pmids: ['901'] } } });
  input.maxIterations = 1;
  const original = fetch.getMockImplementation()!;
  fetch.mockImplementation(async (url: string) => {
    const params = new URL(url).searchParams;
    const difference = params.get('term')?.includes(') NOT (');
    if ((failure === 'both' && difference) || (failure === 'gained' && difference && params.get('retmax') === '0')
      || (failure === 'efetch' && url.includes('efetch.fcgi'))) return { ok: false, status: 414 };
    return original(url);
  });
  const result = await runQueryOptimization(input, deps);
  expect(result.trials[1]).toMatchObject({ accepted: false, held: true, impact: {
    lostHits: failure === 'both' ? null : failure === 'gained' ? 0 : 150,
    gainedHits: failure === 'efetch' ? 0 : null, inspected: [], error: expect.stringContaining('414'),
  } });
  if (failure !== 'efetch') expect(result.trials[1]?.reason).toContain('実測できなかった');
  expect(result.trials[1]?.apiEvents).toContainEqual({ source: 'PubMed', status: 'failure' });
  expect(result.best?.measurement.totalHits).toBe(200);
});

test('削除影響は run の予算で測り、確認書誌を先頭 20 件に制限する', async () => {
  const pmids = Array.from({ length: 25 }, (_, index) => String(900 + index));
  const { input, deps, fetch } = setup({ a: { hits: 200, captured: ['11', '22'] },
    b: { hits: 50, captured: ['11', '22'], lost: { hits: 150, pmids } } });
  input.maxIterations = 1;
  let latest: Parameters<NonNullable<QueryOptimizationDeps['onProgress']>>[0] | undefined;
  deps.onProgress = (progress) => { latest = progress; };
  const original = fetch.getMockImplementation()!;
  fetch.mockImplementation(async (url: string) => {
    if (new URL(url).searchParams.get('term')?.includes(') NOT (') || url.includes('efetch.fcgi')) {
      expect(latest).toMatchObject({ step: 'measuring', task: null, bestTotalHits: 200 });
    }
    return original(url);
  });
  const result = await runQueryOptimization(input, deps);
  expect(result.trials[1]?.impact?.inspected).toHaveLength(20);
  const url = fetch.mock.calls.find(([resource]) => resource.includes('efetch.fcgi'))![0] as string;
  expect(new URL(url).searchParams.get('id')!.split(',')).toEqual(pmids.slice(0, 20));
  expect(result.apiCalls).toBe(fetch.mock.calls.length + 1);
});

test('2 回の保留は改善なしで停止し次の AI に理由と件数を渡す', async () => {
  const { input, deps, chat } = setup({ a: { hits: 200, captured: ['11', '22'] },
    b: { hits: 50, captured: ['11', '22'], lost: { hits: 5 } },
    c: { hits: 40, captured: ['11', '22'], lost: { hits: 5 } } }, ['b[tiab]', 'c[tiab]']);
  const result = await runQueryOptimization(input, deps);
  expect(result.stopReason).toBe('no_improvement');
  expect(chat).toHaveBeenCalledTimes(2);
  expect(result.trials.filter((trial) => trial.held)).toHaveLength(2);
  const prompt = chat.mock.calls[1]![0][1].content as string;
  for (const text of ['"held": true', '"lostHits": 5', '失う集合 5 件']) expect(prompt).toContain(text);
});

test('保留の 150 件を次の AI に渡し、その後条件達成しても未達理由には保留を残さない', async () => {
  const { input, deps, chat } = setup({ a: { hits: 200, captured: ['11', '22'] },
    b: { hits: 50, captured: ['11', '22'], lost: { hits: 150 } },
    c: { hits: 90, captured: ['11', '22'] } }, ['b[tiab]', 'c[tiab]']);
  input.maxIterations = 2;
  const result = await runQueryOptimization(input, deps);
  expect(result).toMatchObject({ status: 'achieved', stopReason: 'conditions_met', unmetReasons: [] });
  expect(result.trials[1]?.held).toBe(true);
  expect(chat.mock.calls[1]![0][1].content).toContain('"held": true');
  expect(chat.mock.calls[1]![0][1].content).toContain('"lostHits": 150');
});

test.each(['seed_loss', 'within_target', 'repeated', 'syntax', 'failure'])(
  '採用判定前の却下 %s には差集合を測らない', async (kind) => {
    const { input, deps, fetch } = setup({ a: { hits: kind === 'within_target' ? 80 : 200, captured: ['11', '22'] },
      b: { hits: 40, captured: kind === 'seed_loss' ? ['11'] : ['11', '22'], lost: { hits: 3 } } },
    [kind === 'repeated' ? 'a[tiab]' : kind === 'syntax' ? 'b[tiab] OR' : 'b[tiab]']);
    input.maxIterations = 1;
    if (kind === 'failure') {
      const original = fetch.getMockImplementation()!;
      fetch.mockImplementation(async (url: string) => new URL(url).searchParams.get('term')?.includes('b[tiab]')
        ? { ok: false, status: 414 } : original(url));
    }
    const result = await runQueryOptimization(input, deps);
    expect(result.trials[1]?.accepted).toBe(false);
    expect(result.trials[1]?.impact).toBeUndefined();
    expect(fetch.mock.calls.some(([url]) => new URL(url).searchParams.get('term')?.includes(') NOT ('))).toBe(false);
    if (kind === 'within_target') expect(result).toMatchObject({ status: 'achieved', unmetReasons: [] });
  }
);

test.each(['lost', 'gained', 'efetch'])('削除影響の %s 中の停止例外を握りつぶさない', async (stage) => {
  const { input, deps, fetch } = setup({ a: { hits: 200, captured: ['11', '22'] },
    b: { hits: 50, captured: ['11', '22'], lost: { hits: 150, pmids: ['901'] } } });
  const original = fetch.getMockImplementation()!;
  fetch.mockImplementation(async (url: string) => {
    const params = new URL(url).searchParams;
    if ((stage === 'efetch' && url.includes('efetch.fcgi'))
      || (params.get('term')?.includes(') NOT (') && params.get('retmax') === (stage === 'lost' ? '20' : stage === 'gained' ? '0' : 'unused'))) {
      throw new QueryOptimizationStopError('user_stop');
    }
    return original(url);
  });
  const result = await runQueryOptimization(input, deps);
  expect(result.stopReason).toBe('user_stop');
  expect(result.best?.measurement.totalHits).toBe(200);
});

afterEach(() => jest.restoreAllMocks());

test('過去の却下式・理由・fingerprint は AI 文脈だけへ渡し、同じ候補も新 run で測り直す', async () => {
  const f = setup({ a: { hits: 300, captured: ['11', '22'] }, b: { hits: 200, captured: ['11', '22'] },
    c: { hits: 90, captured: ['11', '22'] } }, ['b[tiab]', 'c[tiab]']);
  const pastFormula = { ...f.input.initialFormula, blocks: f.input.initialFormula.blocks.map((block) => ({ ...block,
    expression: block.id === '1' ? 'b[tiab]' : block.expression })) };
  const old = await evaluation.evaluateQuery(pastFormula, f.input.seedPmids, { eutils: f.deps.eutils });
  const initialOld = await evaluation.evaluateQuery(f.input.initialFormula, f.input.seedPmids, { eutils: f.deps.eutils });
  f.input.runId = 'resumed';
  f.input.previousRejectedTrials = [
    { formula: pastFormula, reason: '前回はシードを失った', fingerprint: old.fingerprint },
    { formula: f.input.initialFormula, reason: '前回の別の却下理由', fingerprint: initialOld.fingerprint },
  ];
  const evaluate = jest.spyOn(evaluation, 'evaluateQuery');
  const optimize = jest.spyOn(skill, 'optimizeQuery');
  const result = await runQueryOptimization(f.input, f.deps);
  expect(result.stopReason).toBe('conditions_met');
  expect(result.trials[1]).toMatchObject({ accepted: true, after: { id: 'resumed:candidate-1', totalHits: 200 } });
  expect(evaluate.mock.calls.map(([formula]) => formula.blocks[0]!.expression)).toEqual(['a[tiab]', 'b[tiab]', 'c[tiab]', 'c[tiab]']);
  expect(optimize.mock.calls[0]![0].trials).toBe(result.trials);
  expect(result.trials.map((trial) => trial.reason)).not.toContain('前回はシードを失った');
  expect(optimize.mock.calls[0]![0].previousRejectedTrials).toEqual(f.input.previousRejectedTrials);
  const prompt = f.chat.mock.calls[0]![0][1].content as string;
  for (const text of ['前回はシードを失った', old.fingerprint, '過去の run の却下記録（未再検証']) expect(prompt).toContain(text);
});

test('再開の累積消費量を途中と終了の両方に保存し、再び再開しても元の予算を増やさない', async () => {
  const f = setup({ a: { hits: 300, captured: ['11', '22'] }, b: { hits: 200, captured: ['11', '22'] } });
  const limits = { apiCalls: 200, elapsedMs: 600000, evaluatedTrials: 5 };
  f.input.maxIterations = 1;
  f.input.inputIdentity = 'fixed-input';
  f.input.resumeBudget = { runId: 'previous', limits, consumed: { apiCalls: 120, elapsedMs: 100000, evaluatedTrials: 4 } };
  f.deps.maxApiCalls = 80;
  f.deps.maxElapsedMs = 500000;
  let time = 1000;
  f.deps.now = () => time;
  const fetch = f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation(async (url: string) => { time += 100; return fetch(url); });
  const result = await runQueryOptimization(f.input, f.deps);
  const records = f.write.mock.calls.map(([items]) => items.queryOptimizationCheckpoint as checkpoint.QueryOptimizationCheckpoint);
  expect(records.find((record) => record.trials.length === 1)?.resume).toMatchObject({ limits, consumed: { apiCalls: 125, elapsedMs: 100500, evaluatedTrials: 4 } });
  const saved = records[records.length - 1]!;
  expect(saved.resume).toMatchObject({ inputIdentity: 'fixed-input', resumedFromRunId: 'previous', limits,
    consumed: { apiCalls: 120 + result.apiCalls, elapsedMs: 100000 + result.elapsedMs, evaluatedTrials: 5 } });
  expect(checkpoint.getQueryOptimizationResumeAvailability({ ...saved, completion: undefined }, 'fixed-input'))
    .toMatchObject({ available: false, reason: expect.stringContaining('予算を使い切っている') });
});

test('再開直後の10通信未満では保存せず、過去の測定値も作らない', async () => {
  const f = setup();
  f.input.inputIdentity = 'same';
  f.input.resumeBudget = { runId: 'old', limits: { apiCalls: 200, elapsedMs: 600000, evaluatedTrials: 5 },
    consumed: { apiCalls: 120, elapsedMs: 300000, evaluatedTrials: 2 } };
  f.input.maxIterations = 3;
  f.deps.maxApiCalls = 80;
  f.deps.maxElapsedMs = 300000;
  const arrived = deferred<void>();
  const response = deferred<unknown>();
  let stopped = false;
  f.deps.shouldStop = () => stopped;
  f.fetch.mockImplementationOnce(() => { arrived.resolve(); return response.promise; });
  const running = runQueryOptimization(f.input, f.deps);
  await arrived.promise;
  expect(f.write).not.toHaveBeenCalled();
  stopped = true;
  response.resolve({ ok: true, json: async () => ({ esearchresult: { count: '1', idlist: [] } }) });
  expect((await running).best).toBeNull();
  expect(f.write).not.toHaveBeenCalled();
});

test.each([false, true])('語別計測中は10通信ごとに保存し、未記録は最大9回に収まる（再開: %s）', async (resuming) => {
  const f = setup();
  f.input.initialFormula.blocks[0]!.expression = ['a[tiab]', ...Array.from({ length: 20 }, (_, i) => `word${i}[tiab]`)].join(' OR ');
  f.input.inputIdentity = 'same';
  const consumedBefore = resuming ? 120 : 0;
  if (resuming) {
    f.input.resumeBudget = { runId: 'old', limits: { apiCalls: 200, elapsedMs: 600000, evaluatedTrials: 5 },
      consumed: { apiCalls: consumedBefore, elapsedMs: 1000, evaluatedTrials: 2 } };
    f.input.maxIterations = 3;
    f.deps.maxApiCalls = 80;
    f.deps.maxElapsedMs = 599000;
  }
  let stopped = false;
  f.deps.shouldStop = () => stopped;
  const fetch = f.fetch.getMockImplementation()!;
  const observations: { sent: number; saves: number; recorded: number }[] = [];
  f.fetch.mockImplementation(async (url: string) => {
    const sent = f.fetch.mock.calls.length;
    const writes = f.write.mock.calls;
    if (sent > 5) observations.push({ sent, saves: writes.length,
      recorded: writes[writes.length - 1]![0].queryOptimizationCheckpoint.resume.consumed.apiCalls });
    if (sent === 34) stopped = true;
    return fetch(url);
  });
  const result = await runQueryOptimization(f.input, f.deps);
  expect(result.stopReason).toBe('user_stop');
  expect(f.chat).not.toHaveBeenCalled();
  for (const observation of observations) {
    // 並行通信は送信前に加算済みなので、保存済みの数は実 fetch の順序より先に進みうる。
    expect([5, 15, 25].map((calls) => consumedBefore + calls)).toContain(observation.recorded);
    expect(observation.saves).toBe((observation.recorded - consumedBefore - 5) / 10 + 1);
    expect(consumedBefore + observation.sent - observation.recorded).toBeLessThanOrEqual(9);
    expect(observation.recorded).toBeLessThanOrEqual(consumedBefore + result.apiCalls);
  }
  expect(observations.map((entry) => entry.sent)).toEqual(Array.from({ length: 29 }, (_, i) => i + 6));
  const checkpoints = f.write.mock.calls.map(([items]) => items.queryOptimizationCheckpoint as checkpoint.QueryOptimizationCheckpoint);
  expect(checkpoints.map((entry) => entry.resume!.consumed.apiCalls)).toEqual([5, 15, 25, 34].map((calls) => consumedBefore + calls));
  expect(checkpoints[checkpoints.length - 1]!.completion?.status).toBe('stopped');
  const availability = checkpoint.getQueryOptimizationResumeAvailability(checkpoints[2]!, 'same');
  expect(availability).toMatchObject({ available: true, remaining: { apiCalls: 200 - consumedBefore - 25 } });
});

test('途中保存が遅くても別の並行通信は送信でき、10通信ごとの保存を重複させない', async () => {
  const f = setup();
  f.input.maxIterations = 1;
  f.input.initialFormula.blocks[0]!.expression = ['a[tiab]', ...Array.from({ length: 20 }, (_, i) => `word${i}[tiab]`)].join(' OR ');
  const releaseWrite = deferred<void>();
  const sentWhileSaving = deferred<void>();
  let saving = false;
  f.write.mockImplementation(async (items: Record<string, checkpoint.QueryOptimizationCheckpoint>) => {
    if (items.queryOptimizationCheckpoint?.resume?.consumed.apiCalls === 15) {
      saving = true;
      await releaseWrite.promise;
      saving = false;
    }
  });
  const fetch = f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation(async (url: string) => {
    if (saving && f.fetch.mock.calls.length > 15) sentWhileSaving.resolve();
    return fetch(url);
  });
  const running = runQueryOptimization(f.input, f.deps);
  try {
    await sentWhileSaving.promise;
    expect(saving).toBe(true);
    const counts = f.write.mock.calls.map(([items]) => items.queryOptimizationCheckpoint.resume.consumed.apiCalls);
    expect(counts.filter((count) => count === 15)).toHaveLength(1);
    expect(counts.filter((count) => count === 25)).toHaveLength(1);
  } finally { releaseWrite.resolve(); }
  const result = await running;
  expect(result.apiCalls).toBe(f.fetch.mock.calls.length + f.chat.mock.calls.length);
  expect(f.write.mock.calls[f.write.mock.calls.length - 1]![0].queryOptimizationCheckpoint.resume.consumed.apiCalls).toBe(result.apiCalls);
});

test('中断と再開を重ねても途中保存の通信・時間・評価試行を累積する', async () => {
  let previous: checkpoint.QueryOptimizationCheckpoint | undefined;
  for (let resumeCount = 0; resumeCount < 3; resumeCount += 1) {
    const f = setup({ a: { hits: 200, captured: ['11', '22'] }, b: { hits: 300, captured: ['11', '22'] } });
    f.input.inputIdentity = 'same';
    f.input.runId = `run-${resumeCount}`;
    let time = 0;
    f.deps.now = () => time;
    const fetch = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (url: string) => { time += 100; return fetch(url); });
    if (previous) {
      const availability = checkpoint.getQueryOptimizationResumeAvailability(previous, 'same');
      if (!availability.available) throw new Error(availability.reason);
      f.input.initialFormula = availability.data.bestFormula!;
      f.input.maxIterations = availability.remaining.evaluatedTrials;
      f.input.resumeBudget = { runId: previous.runId, limits: availability.data.limits, consumed: availability.data.consumed };
      f.deps.maxApiCalls = availability.remaining.apiCalls;
      f.deps.maxElapsedMs = availability.remaining.elapsedMs;
    }
    await runQueryOptimization(f.input, f.deps);
    const saved = f.write.mock.calls.map(([items]) => items.queryOptimizationCheckpoint as checkpoint.QueryOptimizationCheckpoint)
      .find((record) => record.trials.length === 2 && !record.completion)!;
    expect(saved.resume?.consumed.evaluatedTrials).toBe(resumeCount + 1);
    expect(saved.resume?.consumed.apiCalls).toBeGreaterThan(previous?.resume?.consumed.apiCalls ?? 0);
    expect(saved.resume?.consumed.elapsedMs).toBeGreaterThan(previous?.resume?.consumed.elapsedMs ?? 0);
    expect(saved.resume?.limits).toEqual({ apiCalls: 200, elapsedMs: 600000, evaluatedTrials: 5 });
    previous = saved;
  }
});

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
  // 各区間は10通信未満でも、初期評価・候補評価・最終評価・終了は必ず保存する。
  expect(write.mock.calls.map(([items]) => items.queryOptimizationCheckpoint.resume.consumed.apiCalls)).toEqual([5, 13, 18, 18]);
  expect(result.apiCalls).toBe(fetch.mock.calls.length + 1);
  for (const [, options] of fetch.mock.calls) expect(options).toEqual({ cache: 'no-store' });
  expect(append).not.toHaveBeenCalled();
  expect(upload).not.toHaveBeenCalled();
  expect(setState).not.toHaveBeenCalled();
  const prompt = chat.mock.calls[0]![0][1].content as string;
  for (const text of ['研究1', 'D001', 'approved-1', '研究課題', '組入', '除外', '100', '"terms"']) expect(prompt).toContain(text);
});

test('未捕捉時は件数が増えてもシード増加を採用し、全件捕捉後は超過分を減らす', async () => {
  const { input, deps, chat, fetch } = setup({ a: { hits: 150, captured: ['11'] }, b: { hits: 300, captured: ['11', '22'] },
    c: { hits: 90, captured: ['11', '22'] } }, ['b[tiab]', 'c[tiab]']);
  const result = await runQueryOptimization(input, deps);
  expect(result.status).toBe('achieved');
  expect(result.iterations).toBe(2);
  expect(result.trials.map((trial) => trial.accepted)).toEqual([true, true, true, true]);
  expect(result.best?.formula.blocks[0]?.expression).toBe('c[tiab]');
  expect(chat.mock.calls[1]![0][1].content).toContain('"totalHits": 300');
  expect(result.trials[1]).toMatchObject({ accepted: true, impact: { lostHits: 0, gainedHits: 0 } });
  expect(result.trials[1]?.reason).toContain('（失う集合 0 件、増える集合 0 件）');
  expect(fetch.mock.calls.filter(([url]) => url.includes('efetch.fcgi'))).toHaveLength(1);
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

test('初期式が条件達成でも情報要求直後には完了せず、取得文脈を読んだ判断を記録する', async () => {
  const { input, deps, chat } = setup({ a: { hits: 50, captured: ['11', '22'] } }, ['a[tiab]']);
  requestMesh(chat, [meshRequest]);
  deps.fetchMeshContext = jest.fn().mockResolvedValue([childNode]);
  const progress = jest.fn();
  deps.onProgress = progress;
  const optimize = jest.spyOn(skill, 'optimizeQuery');
  const result = await runQueryOptimization(input, deps);
  expect(chat).toHaveBeenCalledTimes(2);
  expect(optimize.mock.calls[1]![0].meshContext).toContainEqual(childNode);
  expect(result).toMatchObject({ status: 'achieved', iterations: 2, informationTrials: 1 });
  expect(result.trials.map((trial) => trial.kind)).toEqual(['initial', 'information', 'proposal', 'final']);
  expect(result.trials[1]).toMatchObject({ informationResult: { requested: 1, obtained: 1 } });
  expect(result.trials[2]).toMatchObject({ informedBy: { candidateId: 'candidate-1', requested: 1, obtained: 1 },
    reason: '評価済みの同一式への回帰' });
  expect(result.trials[3]).not.toHaveProperty('informedBy');
  expect(result.unmetReasons.join()).not.toContain('判断が未了');
  expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ evaluatedTrials: 1, informationTrials: 1 }));
});

test('連続した情報要求が反復上限に達したら最後の要求を判断未了として残す', async () => {
  const { input, deps, chat } = setup({ a: { hits: 50, captured: ['11', '22'] } });
  input.maxIterations = 2;
  requestMesh(chat, [meshRequest]);
  requestMesh(chat, [meshRequest, meshRequest]);
  deps.fetchMeshContext = jest.fn().mockResolvedValue([childNode]);
  const progress = jest.fn();
  deps.onProgress = progress;
  const result = await runQueryOptimization(input, deps);
  expect(result).toMatchObject({ status: 'needs_review', stopReason: 'iteration_limit', informationTrials: 2 });
  expect(chat).toHaveBeenCalledTimes(2);
  expect(deps.fetchMeshContext).toHaveBeenCalledTimes(1);
  expect(result.trials[2]).toMatchObject({ kind: 'information', informationResult: { requested: 2, obtained: 0 } });
  expect(result.trials.every((trial) => !trial.informedBy)).toBe(true);
  expect(result.unmetReasons).toContain('情報要求 candidate-2 への判断が未了です（文脈へ反映 0 / 要求 2 件）');
  expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ evaluatedTrials: 0, informationTrials: 2 }));
});

test.each(['user_stop', 'api_budget', 'time_budget'] as const)('情報取得途中の %s は停止理由を保持し、履歴にない情報要求を未達理由で参照しない', async (reason) => {
  const { input, deps, chat } = setup();
  requestMesh(chat, [meshRequest, meshRequest]);
  deps.fetchMeshContext = jest.fn().mockResolvedValueOnce([childNode])
    .mockRejectedValueOnce(new QueryOptimizationStopError(reason));
  const result = await runQueryOptimization(input, deps);
  expect(result.stopReason).toBe(reason);
  expect(result.status).not.toBe('achieved');
  expect(result.informationTrials).toBe(1);
  expect(result.trials.map((trial) => trial.kind)).toEqual(['initial']);
  expect(result.unmetReasons.join()).not.toContain('判断が未了');
  expect(result.unmetReasons.join()).not.toContain('candidate-1');
});

test.each(['user_stop', 'time_budget'] as const)('最終 round の情報要求を保存した直後の %s を反復上限に置き換えない', async (reason) => {
  const { input, deps, chat, write } = setup({ a: { hits: 80, captured: ['11', '22'] } });
  input.maxIterations = 1;
  requestMesh(chat, [meshRequest]);
  let informationSaved = false;
  let checksAfterSave = 0;
  write.mockImplementation(async (items: Record<string, checkpoint.QueryOptimizationCheckpoint>) => {
    if (Object.values(items).some((item) => item.trials.some((trial) => trial.candidateId === 'candidate-1'))) {
      informationSaved = true;
    }
  });
  deps.shouldStop = () => {
    if (informationSaved) checksAfterSave += 1;
    // save() 内の境界を通過した後、ループ末尾の境界で停止を検出する。
    return reason === 'user_stop' && checksAfterSave >= 2;
  };
  deps.maxElapsedMs = 1000;
  deps.now = () => reason === 'time_budget' && checksAfterSave >= 2 ? 1000 : 0;
  const result = await runQueryOptimization(input, deps);
  expect(result.stopReason).toBe(reason);
  expect(result.status).not.toBe('achieved');
  expect(result.trials.map((trial) => trial.kind)).toEqual(['initial', 'information']);
  expect(result.unmetReasons).toContain('情報要求 candidate-1 への判断が未了です（文脈へ反映 0 / 要求 1 件）');
  expect(chat).toHaveBeenCalledTimes(1);
});

test.each(['accepted', 'invalid'] as const)('連続要求後の %s の判断は最後の情報要求にだけ対応付ける', async (decision) => {
  const { input, deps, chat } = setup({ a: { hits: 200, captured: ['11', '22'] },
    b: { hits: 50, captured: ['11', '22'] } }, [decision === 'accepted' ? 'b[tiab]' : '#999']);
  input.maxIterations = 3;
  requestMesh(chat, [meshRequest]);
  requestMesh(chat, [meshRequest]);
  deps.fetchMeshContext = jest.fn().mockResolvedValue([childNode]);
  const result = await runQueryOptimization(input, deps);
  expect(result.trials[3]).toMatchObject({ kind: 'proposal', accepted: decision === 'accepted',
    informedBy: { candidateId: 'candidate-2', requested: 1, obtained: 1 } });
  expect(result.unmetReasons.join()).not.toContain('判断が未了');
  expect(result.informationTrials).toBe(2);
});

test.each(['missing', 'empty', 'failure', 'unspecified', 'limited'] as const)('情報要求の %s を構造化した件数で記録し、却下も判断済みとする', async (kind) => {
  const { input, deps, chat } = setup();
  const requests = kind === 'limited' ? Array.from({ length: 4 }, () => meshRequest)
    : [kind === 'unspecified' ? { descriptor: '', treeNumber: '' } : meshRequest];
  requestMesh(chat, requests);
  if (kind !== 'missing') deps.fetchMeshContext = kind === 'failure'
    ? jest.fn().mockRejectedValue(new Error('取得失敗'))
    : jest.fn().mockResolvedValue(kind === 'empty' ? [] : [childNode]);
  const result = await runQueryOptimization(input, deps);
  const counts = { requested: requests.length, obtained: kind === 'limited' ? 3 : 0 };
  expect(result.trials[1]?.informationResult).toEqual(counts);
  expect(result.trials[2]?.informedBy).toEqual({ candidateId: 'candidate-1', ...counts });
  expect(result.trials[2]?.accepted).toBe(false);
  expect(result.trials[3]).not.toHaveProperty('informedBy');
  expect(result.unmetReasons.join()).not.toContain('判断が未了');
});

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
    for (const trial of args[0].trials) {
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

test('目標内でも反復上限 1 の情報要求は追加取得を打ち切り、最終再検証せず判断未了で終わる', async () => {
  const { input, deps, chat } = setup({ a: { hits: 80, captured: ['11', '22'] } });
  input.maxIterations = 1;
  requestMesh(chat, [meshRequest]);
  const evaluate = jest.spyOn(evaluation, 'evaluateQuery');
  const result = await runQueryOptimization(input, deps);
  expect(result).toMatchObject({ status: 'needs_review', stopReason: 'iteration_limit', iterations: 1 });
  expect(chat).toHaveBeenCalledTimes(1);
  expect(evaluate).toHaveBeenCalledTimes(1);
  expect(result.trials.map((trial) => trial.kind)).toEqual(['initial', 'information']);
  expect(result.trials[1]!.after).toBeNull();
  expect(result.trials[1]).toMatchObject({ informationResult: { requested: 1, obtained: 0 },
    reason: 'Disease / C01.100: 未取得: 反復上限に達したため追加取得を打ち切りました。' });
  expect(result.unmetReasons).toContain('情報要求 candidate-1 への判断が未了です（文脈へ反映 0 / 要求 1 件）');
});

test('目標内で反復上限 5 の情報要求は次 round の AI 応答を評価してから条件達成する', async () => {
  const { input, deps, chat } = setup({ a: { hits: 80, captured: ['11', '22'] } });
  input.maxIterations = 5;
  requestMesh(chat, [meshRequest]);
  const optimize = jest.spyOn(skill, 'optimizeQuery');
  const evaluate = jest.spyOn(evaluation, 'evaluateQuery');
  const result = await runQueryOptimization(input, deps);
  expect(result).toMatchObject({ status: 'achieved', stopReason: 'conditions_met', iterations: 2 });
  expect(chat).toHaveBeenCalledTimes(2);
  expect(evaluate).toHaveBeenCalledTimes(3);
  expect(optimize.mock.calls[1]![0].meshRequestResults).toEqual([
    { request: meshRequest, note: '未取得: MeSH 取得 callback が注入されていません。' },
  ]);
  expect(result.trials.map((trial) => trial.kind)).toEqual(['initial', 'information', 'proposal', 'final']);
  expect(result.trials[1]!.after).toBeNull();
  expect(result.trials[2]).toMatchObject({ candidateId: 'candidate-2', accepted: false,
    informedBy: { candidateId: 'candidate-1', requested: 1, obtained: 0 },
    after: { id: 'run:candidate-2' }, reason: '局面の指標に改善がありません' });
  expect(result.trials[3]!.candidateId).toBe('final-2');
  expect(result.unmetReasons).toEqual([]);
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
