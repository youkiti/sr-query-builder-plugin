import type { LlmProviderFactory } from './llmProviderService';
import { papers, measureSet, setImpact, assertSetTransition, createSetSearch } from '../../../tests/fixtures/pubmedSets';
import * as google from '@/lib/google';
import * as evaluation from './queryEvaluationService';
import * as skill from '@/features/formula/skills/optimizeQuery';
import * as checkpoint from './queryOptimizationCheckpointService';
import { withRetry, withSignalDeadline, LlmProviderError, type LLMProvider } from '@/lib/llm';
import { esearch, sharedEutilsRateLimiters } from '@/lib/ncbi';
import { validateCombinationExpression } from '@/lib/combination-expression';
import { samplePmids, diffOptimizationFormula, runQueryOptimization, validateOptimizationCandidate, QueryOptimizationStopError, type QueryOptimizationInput, type QueryOptimizationDeps } from './queryOptimizationService';
import { evaluateHeldCandidateAdoptionGate } from './queryOptimizationReviewSections';

interface Outcome { pmids: string[]; blockPmids?: Record<string, string[]>;
  articles?: Record<string, { abstract?: string; mesh?: string[] }> }

function setup(outcomes: Record<string, Outcome> = { a: { pmids: papers(200, ['11', '22']) } }, proposals = ['b[tiab]']) {
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
  // テスト用の概念名を含む式にはその集合を対応付ける。固定ブロックは全候補を含む。
  // ブロック別 fixture も PMID を正典にし、uid での捕捉は共通 API が交差を取る。
  // 未指定の補助語は初期概念と同じ集合の別名として扱う。
  const universe = [...new Set([...Object.values(outcomes).flatMap((outcome) => outcome.pmids), ...input.seedPmids])];
  const sets = createSetSearch((query) => {
    if (query.includes('[uid]')) return undefined;
    if (/^(pediatric|child)\[tiab\]$/.test(query)) return [];
    // 除外語の OR は個別集合から評価し、初期概念の集合で上書きしない。
    if (query === 'pediatric[tiab] OR child[tiab]') return undefined;
    const tagged: readonly string[] = query.match(/[A-Za-z0-9]+\[tiab\]/g) ?? [];
    const key = Object.keys(outcomes).find((term) => tagged.includes(`${term}[tiab]`));
    const outcome = outcomes[key ?? 'a']!;
    const blockId = key && query.includes('fixed[tiab]') && query.includes('[pt]') ? '3'
      : key ? '1' : query.includes('fixed[tiab]') ? '2' : query.includes('[pt]') ? 'RCTfilter' : '1';
    return outcome.blockPmids?.[blockId] ?? (blockId === '2' || blockId === 'RCTfilter' ? universe : outcome.pmids);
  });
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
    return { ok: true, status: 200, json: async () => ({ esearchresult: sets.search(query, Number(new URL(resource).searchParams.get('retmax') ?? 20)) }) };
  });
  let next = 0;
  const chat = jest.fn().mockImplementation(async () => ({
    text: JSON.stringify({ target_block_id: '1', proposed_expression: proposals[Math.min(next++, proposals.length - 1)],
      rationale: '研究基準に沿う変更', added_terms: [], removed_terms: [],
      replaced_terms: [{ before: write.mock.calls[write.mock.calls.length - 1]?.[0]?.queryOptimizationCheckpoint.resume?.bestFormula?.blocks[0]?.expression
        ?? input.initialFormula.blocks[0]!.expression,
        after: proposals[Math.min(next - 1, proposals.length - 1)] }], measurement_ids: ['run:initial'] }),
    tokensIn: null, tokensOut: null, raw: {},
  }));
  const provider: LLMProvider = { providerId: 'gemini', model: 'test', chat };
  const forPurpose = jest.fn<ReturnType<LlmProviderFactory['forPurpose']>, Parameters<LlmProviderFactory['forPurpose']>>(
    (_purpose, onRequestState, attempts) => withRetry(withSignalDeadline(provider), { ...attempts, onRequestState }));
  const write = jest.fn().mockResolvedValue(undefined);
  const deps: QueryOptimizationDeps = { eutils: { fetch, maxRetries: 0, rateLimiter: { acquire: async () => undefined } },
    llmFactory: { model: 'test', forPurpose }, checkpoint: { read: async () => undefined, write } };
  return { input, deps, fetch, chat, write, forPurpose, sets };
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

describe('同一スナップショットの PMID 集合 fixture', () => {
  test.each([
    ['追加のみ', ['11'], ['11', '22', '901'], 0, 2],
    ['削除のみ', ['11', '901'], ['11'], 1, 0],
    ['置換', ['11', '901'], ['11', '902', '903'], 1, 2],
    ['同一集合', ['11', '901'], ['901', '11', '11'], 0, 0],
    ['シードの入れ替わり', ['11', '901'], ['22', '901'], 1, 1],
  ] as const)('%s の件数・捕捉・両方向の差集合を同じ PMID から導く', (_, before, after, lostHits, gainedHits) => {
    const mapping: Record<string, readonly string[]> = { before, after };
    const api = createSetSearch((query) => mapping[query]);
    const beforeHits = Number(api.search('before', 0).count);
    const afterHits = Number(api.search('after', 0).count);
    expect(api.search('(before) NOT (after)', 10000)).toEqual({ count: String(lostHits),
      idlist: before.filter((id) => !after.some((other) => other === id)) });
    expect(api.search('(after) NOT (before)', 0)).toEqual({ count: String(gainedHits), idlist: [] });
    // 外側の確認では逆方向にも PMID を要求する。方向は retmax に依存しない。
    expect(api.search('(after) NOT (before)', 10000).idlist).toHaveLength(gainedHits);
    expect(afterHits).toBe(beforeHits - lostHits + gainedHits);
    assertSetTransition(before, after, { beforeHits, afterHits, lostHits, gainedHits });
    for (const query of ['before', 'after']) {
      const measured = measureSet(mapping[query]!, ['11', '22']);
      expect(api.search(`(${query}) AND (11[uid] OR 22[uid])`, 10000).idlist).toEqual(measured.capturedPmids);
      expect(api.search(query, 1).count).toBe(String(measured.totalHits));
    }
    expect(setImpact(before, after)).toMatchObject({ lostHits, gainedHits });
  });

  test('件数が減ったのに失う集合 0 件と書いた正常系 fixture は作成時に落とす', () => {
    expect(() => assertSetTransition(['11', '901'], ['11'],
      { beforeHits: 2, afterHits: 1, lostHits: 0, gainedHits: 0 })).toThrow('集合と不整合: lostHits');
    expect(() => assertSetTransition(['11'], ['11'],
      { beforeHits: 2, afterHits: 1, lostHits: 0, gainedHits: 0 })).toThrow('集合と不整合: beforeHits');
  });

  test.each([[['11']], [['11', '902']]] as const)('現行仕様では件数削減を自動採用できない: 候補 %j', async (after) => {
    const before = ['11', '901', '903'];
    const f = setup({ a: { pmids: before }, b: { pmids: [...after] } });
    f.input.seedPmids = ['11'];
    f.input.maxHits = 1;
    f.input.maxIterations = 1;
    const result = await runQueryOptimization(f.input, f.deps);
    const impact = setImpact(before, after);
    // 変更後 = 変更前 - 失う + 増える。削減時は失う > 0 なので、採用条件の lostHits === 0 と両立しない。
    expect(after.length).toBe(before.length - impact.lostHits + impact.gainedHits);
    expect(impact.lostHits).toBeGreaterThan(0);
    expect(result.trials[1]).toMatchObject({ accepted: false, held: true, impact: { lostHits: impact.lostHits, gainedHits: impact.gainedHits } });
    expect(result.best?.formula.blocks[0]?.expression).toBe('a[tiab]');
  });
});

test.each(['lost', 'gained'] as const)('異常系: 差集合 %s の不正な件数を意図的に注入し、保留後に再測定する', async (stage) => {
  const f = setup({ a: { pmids: ['11'] }, b: { pmids: ['11', '22'] } });
  const original = f.fetch.getMockImplementation()!;
  let measurements = 0;
  f.fetch.mockImplementation(async (url: string) => {
    const response = await original(url);
    const params = new URL(url).searchParams;
    if (params.get('term')?.includes(') NOT (') && params.get('retmax') === (stage === 'lost' ? '10000' : '0')
      && measurements++ === 0) {
      const body = await response.json();
      // 正常系の集合から得た応答をここだけ壊す。不正値を 0 件に置き換えて採用してはいけない。
      return { ...response, json: async () => ({ esearchresult: { ...body.esearchresult, count: '1x' } }) };
    }
    return response;
  });
  const result = await runQueryOptimization(f.input, f.deps);
  expect(result.trials[1]).toMatchObject({ accepted: false, held: true, impact: {
    [stage === 'lost' ? 'lostHits' : 'gainedHits']: null, error: expect.stringContaining('不正な値'),
  } });
  expect(result.trials[2]).toMatchObject({ accepted: true, impact: { lostHits: 0, gainedHits: 1 } });
  expect(result.trials[2]?.duplicateOf).toBeUndefined();
  expect(measurements).toBe(2);
});

test.each([true, false])('未捕捉 %s のときだけ全ブロックの捕捉表と書誌を取得する', async (missed) => {
  const f = setup({ a: { pmids: papers(200, missed ? ['11'] : ['11', '22']),
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
  // 同一式の候補は測定せず、初期実測の 1 回に、未捕捉時だけ全ブロック分を加える。
  expect(captureQueries(f.fetch)).toHaveLength(1 + (missed ? f.input.initialFormula.blocks.length : 0));
  expect(f.fetch.mock.calls.filter(([url]) => url.includes('efetch.fcgi'))).toHaveLength(missed ? 1 : 0);
  expect(result.apiCalls).toBe(f.fetch.mock.calls.length + 1);
});

test.each(['declared', 'implicit', 'replacement', 'captured'])('削除制御 %s を測定前に適用する', async (kind) => {
  const f = setup({ a: { pmids: papers(200, kind === 'captured' ? ['11', '22'] : ['11']) },
    b: { pmids: papers(150, ['11', '22']) } });
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
  const f = setup({ a: { pmids: papers(200, ['11']) } });
  f.input.initialFormula.blocks[0]!.expression = before;
  f.input.maxIterations = 1;
  f.chat.mockResolvedValue({ text: JSON.stringify({ target_block_id: '1', proposed_expression: after,
    added_terms: ['c[tiab]'], removed_terms: [], replaced_terms: replaced }) });
  const result = await runQueryOptimization(f.input, f.deps);
  expect(result.trials[1]).toMatchObject({ kind: 'proposal', after: expect.any(Object) });
  expect(result.trials[1]!.reason).not.toContain('削除案を受け付けません');
});

test('暗黙の削除の却下理由には元の大文字小文字と空白を残す', async () => {
  const f = setup({ a: { pmids: papers(200, ['11']) } });
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
  const f = setup({ a: { pmids: papers(200, ['11']) } });
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
  const f = setup({ a: { pmids: papers(200, ['11']), blockPmids: {
    '1': papers(201, ['11', '22']), '2': papers(201, ['11', '22']), RCTfilter: papers(200, ['11']), '3': papers(200, ['11']),
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
  const f = setup({ a: { pmids: papers(200, ['11']), blockPmids: {
    '1': papers(201, ['11', '22']), '2': papers(201, ['11', '22']), RCTfilter: papers(200, ['11']), '3': papers(200, ['11']),
  }, articles: { '22': { abstract: '抄録', mesh: ['Disease'] } } } }, ['a[tiab]']);
  const result = await runQueryOptimization(f.input, f.deps);
  expect(result.seedDiagnoses).toEqual([expect.objectContaining({ pmid: '22', title: '研究 22', year: 2024,
    hasAbstract: true, meshHeadingCount: 1, recoverableByTerms: false, blockingBlockIds: ['RCTfilter', '3'] })]);
  expect(result.seedDiagnoses![0]!.note).toContain('承認外のブロック（研究デザインフィルタ等）');
  expect(result.seedDiagnoses![0]!.note).not.toContain('結合行');
  expect(result.unmetReasons.join(' ')).toContain('語の調整では回収できないシード');
});

test('承認済み概念ブロックだけが落とすシードは、結合行が最終式で落としていても語で回収できると診断する', async () => {
  const f = setup({ a: { pmids: papers(200, ['11']), blockPmids: {
    '1': papers(200, ['11']), '2': papers(201, ['11', '22']), RCTfilter: papers(201, ['11', '22']), '3': papers(200, ['11']),
  } } }, ['a[tiab]']);
  const result = await runQueryOptimization(f.input, f.deps);
  expect(result.seedDiagnoses![0]).toMatchObject({ blockingBlockIds: ['1', '3'], recoverableByTerms: true });
  expect(result.seedDiagnoses![0]!.note).toContain('ブロック #1 が落としている');
  expect(result.seedDiagnoses![0]!.note).not.toContain('#3');
});

test('異常系: ブロック間の不整合を注入し、全概念ブロックが捕捉しているのに最終式で未捕捉なら結合構造と診断する', async () => {
  const f = setup({ a: { pmids: papers(200, ['11']), blockPmids: {
    '1': papers(201, ['11', '22']), '2': papers(201, ['11', '22']), RCTfilter: papers(201, ['11', '22']), '3': papers(200, ['11']),
  } } }, ['a[tiab]']);
  const result = await runQueryOptimization(f.input, f.deps);
  expect(result.seedDiagnoses![0]).toMatchObject({ recoverableByTerms: false, blockingBlockIds: ['3'] });
  expect(result.seedDiagnoses![0]!.note).toContain('結合構造');
});

test.each([false, true])('捕捉表の失敗（全行 %s）を空集合にせず処理を続ける', async (all) => {
  const f = setup({ a: { pmids: papers(200, ['11']) } }, ['a[tiab]']);
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
  const f = setup({ a: { pmids: papers(200, ['11']), articles: {
    '22': { abstract: '回収するシード' }, '33': { abstract: '残るシード' },
  } }, b: { pmids: papers(300, ['11', '22']) } }, ['b[tiab]', 'b[tiab]']);
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
  const f = setup({ a: { pmids: papers(200, ['11']) } });
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
  const f = setup({ a: { pmids: papers(200, ['11']), articles: { '22': { abstract: '長'.repeat(1501) } } } }, ['a[tiab]']);
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
  const { input, deps, fetch } = setup({ a: { pmids: [...papers(50, ['11', '22']), '901', '902'] },
    b: { pmids: papers(50, ['11', '22']) } });
  input.maxIterations = 1;
  input.maxHits = 50;
  const result = await runQueryOptimization(input, deps);
  expect(result.trials[1]).toMatchObject({ accepted: false, held: true, impact: {
    lostHits: 2, gainedHits: 0, error: null, inspected: [
      { pmid: '901', title: '研究 901', year: 2024 }, { pmid: '902', title: '研究 902', year: 2024 },
    ],
  } });
  expect(result.trials[1]?.reason).toContain('失う集合 2 件');
  expect(result.trials[1]?.reason).toContain('無作為抽出した書誌 2 件 / 全体 2');
  expect(result.best?.measurement.totalHits).toBe(52);
  expect(result.status).toBe('needs_review');
  expect(result.unmetReasons).toContain('レビュー候補として保留: candidate-1（失う 2 件・増える 0 件）');
  expect(fetch.mock.calls.some(([url]) => url.includes('efetch.fcgi') && decodeURIComponent(url).includes('901,902'))).toBe(true);
  expect(result.apiCalls).toBe(fetch.mock.calls.length + 1);
});

test.each(['both', 'gained', 'efetch'])('差集合・書誌取得の失敗 %s は実測済み件数を保ち保留する', async (failure) => {
  const { input, deps, fetch } = setup({ a: { pmids: papers(200, failure === 'gained' ? ['11'] : ['11', '22']) },
    b: { pmids: papers(failure === 'gained' ? 201 : 50, ['11', '22']) } });
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

test.each([20, 21, 50, 100, 101])('失う集合 %i 件は閾値以下なら全件取得し、exclude 保存後に採用ゲートを満たせる', async (lostHits) => {
  const remaining = papers(50, ['11', '22']);
  const lost = Array.from({ length: lostHits }, (_, index) => String(900 + index));
  const { input, deps, fetch } = setup({ a: { pmids: [...remaining, ...lost] }, b: { pmids: remaining } });
  input.maxIterations = 1;
  input.maxHits = 50;
  const result = await runQueryOptimization(input, deps);
  const trial = result.trials[1]!;
  const expectedCount = lostHits <= 100 ? lostHits : 20;
  expect(trial).toMatchObject({ held: true, impact: { lostHits, error: null,
    sample: { method: 'all', populationCount: lostHits, retrievedCount: lostHits } } });
  expect(trial.impact!.inspected).toHaveLength(expectedCount);
  const requests = fetch.mock.calls.map(([url]) => new URL(url as string));
  const bibliography = requests.filter((url) => url.pathname.endsWith('efetch.fcgi'));
  expect(bibliography).toHaveLength(1);
  const pmids = bibliography[0]!.searchParams.get('id')!.split(',');
  expect(pmids).toEqual(trial.impact!.sample!.pmids);
  if (lostHits <= 100) expect(pmids).toEqual(lost);
  expect(requests.filter((url) => url.searchParams.get('term')?.includes(') NOT ('))).toHaveLength(2);
  expect(evaluateHeldCandidateAdoptionGate(trial, undefined, { bestCapturedPmids: result.best?.measurement.capturedPmids }).allowed).toBe(false);
  const decisions = Object.fromEntries(pmids.map((pmid) => [pmid, {
    decision: 'exclude' as const, status: 'saved' as const, error: null,
  }]));
  expect(evaluateHeldCandidateAdoptionGate(trial, decisions, { bestCapturedPmids: result.best?.measurement.capturedPmids })).toEqual({
    allowed: true, judgedCount: expectedCount, sampledCount: expectedCount, reason: null,
  });
});

test('削除影響は run の予算で測り、閾値超過の確認書誌を無作為抽出した 20 件に制限する', async () => {
  const { input, deps, fetch } = setup({ a: { pmids: papers(200, ['11', '22']) },
    b: { pmids: papers(50, ['11', '22']) } });
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
  expect(new URL(url).searchParams.get('id')!.split(',')).toEqual(result.trials[1]!.impact!.sample!.pmids);
  expect(result.apiCalls).toBe(fetch.mock.calls.length + 1);
});

test('2 回の保留は改善なしで停止し次の AI に理由と件数を渡す', async () => {
  const { input, deps, chat } = setup({ a: { pmids: papers(200, ['11', '22']) },
    b: { pmids: papers(50, ['11', '22']) },
    c: { pmids: papers(40, ['11', '22']) } }, ['b[tiab]', 'c[tiab]']);
  const result = await runQueryOptimization(input, deps);
  expect(result.stopReason).toBe('no_improvement');
  expect(chat).toHaveBeenCalledTimes(2);
  expect(result.trials.filter((trial) => trial.held)).toHaveLength(2);
  const prompt = chat.mock.calls[1]![0][1].content as string;
  for (const text of ['"held": true', '"lostHits": 150', '失う集合 150 件']) expect(prompt).toContain(text);
});

test('保留の 2 件を次の AI に渡し、その後条件達成しても未達理由には保留を残さない', async () => {
  const { input, deps, chat } = setup({ a: { pmids: ['11', '901', '902'] },
    b: { pmids: ['11', '22'] },
    c: { pmids: ['11', '22', '901', '902'] } }, ['b[tiab]', 'c[tiab]']);
  input.maxIterations = 2;
  const result = await runQueryOptimization(input, deps);
  expect(result).toMatchObject({ status: 'achieved', stopReason: 'conditions_met', unmetReasons: [] });
  expect(result.trials[1]?.held).toBe(true);
  expect(chat.mock.calls[1]![0][1].content).toContain('"held": true');
  expect(chat.mock.calls[1]![0][1].content).toContain('"lostHits": 2');
});

test.each(['seed_loss', 'within_target', 'repeated', 'syntax', 'failure'])(
  '採用判定前の却下 %s には差集合を測らない', async (kind) => {
    const { input, deps, fetch } = setup({ a: { pmids: papers(kind === 'within_target' ? 80 : 200, ['11', '22']) },
      b: { pmids: papers(40, kind === 'seed_loss' ? ['11'] : ['11', '22']) } },
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
  const { input, deps, fetch } = setup({ a: { pmids: papers(200, ['11', '22']) },
    b: { pmids: papers(50, ['11', '22']) } });
  const original = fetch.getMockImplementation()!;
  fetch.mockImplementation(async (url: string) => {
    const params = new URL(url).searchParams;
    if ((stage === 'efetch' && url.includes('efetch.fcgi'))
      || (params.get('term')?.includes(') NOT (') && params.get('retmax') === (stage === 'lost' ? '10000' : stage === 'gained' ? '0' : 'unused'))) {
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
  const f = setup({ a: { pmids: papers(300, ['11', '22']) }, b: { pmids: papers(200, ['11', '22']) },
    c: { pmids: papers(90, ['11', '22']) } }, ['b[tiab]', 'c[tiab]']);
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
  expect(result.stopReason).toBe('no_improvement');
  expect(result.trials[1]).toMatchObject({ accepted: false, held: true, after: { id: 'resumed:candidate-1', totalHits: 200 } });
  expect(evaluate.mock.calls.map(([formula]) => formula.blocks[0]!.expression)).toEqual(['a[tiab]', 'b[tiab]', 'c[tiab]']);
  expect(optimize.mock.calls[0]![0].trials).toBe(result.trials);
  expect(result.trials.map((trial) => trial.reason)).not.toContain('前回はシードを失った');
  expect(optimize.mock.calls[0]![0].previousRejectedTrials).toEqual(f.input.previousRejectedTrials);
  const prompt = f.chat.mock.calls[0]![0][1].content as string;
  for (const text of ['前回はシードを失った', old.fingerprint, '過去の run の却下記録（未再検証']) expect(prompt).toContain(text);
});

test('人が「除外」した過去の却下は測定前に却下し、AI 由来の却下・保留とは理由で区別する（issue #172）', async () => {
  const f = setup({ a: { pmids: papers(300, ['11', '22']) }, b: { pmids: papers(200, ['11', '22']) } });
  const pastFormula = { ...f.input.initialFormula, blocks: f.input.initialFormula.blocks.map((block) => ({ ...block,
    expression: block.id === '1' ? 'b[tiab]' : block.expression })) };
  const rejected = await evaluation.evaluateQuery(pastFormula, f.input.seedPmids, { eutils: f.deps.eutils });
  f.input.runId = 'resumed';
  f.input.previousRejectedTrials = [
    { formula: pastFormula, reason: '前回は保留になった', fingerprint: rejected.fingerprint, rejectedByHuman: true },
  ];
  const result = await runQueryOptimization(f.input, f.deps);
  // 測定していれば after / held が付くが、人の除外は測定前に却下するのでどちらも付かない。
  expect(result.trials[1]).toMatchObject({ accepted: false, after: null, reason: expect.stringContaining('人が除外した候補と同じ式') });
  expect(result.trials[1]!.reason).toContain('前回は保留になった');
  expect(result.trials[1]!.held).toBeFalsy();
  expect(result.trials[1]!.duplicateOf).toBeUndefined();
});

test('再開の累積消費量を途中と終了の両方に保存し、再び再開しても元の予算を増やさない', async () => {
  const f = setup({ a: { pmids: papers(300, ['11', '22']) }, b: { pmids: papers(200, ['11', '22']) } });
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

test('途中保存が遅い場合は同じキーの次の保存を待機し、10通信ごとの記録を重複させない', async () => {
  const f = setup();
  f.input.maxIterations = 1;
  f.input.initialFormula.blocks[0]!.expression = ['a[tiab]', ...Array.from({ length: 20 }, (_, i) => `word${i}[tiab]`)].join(' OR ');
  const releaseWrite = deferred<void>();
  const writeStarted = deferred<void>();
  f.write.mockImplementation(async (items: Record<string, checkpoint.QueryOptimizationCheckpoint>) => {
    if (items.queryOptimizationCheckpoint?.resume?.consumed.apiCalls === 15) {
      writeStarted.resolve();
      await releaseWrite.promise;
    }
  });
  const running = runQueryOptimization(f.input, f.deps);
  try {
    await writeStarted.promise;
    for (let i = 0; i < 100; i += 1) await Promise.resolve();
    const counts = f.write.mock.calls.map(([items]) => items.queryOptimizationCheckpoint.resume.consumed.apiCalls);
    expect(counts.filter((count) => count === 15)).toHaveLength(1);
    expect(counts.filter((count) => count === 25)).toHaveLength(0);
  } finally { releaseWrite.resolve(); }
  const result = await running;
  expect(result.apiCalls).toBe(f.fetch.mock.calls.length + f.chat.mock.calls.length);
  const counts = f.write.mock.calls.map(([items]) => items.queryOptimizationCheckpoint.resume.consumed.apiCalls);
  expect(counts.filter((count) => count === 25)).toHaveLength(1);
  expect(counts[counts.length - 1]).toBe(result.apiCalls);
});

test('中断と再開を重ねても途中保存の通信・時間・評価試行を累積する', async () => {
  let previous: checkpoint.QueryOptimizationCheckpoint | undefined;
  for (let resumeCount = 0; resumeCount < 3; resumeCount += 1) {
    const f = setup({ a: { pmids: papers(200, ['11', '22']) }, b: { pmids: papers(300, ['11', '22']) } });
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
  const { input, deps, fetch, chat, forPurpose, write } = setup({ a: { pmids: papers(80, ['11', '22']) } }, ['a[tiab]']);
  const append = jest.spyOn(google, 'appendRow');
  const upload = jest.spyOn(google, 'uploadTextFile');
  const evaluate = jest.spyOn(evaluation, 'evaluateQuery');
  const setState = jest.fn();
  const result = await runQueryOptimization(input, { ...deps, ...{ store: { setState } } });
  expect(result).toMatchObject({ status: 'achieved', stopReason: 'conditions_met', iterations: 1, unmetReasons: [] });
  expect(chat).toHaveBeenCalledTimes(1);
  expect(forPurpose).toHaveBeenCalledWith('optimize_query', undefined, expect.objectContaining({
    beforeAttempt: expect.any(Function), createSignal: expect.any(Function), sleep: expect.any(Function),
  }));
  expect(evaluate).toHaveBeenCalledTimes(2);
  expect(result.trials.map((trial) => trial.candidateId)).toEqual(['initial', 'candidate-1', 'final-1']);
  expect(result.trials[1]?.accepted).toBe(false);
  expect(write).toHaveBeenCalledTimes(4);
  // 各区間は10通信未満でも、初期評価・候補評価・最終評価・終了は必ず保存する。
  expect(write.mock.calls.map(([items]) => items.queryOptimizationCheckpoint.resume.consumed.apiCalls)).toEqual([5, 8, 13, 13]);
  expect(result.apiCalls).toBe(fetch.mock.calls.length + 1);
  for (const [, options] of fetch.mock.calls) expect(options).toEqual({ cache: 'no-store', signal: expect.any(AbortSignal) });
  expect(append).not.toHaveBeenCalled();
  expect(upload).not.toHaveBeenCalled();
  expect(setState).not.toHaveBeenCalled();
  const prompt = chat.mock.calls[0]![0][1].content as string;
  for (const text of ['研究1', 'D001', 'approved-1', '研究課題', '組入', '除外', '100', '"terms"']) expect(prompt).toContain(text);
});

test('未捕捉時は件数が増えてもシード増加を採用し、全件捕捉後の件数削減候補は保留する', async () => {
  const { input, deps, chat, fetch } = setup({ a: { pmids: papers(150, ['11']) }, b: { pmids: papers(300, ['11', '22']) },
    c: { pmids: papers(90, ['11', '22']) } }, ['b[tiab]', 'c[tiab]']);
  input.maxIterations = 2;
  // 同一スナップショットで件数が減れば失う集合は必ず正となり、自動採用の条件を満たさない。
  const result = await runQueryOptimization(input, deps);
  expect(result.status).toBe('needs_review');
  expect(result.iterations).toBe(2);
  expect(result.trials.map((trial) => trial.accepted)).toEqual([true, true, false]);
  expect(result.best?.formula.blocks[0]?.expression).toBe('b[tiab]');
  expect(chat.mock.calls[1]![0][1].content).toContain('"totalHits": 300');
  expect(result.trials[1]).toMatchObject({ accepted: true, impact: { lostHits: 0, gainedHits: 150 } });
  expect(result.trials[1]?.reason).toContain('（失う集合 0 件、増える集合 150 件）');
  expect(fetch.mock.calls.filter(([url]) => url.includes('efetch.fcgi'))).toHaveLength(2);
  expect(result.trials[2]).toMatchObject({ accepted: false, held: true, impact: { lostHits: 210, gainedHits: 0 } });
});

test('上限だけ満たしてシードを失う候補は却下し、次の AI へ前後の実測と理由を返す', async () => {
  const { input, deps, chat } = setup({ a: { pmids: papers(200, ['11', '22']) }, b: { pmids: papers(50, ['11']) },
    c: { pmids: papers(150, ['11', '22']) } }, ['b[tiab]', 'c[tiab]']);
  input.maxIterations = 2;
  const result = await runQueryOptimization(input, deps);
  expect(result).toMatchObject({ status: 'needs_review', stopReason: 'no_improvement' });
  expect(result.best?.measurement.totalHits).toBe(200);
  expect(result.best?.formula.blocks[0]?.expression).toBe('a[tiab]');
  expect(result.unmetReasons.join(' ')).toContain('目安件数 100');
  const prompt = chat.mock.calls[1]![0][1].content as string;
  for (const text of ['捕捉済みシードを失う: 22', '"accepted": false', '"totalHits": 200', '"totalHits": 50']) expect(prompt).toContain(text);
  expect(result.trials[2]?.before?.totalHits).toBe(200);
  expect(result.trials[2]).toMatchObject({ accepted: false, held: true, impact: { lostHits: 50, gainedHits: 0 } });
});

test('捕捉数が同じでも捕捉集合を入れ替えた候補は却下する', async () => {
  const { input, deps } = setup({ a: { pmids: papers(200, ['11']) }, b: { pmids: papers(50, ['22']) } });
  input.maxIterations = 1;
  const result = await runQueryOptimization(input, deps);
  expect(result.best?.measurement.capturedPmids).toEqual(['11']);
  expect(result.trials[1]?.reason).toContain('シードを失う: 11');
});

test('未捕捉が残る間は件数削減だけを改善とせず、2 回連続で停止する', async () => {
  const { input, deps, chat } = setup({ a: { pmids: papers(200, ['11']) }, b: { pmids: papers(150, ['11']) },
    c: { pmids: papers(50, ['11']) } }, ['b[tiab]', 'c[tiab]']);
  const result = await runQueryOptimization(input, deps);
  expect(result).toMatchObject({ status: 'needs_review', stopReason: 'no_improvement', iterations: 2 });
  expect(chat).toHaveBeenCalledTimes(2);
  expect(result.best?.measurement.totalHits).toBe(200);
  expect(result.unmetReasons.join(' ')).toContain('未捕捉シード: 22');
});

test('目標内での件数削減は改善にせず初期式を最終検証する', async () => {
  const { input, deps } = setup({ a: { pmids: papers(80, ['11', '22']) }, b: { pmids: papers(40, ['11', '22']) } });
  const result = await runQueryOptimization(input, deps);
  expect(result.status).toBe('achieved');
  expect(result.best?.measurement.totalHits).toBe(80);
  expect(result.trials[1]?.accepted).toBe(false);
});

test('fingerprint が初期式と一致する再提案は測定前に却下し、2 回連続で改善なしとして停止する', async () => {
  const { input, deps, chat } = setup({ a: { pmids: papers(200, ['11', '22']) } }, ['a[tiab]']);
  const result = await runQueryOptimization(input, deps);
  expect(result).toMatchObject({ status: 'needs_review', stopReason: 'no_improvement', iterations: 2 });
  expect(result.trials[1]).toMatchObject({ after: null, duplicateOf: 'initial' });
  expect(result.trials[2]).toMatchObject({ after: null, duplicateOf: 'initial' });
  expect(await evaluation.formulaFingerprint(result.trials[1]!.formula)).toBe(result.trials[0]?.after?.fingerprint);
  expect(chat).toHaveBeenCalledTimes(2);
});

test('却下済みの式の再提案は改善なしの 2 回目として停止する', async () => {
  const { input, deps } = setup({ a: { pmids: papers(200, ['11', '22']) }, b: { pmids: papers(300, ['11', '22']) } });
  const result = await runQueryOptimization(input, deps);
  expect(result).toMatchObject({ stopReason: 'no_improvement', iterations: 2 });
  expect(result.best?.measurement.totalHits).toBe(200);
});

test('採用直後の測定前却下が 1 回なら次の反復で AI を呼び出す', async () => {
  const { input, deps, chat } = setup({ a: { pmids: papers(200, []) },
    b: { pmids: papers(201, ['11']) }, c: { pmids: papers(202, ['11', '22']) } },
  ['b[tiab]', 'b[tiab]', 'c[tiab]']);
  input.maxIterations = 3;
  const result = await runQueryOptimization(input, deps);
  expect(result).toMatchObject({ stopReason: 'iteration_limit', iterations: 3 });
  expect(result.trials[1]).toMatchObject({ accepted: true });
  expect(result.trials[2]).toMatchObject({ accepted: false, after: null, duplicateOf: 'candidate-1' });
  expect(result.trials[3]).toMatchObject({ accepted: true });
  expect(chat).toHaveBeenCalledTimes(3);
  expect(result.best?.measurement.totalHits).toBe(202);
});

test('既定 5 回に達したら次の AI 呼び出しを開始しない', async () => {
  const outcomes: Record<string, Outcome> = {};
  ['a', 'b', 'c', 'd', 'e', 'f'].forEach((key, index) => { outcomes[key] = { pmids: papers(200 + index, ['11', '22', '33', '44', '55'].slice(0, index)) }; });
  const { input, deps, chat } = setup(outcomes, ['b[tiab]', 'c[tiab]', 'd[tiab]', 'e[tiab]', 'f[tiab]']);
  input.seedPmids = ['11', '22', '33', '44', '55'];
  const result = await runQueryOptimization(input, deps);
  expect(result).toMatchObject({ stopReason: 'iteration_limit', iterations: 5 });
  expect(chat).toHaveBeenCalledTimes(5);
  expect(result.best?.measurement.totalHits).toBe(205);
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
  const { input, deps } = setup({ a: { pmids: papers(40, ['11']) }, b: { pmids: papers(90, ['11', '22']) } }, ['(b[tiab] OR extra[tiab]) AND more[tiab]']);
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
  const { input, deps } = setup({ a: { pmids: papers(80, []) } }, ['a[tiab]']);
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
  const { input, deps, chat } = setup({ a: { pmids: papers(200, ['11', '22']) }, b: { pmids: papers(150, ['11', '22']) } });
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

test('異常系: 索引変動による件数増加を最終再検証へ注入し、達成にしない', async () => {
  const { input, deps } = setup({ a: { pmids: papers(80, ['11', '22']) } }, ['a[tiab]']);
  const original = evaluation.evaluateQuery;
  jest.spyOn(evaluation, 'evaluateQuery').mockImplementationOnce(original)
    .mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      // 同一式への件数だけを変えて索引変動を意図的に注入する。
      if (result.finalQuery.status === 'success') result.finalQuery.totalHits = 120;
      return result;
    });
  const result = await runQueryOptimization(input, deps);
  expect(result).toMatchObject({ status: 'needs_review', stopReason: 'revalidation_failed' });
  expect(result.trials[2]?.after?.totalHits).toBe(120);
  expect(result.unmetReasons.join(' ')).toContain('目安件数 100 件を超えています（実測 120 件）');
  expect(result.best?.measurement.totalHits).toBe(80);
});

test('最終再検証でシード喪失・API 失敗を検出する', async () => {
  const { input, deps, fetch } = setup({ a: { pmids: papers(80, ['11', '22']) } }, ['a[tiab]']);
  const original = evaluation.evaluateQuery;
  jest.spyOn(evaluation, 'evaluateQuery').mockImplementationOnce(original)
    .mockImplementationOnce(async (...args) => {
      fetch.mockRejectedValue(new Error('再検証不能'));
      return original(...args);
    });
  expect((await runQueryOptimization(input, deps)).status).toBe('error');
});

test('待機中の入力変更に影響されず、シード重複を除去する', async () => {
  const { input, deps, chat } = setup({ a: { pmids: papers(80, ['11', '22']) } }, ['a[tiab]']);
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
  const { input, deps, fetch, chat } = setup({ a: { pmids: papers(80, ['11', '22']) } }, ['a[tiab]']);
  const expression = 'a[tiab] OR "Disease/therapy"[Majr:noexp]';
  input.initialFormula.blocks[0]!.expression = expression;
  input.initialFormula.blocks[1]!.expression = expression;
  const result = await runQueryOptimization(input, deps);
  expect(result.status).toBe('achieved');
  const queries = fetch.mock.calls.map(([url]) => new URL(url as string).searchParams.get('term'));
  expect(queries.filter((query) => query === '"Disease/therapy"[Majr:noexp]')).toHaveLength(1);
  expect(chat.mock.calls[0]![0][1].content).toContain('Disease/therapy');
});

test.each(['failure', 'clamped'])('異常系: 語の %s（通信失敗／不整合な OR 件数の注入）を 0 件・寄与なしとして AI に渡さない', async (kind) => {
  const { input, deps, fetch, chat } = setup({ a: { pmids: papers(200, ['11', '22']) } }, ['a[tiab]']);
  input.initialFormula.blocks[0]!.expression = 'a[tiab] OR broken[tiab]';
  input.maxIterations = 1;
  const original = fetch.getMockImplementation()!;
  fetch.mockImplementation(async (url: string) => {
    const query = new URL(url).searchParams.get('term');
    if (kind === 'failure' && query === 'broken[tiab]') throw new Error('語の取得失敗');
    // OR の結果を単独語より小さく偽装し、正常な集合応答を意図的に破る。
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
  // 語別計測は予算確保で止まり、初期実測 5 回＋AI 1 回で予算を使い切る。
  deps.maxApiCalls = 6;
  const waiting = deferred<void>();
  const response = deferred<{ text: string }>();
  chat.mockImplementation(() => { waiting.resolve(); return response.promise; });
  const pending = runQueryOptimization(input, deps);
  await waiting.promise;
  response.resolve({ text: '{"target_block_id":"1","proposed_expression":"late[tiab]"}' });
  const result = await pending;
  expect(result).toMatchObject({ stopReason: 'api_budget', apiCalls: 6, iterations: 0 });
  expect(fetch).toHaveBeenCalledTimes(5);
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
  const { input, deps, write } = setup({ a: { pmids: papers(80, ['11', '22']) } }, ['a[tiab]']);
  let stop = false;
  deps.shouldStop = () => stop;
  const original = evaluation.evaluateQuery;
  jest.spyOn(evaluation, 'evaluateQuery').mockImplementationOnce(original)
    .mockImplementationOnce(async (...args) => { const result = await original(...args); stop = true; return result; });
  const result = await runQueryOptimization(input, deps);
  expect(result.status).toBe('stopped');
  expect(result.trials).toHaveLength(2);
  expect(write).toHaveBeenCalledTimes(3);
});

test('途中で改善があれば連続改善なし回数をリセットする', async () => {
  const { input, deps } = setup({ a: { pmids: papers(40, []) }, b: { pmids: papers(40, []) },
    c: { pmids: papers(41, ['11']) }, d: { pmids: papers(41, ['11']) }, e: { pmids: papers(42, ['11', '22']) } },
  ['b[tiab]', 'c[tiab]', 'd[tiab]', 'e[tiab]']);
  const result = await runQueryOptimization(input, deps);
  expect(result).toMatchObject({ status: 'achieved', iterations: 4 });
});

test('書誌・ツリー未指定の単一ブロック式も、欠測を明示して実行できる', async () => {
  const { input, deps, chat } = setup({ a: { pmids: papers(80, ['11', '22']) } }, ['a[tiab]']);
  input.initialFormula.blocks = [input.initialFormula.blocks[0]!];
  input.initialFormula.combinationExpression = null;
  input.approvedBlocks = [input.approvedBlocks[0]!];
  delete input.seedPapers;
  delete input.meshContext;
  expect((await runQueryOptimization(input, deps)).status).toBe('achieved');
  expect(chat.mock.calls[0]![0][1].content).toContain('"title": "(渡されていない)"');
});

test('異常系: 最終再検証にシード捕捉の変動を注入したら要確認へ戻す', async () => {
  const { input, deps } = setup({ a: { pmids: papers(80, ['11', '22']) } }, ['a[tiab]']);
  const original = evaluation.evaluateQuery;
  jest.spyOn(evaluation, 'evaluateQuery').mockImplementationOnce(original)
    .mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      if (result.finalQuery.status === 'success') {
        // 同じ式・同じ件数でも捕捉 PMID が変わる応答を意図的に注入する。
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
  const { input, deps, chat } = setup({ a: { pmids: papers(50, ['11', '22']) } }, ['a[tiab]']);
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
    reason: '評価済みの同一式の再提案のため測定せずに却下（initial と同じ式）' });
  expect(result.trials[3]).not.toHaveProperty('informedBy');
  expect(result.unmetReasons.join()).not.toContain('判断が未了');
  expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ evaluatedTrials: 1, informationTrials: 1 }));
});

test('連続した情報要求が反復上限に達したら最後の要求を判断未了として残す', async () => {
  const { input, deps, chat } = setup({ a: { pmids: papers(50, ['11', '22']) } });
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
  const { input, deps, chat, write } = setup({ a: { pmids: papers(80, ['11', '22']) } });
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
  const { input, deps, chat } = setup({ a: { pmids: papers(40, ['11']) },
    b: { pmids: papers(50, ['11', '22']) } }, [decision === 'accepted' ? 'b[tiab]' : '#999']);
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
  expect(fetchMeshContext).toHaveBeenCalledWith(meshRequest, expect.objectContaining({ fetch: expect.any(Function) }));
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
  expect(fetchMeshContext.mock.calls.map(([request]) => request)).toEqual(requests.slice(0, 3));
  const notes = optimize.mock.calls[1]![0].meshRequestResults!;
  expect(notes).toHaveLength(5);
  for (const note of notes.slice(3)) expect(note.note).toContain('3 件の追加取得上限で打ち切りました');
});

test.each(['success', 'failure'])('追加取得が予算を使い切った場合は %s 応答を破棄する', async (kind) => {
  const { input, deps, chat, write, fetch } = setup();
  requestMesh(chat, [meshRequest, meshRequest]);
  // 語別計測は予算確保で止まり、初期実測 5 回、AI 1 回の後、追加取得 1 回で上限。
  deps.maxApiCalls = 7;
  const waiting = deferred<void>();
  const response = deferred<skill.OptimizationMeshNode[]>();
  const fetchMeshContext = jest.fn(() => { waiting.resolve(); return response.promise; });
  deps.fetchMeshContext = fetchMeshContext;
  const pending = runQueryOptimization(input, deps);
  await waiting.promise;
  if (kind === 'success') response.resolve([childNode]);
  else response.reject(new Error('遅い取得失敗'));
  const result = await pending;
  expect(result).toMatchObject({ stopReason: 'api_budget', apiCalls: 7 });
  expect(fetchMeshContext).toHaveBeenCalledTimes(1);
  expect(chat).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledTimes(5);
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
  const { input, deps, fetch } = setup({ a: { pmids: papers(40, []) },
    b: { pmids: papers(40, []) }, c: { pmids: papers(41, ['11']) },
    d: { pmids: papers(41, ['11']) }, e: { pmids: papers(41, ['11']) } },
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
  const { input, deps, fetch } = setup({ a: { pmids: papers(40, ['11']) },
    asthma: { pmids: papers(90, ['11', '22']) } }, [expression]);
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
  const { input, deps, fetch, chat } = setup({ a: { pmids: papers(40, ['11']) },
    c: { pmids: papers(90, ['11', '22']) } }, ['"Misspelled disease"[Mesh]', 'c[tiab]']);
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
  expect(optimize.mock.calls[1]![0].measurement!.totalHits).toBe(40);
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
  const { input, deps, fetch } = setup({ a: { pmids: papers(40, []) },
    c: { pmids: papers(41, ['11']) }, e: { pmids: papers(42, ['11', '22']) } },
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
  const { input, deps, chat, write } = setup({ a: { pmids: papers(status === 'achieved' ? 80 : 200, ['11', '22']) } }, ['a[tiab]']);
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
  const { input, deps, write } = setup({ a: { pmids: papers(80, ['11', '22']) } }, ['a[tiab]']);
  write.mockImplementation(async (items: Record<string, checkpoint.QueryOptimizationCheckpoint>) => {
    if (Object.values(items)[0]?.completion) throw new Error('容量不足');
  });
  const result = await runQueryOptimization(input, deps);
  expect(result.status).toBe('achieved');
  expect(result.unmetReasons).toContain('終了記録の保存に失敗しました: 容量不足');
  expect(result.best?.measurement.totalHits).toBe(80);
});

test('目標内でも反復上限 1 の情報要求は追加取得を打ち切り、最終再検証せず判断未了で終わる', async () => {
  const { input, deps, chat } = setup({ a: { pmids: papers(80, ['11', '22']) } });
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
  const { input, deps, chat } = setup({ a: { pmids: papers(80, ['11', '22']) } });
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
  const { input, deps, fetch } = setup({ a: { pmids: papers(80, ['11', '22']) } }, ['a[tiab]']);
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
  const { input, deps, fetch } = setup({ a: { pmids: papers(80, ['11', '22']) } }, ['a[tiab]']);
  delete deps.eutils.rateLimiter;
  if (hasKey) deps.eutils.apiKey = 'test-key';
  const withoutKey = jest.spyOn(sharedEutilsRateLimiters.withoutApiKey, 'acquire').mockResolvedValue(undefined);
  const withKey = jest.spyOn(sharedEutilsRateLimiters.withApiKey, 'acquire').mockResolvedValue(undefined);
  expect((await runQueryOptimization(input, deps)).status).toBe('achieved');
  expect(hasKey ? withKey : withoutKey).toHaveBeenCalledTimes(fetch.mock.calls.length);
  expect(hasKey ? withoutKey : withKey).not.toHaveBeenCalled();
});


test('種付き抽出は再現可能で順序に依存せず重複を含まない', () => {
  const pmids = Array.from({ length: 1000 }, (_, i) => String(i + 1));
  const sampled = samplePmids(pmids, 20, 123);
  expect(samplePmids([...pmids].reverse(), 20, 123)).toEqual(sampled);
  expect(samplePmids([...pmids, ...pmids], 20, 123)).toEqual(sampled);
  expect(samplePmids(pmids, 20, 124)).not.toEqual(sampled);
  expect(new Set(sampled).size).toBe(20);
  expect(sampled).toEqual([...sampled].sort((a, b) => Number(a) - Number(b)));
  expect(samplePmids(['3', '1', '3'], 20, 123)).toEqual(['1', '3']);
  expect(samplePmids([], 20, 123)).toEqual([]);
  expect(samplePmids(pmids, 0, 123)).toEqual([]);
  const upper = Array.from({ length: 200 }, (_, seed) => samplePmids(pmids, 20, seed))
    .flat().filter((pmid) => Number(pmid) > 900).length / 4000;
  expect(upper).toBeGreaterThan(0.05);
  expect(upper).toBeLessThan(0.15);
});

test.each([
  ['正常系', 100, 100, 'all', 100], ['正常系: retmax による制限', 10800, 10000, 'retrieved_subset', 20],
  ['異常系: PMID 取得不足を意図的に注入', 100, 90, 'retrieved_subset', 90], ['正常系', 0, 0, undefined, 0],
] as const)('%s: 失う集合 %s 件・取得 %s 件の抽出記録を保持する', async (_, count, retrieved, method, expectedCount) => {
  const pmids = Array.from({ length: retrieved }, (_, i) => String(i + 1000));
  const f = setup({ a: { pmids: count ? [...papers(50, ['11', '22']), ...Array.from({ length: count }, (_, i) => String(i + 1000))] : papers(49, ['11']) },
    b: { pmids: papers(50, ['11', '22']) } });
  f.input.maxIterations = 1;
  const original = f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation(async (url: string) => {
    const response = await original(url);
    const params = new URL(url).searchParams;
    if (params.get('term')?.includes(') NOT (') && params.get('retmax') === '10000') {
      const body = await response.json();
      // 正常系は取得順序だけを変える。取得不足の異常系では PMID を間引き、件数は維持する。
      return { ...response, json: async () => ({ esearchresult: {
        ...body.esearchresult, idlist: body.esearchresult.idlist.slice(0, retrieved).reverse(),
      } }) };
    }
    return response;
  });
  f.deps.random = () => 0.25;
  f.deps.now = () => 1000;
  const result = await runQueryOptimization(f.input, f.deps);
  const impact = result.trials[1]!.impact!;
  const searches = f.fetch.mock.calls.map(([url]) => new URL(url as string))
    .filter((url) => url.searchParams.get('term')?.includes(') NOT ('));
  expect(searches.map((url) => url.searchParams.get('retmax'))).toEqual(['10000', '0']);
  if (!method) { expect(impact.sample).toBeUndefined(); return; }
  const expected = samplePmids(pmids, expectedCount, 2 ** 30);
  expect(impact.sample).toEqual({ method, seed: 2 ** 30, populationCount: count,
    retrievedCount: retrieved, pmids: expected, sampledAt: '1970-01-01T00:00:01.000Z' });
  expect(expected).not.toEqual(pmids.slice(0, 20));
  const fetchCall = f.fetch.mock.calls.find(([url]) => String(url).includes('efetch.fcgi'))!;
  expect(new URL(fetchCall[0]).searchParams.get('id')!.split(',')).toEqual(expected);
  expect(impact.inspected.map((article) => article.pmid)).toEqual(expected);
  if (count === 100) {
    const decisions = Object.fromEntries(expected.map((pmid) => [pmid, {
      decision: 'exclude' as const, status: 'saved' as const, error: null,
    }]));
    expect(evaluateHeldCandidateAdoptionGate(result.trials[1]!, decisions, { bestCapturedPmids: result.best?.measurement.capturedPmids }).allowed).toBe(retrieved === count);
  }
});

test('異常系: 重複 PMID を注入し、書誌取得の失敗後も重複のない抽出 PMID を残す', async () => {
  const f = setup({ a: { pmids: [...papers(50, ['11', '22']), '902', '901'] },
    b: { pmids: papers(50, ['11', '22']) } });
  f.input.maxIterations = 1;
  f.input.maxHits = 50;
  const original = f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation(async (url: string) => {
    if (url.includes('efetch.fcgi')) throw new Error('書誌取得失敗');
    const params = new URL(url).searchParams;
    if (params.get('term')?.includes(') NOT (') && params.get('retmax') === '10000') {
      const response = await original(url);
      const body = await response.json();
      // 正常な集合応答にはない重複を、この異常系だけで意図的に追加する。
      return { ...response, json: async () => ({ esearchresult: { ...body.esearchresult, idlist: ['902', '901', '901'] } }) };
    }
    return original(url);
  });
  const result = await runQueryOptimization(f.input, f.deps);
  expect(result.trials[1]!.impact).toMatchObject({ inspected: [],
    sample: { method: 'all', retrievedCount: 2, pmids: ['901', '902'] } });
});

test('保留式の再提案は申告が空でも通信せず一致 ID と実差分を記録する', async () => {
  const f = setup({ a: { pmids: papers(200, ['11', '22']) },
    b: { pmids: papers(50, ['11', '22']) } });
  const callCounts: number[] = [];
  f.chat.mockImplementation(async () => {
    callCounts.push(f.fetch.mock.calls.length);
    return { text: JSON.stringify({ target_block_id: '1', proposed_expression: 'b[tiab]',
      added_terms: [], removed_terms: [], replaced_terms: [] }) };
  });
  const result = await runQueryOptimization(f.input, f.deps);
  expect(result).toMatchObject({ stopReason: 'no_improvement', iterations: 2 });
  expect(f.fetch.mock.calls.length).toBe(callCounts[1]);
  expect(result.trials[2]).toMatchObject({ duplicateOf: 'candidate-1', after: null, accepted: false,
    reason: '評価済みの同一式の再提案のため測定せずに却下（candidate-1 と同じ式）',
    formulaDiff: [{ blockId: '1', removed: ['a[tiab]'], added: ['b[tiab]'] }] });
});

test.each(['lost', 'gained'] as const)('差集合 %s の測定失敗で保留した式は再測定できる', async (stage) => {
  const f = setup({ a: { pmids: papers(40, ['11']) },
    b: { pmids: papers(50, ['11', '22']) } });
  const original = f.fetch.getMockImplementation()!;
  let failures = 0;
  f.fetch.mockImplementation(async (url: string) => {
    const params = new URL(url).searchParams;
    if (params.get('term')?.includes(') NOT (') && params.get('retmax') === (stage === 'lost' ? '10000' : '0')
      && failures++ === 0) throw new Error('一時的な測定失敗');
    return original(url);
  });
  const result = await runQueryOptimization(f.input, f.deps);
  expect(result.trials[1]).toMatchObject({ held: true, impact: { [stage === 'lost' ? 'lostHits' : 'gainedHits']: null } });
  expect(result.trials[2]).toMatchObject({ accepted: true, impact: { lostHits: 0, gainedHits: 10 } });
  expect(result.trials[2]?.duplicateOf).toBeUndefined();
  expect(failures).toBe(2);
});

test('追加語だけ違う削除の変種は測定する', async () => {
  const f = setup({ a: { pmids: papers(200, ['11', '22']) },
    b: { pmids: papers(50, ['11', '22']) },
    c: { pmids: papers(60, ['11', '22']) } }, ['b[tiab]', 'c[tiab]']);
  const result = await runQueryOptimization(f.input, f.deps);
  expect(result.stopReason).toBe('no_improvement');
  expect(result.trials[2]).toMatchObject({ held: true, after: { totalHits: 60 },
    formulaDiff: [{ blockId: '1', removed: ['a[tiab]'], added: ['c[tiab]'] }] });
});

test('実式差分は表記揺れを除外しブロック追加削除と結合式も残す', () => {
  const before = { blocks: [
    { id: '1', expression: 'A[tiab] OR b[tiab]', isCombination: false },
    { id: '2', expression: 'c[tiab]', isCombination: false },
    { id: '4', expression: '#1 AND #2', isCombination: true },
  ], combinationExpression: '#1 AND #2' };
  const after = { blocks: [
    { id: '1', expression: 'a[tiab] OR D[tiab]', isCombination: false },
    { id: '3', expression: '"Disease"[Mesh]', isCombination: false },
    { id: '4', expression: '#1 AND #3', isCombination: true },
  ], combinationExpression: '#1 AND #3' };
  expect(diffOptimizationFormula(before, after)).toEqual([
    { blockId: '1', removed: ['b[tiab]'], added: ['D[tiab]'] },
    { blockId: '2', removed: ['c[tiab]'], added: [] },
    { blockId: '4', removed: ['#1 AND #2'], added: ['#1 AND #3'] },
    { blockId: '3', removed: [], added: ['"Disease"[Mesh]'] },
  ]);
});

const hitTargetGuidance = '既に捕捉している文献を失わずに件数を減らす変更は見つかりませんでした。件数を減らす候補には未確認の損失があります。これは件数を減らせないことの証明ではありません。検索戦略のレビュー（概念と検索語の対応・AND/OR の論理・フィルタの適用対象）か、目安件数の見直しを検討してください。';

describe.each(['no_improvement', 'diagnosed_block_held', 'iteration_limit', 'repeated_formula', 'user_stop', 'api_budget'] as const)(
  '終了理由 %s の件数の案内', (reason) => {
    test.each([80, 100, 200])('最終実測 %s 件が目安を超えた対象の終了理由だけ案内する', async (hits) => {
      const f = setup({ a: { pmids: papers(hits, ['11']) } });
      f.chat.mockRejectedValue(new QueryOptimizationStopError(reason));
      const result = await runQueryOptimization(f.input, f.deps);
      expect(result.stopReason).toBe(reason);
      const show = hits > 100 && reason !== 'user_stop' && reason !== 'api_budget';
      expect(result.unmetReasons.includes(hitTargetGuidance)).toBe(show);
      if (show) {
        const index = result.unmetReasons.indexOf(`目安件数 100 件を超えています（実測 ${hits} 件）`);
        expect(index).toBeGreaterThanOrEqual(0);
        expect(result.unmetReasons[index + 1]).toBe(hitTargetGuidance);
      }
      expect(result.unmetReasons.some((line) => line.startsWith('件数を減らす候補を'))).toBe(false);
    });
  }
);

test('目安超過で反復上限に達したら保留した試行数を案内する', async () => {
  const f = setup({ a: { pmids: papers(200, ['11', '22']) },
    b: { pmids: papers(150, ['11', '22']) } });
  f.input.maxIterations = 1;
  const result = await runQueryOptimization(f.input, f.deps);
  expect(result.stopReason).toBe('iteration_limit');
  expect(result.trials.filter((trial) => trial.held)).toHaveLength(1);
  const index = result.unmetReasons.indexOf(hitTargetGuidance);
  expect(index).toBeGreaterThanOrEqual(0);
  expect(result.unmetReasons[index + 1]).toBe('件数を減らす候補を 1 件保留しました（削除影響の確認を参照）。');
});

test('件数が減る保留と増える保留が混在すると減る候補だけを案内する', async () => {
  const f = setup({ a: { pmids: [...papers(190, ['11']), ...Array.from({ length: 10 }, (_, i) => String(900 + i))] },
    b: { pmids: papers(150, ['11', '22']) },
    c: { pmids: papers(250, ['11', '22']) } }, ['b[tiab]', 'c[tiab]']);
  // 保留後も採用式は a のため、どちらの提案も a からの置換として返す。
  for (const expression of ['b[tiab]', 'c[tiab]']) {
    f.chat.mockResolvedValueOnce({ text: JSON.stringify({ target_block_id: '1', proposed_expression: expression,
      replaced_terms: [{ before: 'a[tiab]', after: expression }] }) });
  }
  const result = await runQueryOptimization(f.input, f.deps);
  expect(result.stopReason).toBe('no_improvement');
  expect(result.trials.filter((trial) => trial.held).map((trial) => trial.after?.totalHits)).toEqual([150, 250]);
  const index = result.unmetReasons.indexOf(hitTargetGuidance);
  expect(index).toBeGreaterThanOrEqual(0);
  expect(result.unmetReasons[index + 1]).toBe('件数を減らす候補を 1 件保留しました（削除影響の確認を参照）。');
});

test.each([200, 250])('保留候補が同数か増加の %s 件だけなら保留件数の行を出さない', async (hits) => {
  const f = setup({ a: { pmids: [...papers(190, ['11']), ...Array.from({ length: 10 }, (_, i) => String(900 + i))] },
    b: { pmids: papers(hits, ['11', '22']) } });
  f.input.maxIterations = 1;
  const result = await runQueryOptimization(f.input, f.deps);
  expect(result.stopReason).toBe('iteration_limit');
  expect(result.trials.filter((trial) => trial.held)).toHaveLength(1);
  expect(result.unmetReasons).toContain(hitTargetGuidance);
  expect(result.unmetReasons.some((line) => line.startsWith('件数を減らす候補を'))).toBe(false);
});

describe.each(['before', 'after'] as const)('%s の実測が欠けた保留候補', (side) => {
  test.each(['測定全体', '件数'] as const)('%s が欠けていれば保留件数の行を出さない', async (missing) => {
    const f = setup({ a: { pmids: papers(200, ['11', '22']) },
      b: { pmids: papers(150, ['11', '22']) } });
    f.input.maxIterations = 1;
    const save = checkpoint.saveQueryOptimizationCheckpoint;
    // 通常の実測では作られない欠損を、確定済みの保留試行に注入する。
    const saveMock = jest.spyOn(checkpoint, 'saveQueryOptimizationCheckpoint').mockImplementation(async (...args) => {
      for (const trial of args[0].trials.filter((item) => item.held)) {
        trial[side] = missing === '測定全体' ? null : { ...trial[side]!, totalHits: null };
      }
      return save(...args);
    });
    try {
      const result = await runQueryOptimization(f.input, f.deps);
      expect(result.stopReason).toBe('iteration_limit');
      expect(result.trials.filter((trial) => trial.held)).toHaveLength(1);
      expect(result.unmetReasons).toContain(hitTargetGuidance);
      expect(result.unmetReasons.some((line) => line.startsWith('件数を減らす候補を'))).toBe(false);
    } finally {
      saveMock.mockRestore();
    }
  });
});

test('目安件数と既知シードの捕捉を満たした終了には件数削減の案内を出さない', async () => {
  const f = setup({ a: { pmids: papers(80, ['11', '22']) } }, ['a[tiab]']);
  const result = await runQueryOptimization(f.input, f.deps);
  expect(result.stopReason).toBe('conditions_met');
  expect(result.unmetReasons).not.toContain(hitTargetGuidance);
  expect(result.unmetReasons.some((line) => line.startsWith('件数を減らす候補を'))).toBe(false);
});

test.each([
  ['conditions_met', '目安件数と既知シードの捕捉を満たしたため終了しました。'],
  ['no_improvement', '件数を減らしつつ既に捕捉している文献を失わない変更が、連続して見つからなかったため終了しました。'],
  ['diagnosed_block_held', '診断したブロックを狭める案が、既に捕捉している文献を失うため連続して保留になり、終了しました。'],
] as const)('終了理由 %s は満たした条件や保留の理由を明示する', (reason, message) => {
  expect(new QueryOptimizationStopError(reason).message).toBe(message);
});

describe('通信中のキャンセルと試行単位の予算', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('注入した now が進まなければ実時間の期限を超えても停止しない', async () => {
    const f = setup();
    const started = deferred<AbortSignal>();
    f.fetch.mockImplementation((_url: string, init: RequestInit) => {
      started.resolve(init.signal as AbortSignal);
      return new Promise(() => undefined);
    });
    f.deps.now = () => 1000;
    f.deps.maxElapsedMs = 100;
    let stop = false;
    f.deps.shouldStop = () => stop;
    let finished = false;
    const pending = runQueryOptimization(f.input, f.deps).then((result) => {
      finished = true;
      return result;
    });
    const signal = await started.promise;
    try {
      await jest.advanceTimersByTimeAsync(500);
      expect(finished).toBe(false);
      expect(signal.aborted).toBe(false);
    } finally {
      stop = true;
      await jest.advanceTimersByTimeAsync(100);
      await pending;
    }
    expect((await pending).stopReason).toBe('user_stop');
  });

  test('未完了の候補 fetch を停止し、遅れた応答で最良候補・終了記録を変えない', async () => {
    const f = setup({ a: { pmids: papers(200, ['11']) }, b: { pmids: papers(201, ['11', '22']) } });
    const started = deferred<AbortSignal>();
    const response = deferred<Response>();
    const original = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation((url: string, init: RequestInit) => {
      if (new URL(url).searchParams.get('term')?.includes('b[tiab]')) {
        started.resolve(init.signal as AbortSignal);
        return response.promise;
      }
      return original(url, init);
    });
    let stop = false;
    f.deps.shouldStop = () => stop;
    const pending = runQueryOptimization(f.input, f.deps);
    const signal = await started.promise;
    stop = true;
    await jest.advanceTimersByTimeAsync(100);
    const result = await pending;
    expect(result).toMatchObject({ status: 'stopped', stopReason: 'user_stop' });
    expect(signal.aborted).toBe(true);
    expect(result.best?.formula).toEqual(f.input.initialFormula);
    const saved = f.write.mock.calls[f.write.mock.calls.length - 1]![0].queryOptimizationCheckpoint;
    expect(saved).toMatchObject({ completion: { stopReason: 'user_stop' }, resume: {
      bestFormula: f.input.initialFormula, consumed: { apiCalls: result.apiCalls, elapsedMs: result.elapsedMs },
    } });
    const before = JSON.stringify(result);
    const writes = f.write.mock.calls.length;
    response.resolve({ ok: true, json: async () => ({ esearchresult: { count: '201', idlist: ['11', '22'] } }) } as Response);
    await jest.advanceTimersByTimeAsync(0);
    expect(JSON.stringify(result)).toBe(before);
    expect(f.write).toHaveBeenCalledTimes(writes);
  });

  test.each(['request', 'run'] as const)('%s の期限で未完了 fetch を中断し、終了理由を区別する', async (kind) => {
    const f = setup();
    // 再送の有無を他の行計測と混同しないよう、初期実測を一通信に限定する。
    const original = evaluation.evaluateQuery;
    jest.spyOn(evaluation, 'evaluateQuery').mockImplementationOnce(async (formula, seeds, deps) => {
      await esearch('a[tiab]', deps.eutils);
      return original(formula, seeds, deps);
    });
    f.deps.eutils.maxRetries = 2;
    const started = deferred<AbortSignal>();
    f.fetch.mockImplementation((_url: string, init: RequestInit) => {
      started.resolve(init.signal as AbortSignal);
      return new Promise(() => undefined);
    });
    f.deps.ncbiRequestTimeoutMs = kind === 'request' ? 50 : 500;
    f.deps.maxElapsedMs = kind === 'run' ? 50 : 500;
    const pending = runQueryOptimization(f.input, f.deps);
    const signal = await started.promise;
    await jest.advanceTimersByTimeAsync(50);
    const result = await pending;
    expect(result.stopReason).toBe(kind === 'request' ? 'api_error' : 'time_budget');
    if (kind === 'request') {
      expect(result.status).toBe('error');
      expect(result.unmetReasons).toContain('NCBI の応答が 0.05 秒以内に返りませんでした');
    }
    expect(signal.aborted).toBe(true);
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  test('語別件数の一件が期限切れでも未測定として AI 提案へ進む', async () => {
    const f = setup(undefined, ['a[tiab]']);
    f.input.maxIterations = 1;
    f.deps.measureTermDetails = true;
    f.deps.ncbiRequestTimeoutMs = 50;
    const started = deferred<AbortSignal>();
    const original = f.fetch.getMockImplementation()!;
    let counts = 0;
    f.fetch.mockImplementation((url: string, init: RequestInit) => {
      const params = new URL(url).searchParams;
      const query = params.get('term') ?? '';
      if (query.includes(') NOT (')) return Promise.resolve({ ok: true,
        json: async () => ({ esearchresult: { count: '0', idlist: [] } }) });
      // 初期の行計測後、同じ語の個別件数だけを期限切れにする。
      if (query === 'a[tiab]' && params.get('retmax') === '0' && ++counts === 2) {
        started.resolve(init.signal as AbortSignal);
        return new Promise(() => undefined);
      }
      return original(url, init);
    });
    const pending = runQueryOptimization(f.input, f.deps);
    const signal = await started.promise;
    await jest.advanceTimersByTimeAsync(50);
    const result = await pending;
    expect(signal.aborted).toBe(true);
    expect(result.stopReason).toBe('iteration_limit');
    expect(f.chat).toHaveBeenCalledTimes(1);
    expect(result.trials[1]?.before?.terms).toContainEqual(expect.objectContaining({ query: 'a[tiab]', hits: null }));
  });

  test.each([undefined, true])('MeSH 語別件数の一件が期限切れでも未測定として AI 提案へ進む（詳細計測: %s）', async (measureTermDetails) => {
    const query = '"Neoplasms"[Mesh]';
    const f = setup(undefined, [query]);
    f.input.initialFormula.blocks[0]!.expression = query;
    f.input.maxIterations = 1;
    f.deps.measureTermDetails = measureTermDetails;
    f.deps.ncbiRequestTimeoutMs = 50;
    const started = deferred<AbortSignal>();
    const original = f.fetch.getMockImplementation()!;
    const evaluate = jest.spyOn(evaluation, 'evaluateQuery');
    let counts = 0;
    f.fetch.mockImplementation((url: string, init: RequestInit) => {
      const params = new URL(url).searchParams;
      const term = params.get('term') ?? '';
      if (term.includes(') NOT (')) return Promise.resolve({ ok: true,
        json: async () => ({ esearchresult: { count: '0', idlist: [] } }) });
      // 初期の行計測を通し、反復冒頭の MeSH 語の個別件数だけを期限切れにする。
      if (url.includes('esearch.fcgi') && term === query && params.get('retmax') === '0' && ++counts === 2) {
        started.resolve(init.signal as AbortSignal);
        return new Promise(() => undefined);
      }
      return original(url, init);
    });
    const pending = runQueryOptimization(f.input, f.deps);
    const signal = await started.promise;
    expect(counts).toBe(2);
    expect((await evaluate.mock.results[0]!.value).status).toBe('success');
    expect(f.chat).not.toHaveBeenCalled();
    expect(signal.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(50);
    const result = await pending;
    expect(signal.aborted).toBe(true);
    expect(result.stopReason).toBe('iteration_limit');
    expect(f.chat).toHaveBeenCalledTimes(1);
    expect(result.trials[1]?.before?.terms).toContainEqual(expect.objectContaining({ query, hits: null }));
  });

  test.each([1, 2])('候補の期限切れを測定失敗として却下し、連続 %s 回の終了理由を記録する', async (failures) => {
    const f = setup();
    f.input.maxIterations = failures;
    f.deps.ncbiRequestTimeoutMs = 50;
    const started = Array.from({ length: failures }, () => deferred<AbortSignal>());
    let attempts = 0;
    const original = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation((url: string, init: RequestInit) => {
      const query = new URL(url).searchParams.get('term') ?? '';
      if (query.includes(') NOT (')) return Promise.resolve({ ok: true,
        json: async () => ({ esearchresult: { count: '0', idlist: [] } }) });
      if (query === 'b[tiab]') {
        started[attempts++]!.resolve(init.signal as AbortSignal);
        return new Promise(() => undefined);
      }
      return original(url, init);
    });
    const evaluate = jest.spyOn(evaluation, 'evaluateQuery');
    const pending = runQueryOptimization(f.input, f.deps);
    for (const request of started) {
      await request.promise;
      await jest.advanceTimersByTimeAsync(50);
    }
    const result = await pending;
    expect((await evaluate.mock.results[1]!.value).status).toBe('failure');
    expect(result.stopReason).toBe(failures === 1 ? 'iteration_limit' : 'api_error');
    expect(result.trials[1]).toMatchObject({ accepted: false,
      reason: expect.stringContaining('NCBI の応答が 0.05 秒以内に返りませんでした') });
    expect(f.chat).toHaveBeenCalledTimes(failures);
  });

  test.each(['初期実測', '差集合', 'シード捕捉', 'ブロック診断', '未捕捉書誌'] as const)('%s の期限切れは既存の非停止エラーとして記録する', async (stage) => {
    const f = setup({ a: { pmids: papers(200, ['11']) }, b: { pmids: papers(201, ['11', '22']) } },
      stage === '差集合' ? ['b[tiab]'] : ['a[tiab]']);
    if (stage === 'ブロック診断') {
      f.input.initialFormula.combinationExpression = '#1 AND #2 AND #RCTfilter';
      f.input.initialFormula.blocks[3]!.expression = '#1 AND #2 AND #RCTfilter';
    }
    f.input.maxIterations = 1;
    f.deps.ncbiRequestTimeoutMs = 50;
    const started = deferred<AbortSignal>();
    const original = f.fetch.getMockImplementation()!;
    let timedOut = false;
    f.fetch.mockImplementation((url: string, init: RequestInit) => {
      const query = new URL(url).searchParams.get('term') ?? '';
      const difference = query.includes(') NOT (');
      const selected = difference ? stage === '差集合'
        : stage === '初期実測' ? query === 'a[tiab]'
          : stage === 'シード捕捉' ? query === '(fixed[tiab]) AND (11[uid] OR 22[uid])'
            : stage === '未捕捉書誌' ? url.includes('efetch.fcgi')
              : stage === 'ブロック診断' && query.includes('fixed[tiab]') && query.includes('[pt]')
                && !query.includes('a[tiab]') && !query.includes('[uid]');
      if (selected && !timedOut) {
        timedOut = true;
        started.resolve(init.signal as AbortSignal);
        return new Promise(() => undefined);
      }
      if (difference) return Promise.resolve({ ok: true,
        json: async () => ({ esearchresult: { count: '0', idlist: [] } }) });
      return original(url, init);
    });
    const pending = runQueryOptimization(f.input, f.deps);
    await started.promise;
    await jest.advanceTimersByTimeAsync(50);
    const result = await pending;
    const message = 'NCBI の応答が 0.05 秒以内に返りませんでした';
    expect(result.stopReason).toBe(stage === '初期実測' ? 'api_error' : 'iteration_limit');
    if (stage === '初期実測') {
      expect(result.best).toBeNull();
      expect(result.trials[0]?.after?.blocks[0]).toMatchObject({ hits: null, error: message });
    } else {
      expect(f.chat).toHaveBeenCalled();
      if (stage === '差集合') expect(result.trials[1]).toMatchObject({ accepted: false, held: true,
        impact: { lostHits: null, error: message } });
      if (stage === 'シード捕捉') expect(result.trials[0]?.after?.seedCapture?.rows)
        .toContainEqual({ blockId: '2', capturedPmids: null, error: message });
      if (stage === 'ブロック診断') expect(JSON.stringify(result.blockDiagnosis)).toContain(`未判定: ${message}`);
      if (stage === '未捕捉書誌') expect(f.chat.mock.calls[0]![0][1].content).toContain(`書誌の取得に失敗: ${message}`);
    }
  });

  test.each(['fetch', 'json', 'text'] as const)('進捗通知なしの MeSH %s にも期限を適用し、取得単位で数える', async (stage) => {
    const f = setup(undefined, ['a[tiab]']);
    f.input.maxIterations = 2;
    f.deps.ncbiRequestTimeoutMs = 50;
    requestMesh(f.chat, [meshRequest]);
    const started = deferred<AbortSignal>();
    const original = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation((url: string, init: RequestInit) => {
      if (url !== 'https://mesh.test/timeout') return original(url, init);
      if (stage === 'fetch') {
        started.resolve(init.signal as AbortSignal);
        return new Promise(() => undefined);
      }
      return Promise.resolve({ ok: true, [stage]: () => {
        started.resolve(init.signal as AbortSignal);
        return new Promise(() => undefined);
      } });
    });
    f.deps.fetchMeshContext = async (_request, eutils) => {
      const response = await eutils!.fetch('https://mesh.test/timeout');
      if (stage !== 'fetch') await response[stage]();
      return [];
    };
    const optimize = jest.spyOn(skill, 'optimizeQuery');
    expect(f.deps.onProgress).toBeUndefined();
    const pending = runQueryOptimization(f.input, f.deps);
    const signal = await started.promise;
    await jest.advanceTimersByTimeAsync(50);
    const result = await pending;
    expect(signal.aborted).toBe(true);
    expect(result.stopReason).toBe('iteration_limit');
    expect(f.chat).toHaveBeenCalledTimes(2);
    expect(optimize.mock.calls[1]![0].meshRequestResults![0]!.note)
      .toBe('未取得: MeSH 取得に失敗しました。理由: NCBI の応答が 0.05 秒以内に返りませんでした');
    const pubmedCalls = f.fetch.mock.calls.filter(([url]) => url !== 'https://mesh.test/timeout').length;
    expect(result.apiCalls).toBe(pubmedCalls + f.chat.mock.calls.length + 1);
  });

  test.each(['json', 'text'] as const)('%s 本文の読み取り中も fetch の signal で停止する', async (body) => {
    const f = setup({ a: { pmids: papers(200, ['11']) } });
    const started = deferred<AbortSignal>();
    const original = f.fetch.getMockImplementation()!;
    let bodyAborted = false;
    f.fetch.mockImplementation((url: string, init: RequestInit) => {
      if (body === 'text' && !url.includes('efetch.fcgi')) return original(url, init);
      const signal = init.signal as AbortSignal;
      return Promise.resolve({ ok: true, [body]: () => new Promise((_, reject) => {
        signal.addEventListener('abort', () => { bodyAborted = true; reject(signal.reason); }, { once: true });
        started.resolve(signal);
      }) });
    });
    let stop = false;
    f.deps.shouldStop = () => stop;
    const pending = runQueryOptimization(f.input, f.deps);
    await started.promise;
    stop = true;
    await jest.advanceTimersByTimeAsync(100);
    expect((await pending).stopReason).toBe('user_stop');
    expect(bodyAborted).toBe(true);
  });

  test.each(['NCBI', 'LLM'])('%s のバックオフ待機中に停止し、次の送信を始めない', async (kind) => {
    const f = setup();
    const waiting = deferred<void>();
    f.deps.eutils.sleep = () => { waiting.resolve(); return new Promise(() => undefined); };
    if (kind === 'NCBI') {
      f.deps.eutils.maxRetries = 2;
      f.fetch.mockResolvedValueOnce({ ok: false, status: 429 });
    } else f.chat.mockRejectedValueOnce(new LlmProviderError('混雑', 'gemini', 429, ''));
    let stop = false;
    f.deps.shouldStop = () => stop;
    const pending = runQueryOptimization(f.input, f.deps);
    await waiting.promise;
    const sends = f.fetch.mock.calls.length + f.chat.mock.calls.length;
    stop = true;
    await jest.advanceTimersByTimeAsync(100);
    expect((await pending).stopReason).toBe('user_stop');
    expect(f.fetch.mock.calls.length + f.chat.mock.calls.length).toBe(sends);
  });

  test('LLM の request_timeout は最良候補・消費予算とともにチェックポイントへ残る', async () => {
    const f = setup();
    const started = deferred<void>();
    f.chat.mockImplementation(() => { started.resolve(); return new Promise(() => undefined); });
    f.deps.llmRequestTimeoutMs = 50;
    const pending = runQueryOptimization(f.input, f.deps);
    await started.promise;
    await jest.advanceTimersByTimeAsync(50);
    const result = await pending;
    expect(result).toMatchObject({ status: 'stopped', stopReason: 'request_timeout' });
    expect(f.chat).toHaveBeenCalledTimes(1);
    expect(f.write.mock.calls[f.write.mock.calls.length - 1]![0].queryOptimizationCheckpoint).toMatchObject({
      completion: { status: 'stopped', stopReason: 'request_timeout' },
      resume: { bestFormula: f.input.initialFormula, consumed: { apiCalls: result.apiCalls, elapsedMs: result.elapsedMs } },
    });
  });

  test('LLM が独自に投げた TimeoutError は通信期限と混同しない', async () => {
    const f = setup();
    f.chat.mockRejectedValue(new DOMException('プロバイダ独自の失敗', 'TimeoutError'));
    expect((await runQueryOptimization(f.input, f.deps)).stopReason).toBe('api_error');
  });

  test('リクエスト期限と停止要求が重なったときはユーザー停止を優先する', async () => {
    const f = setup();
    const started = deferred<void>();
    f.fetch.mockImplementation(() => { started.resolve(); return new Promise(() => undefined); });
    f.deps.ncbiRequestTimeoutMs = 50;
    let stop = false;
    f.deps.shouldStop = () => stop;
    const pending = runQueryOptimization(f.input, f.deps);
    await started.promise;
    stop = true;
    await jest.advanceTimersByTimeAsync(50);
    expect((await pending).stopReason).toBe('user_stop');
  });

  test('完了した LLM 試行の期限切れは、再試行中の新しいリクエストを中断しない', async () => {
    const f = setup(undefined, ['a[tiab]']);
    f.input.maxIterations = 1;
    f.deps.llmRequestTimeoutMs = 100;
    f.deps.eutils.sleep = () => new Promise((resolve) => setTimeout(resolve, 60));
    const first = deferred<void>();
    const second = deferred<void>();
    const response = deferred<Awaited<ReturnType<LLMProvider['chat']>>>();
    const original = f.chat.getMockImplementation()!;
    f.chat.mockImplementationOnce(() => {
      first.resolve();
      return Promise.reject(new LlmProviderError('混雑', 'gemini', 429, ''));
    }).mockImplementationOnce(() => { second.resolve(); return response.promise; });
    const pending = runQueryOptimization(f.input, f.deps);
    await first.promise;
    await jest.advanceTimersByTimeAsync(60);
    await second.promise;
    await jest.advanceTimersByTimeAsync(50);
    const signals = f.chat.mock.calls.map((call) => call[1].signal as AbortSignal);
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
    response.resolve(await original());
    const result = await pending;
    expect(result.stopReason).toBe('iteration_limit');
    expect(signals[1]!.aborted).toBe(true);
  });

  test('429 の再送信を数え、残予算 1 回なら 2 回目を送らない', async () => {
    const retry = setup(undefined, ['a[tiab]']);
    retry.input.maxIterations = 1;
    retry.deps.eutils.sleep = async () => undefined;
    retry.chat.mockRejectedValueOnce(new LlmProviderError('混雑', 'gemini', 429, ''));
    const result = await runQueryOptimization(retry.input, retry.deps);
    expect(retry.chat).toHaveBeenCalledTimes(2);
    expect(result.apiCalls).toBe(retry.fetch.mock.calls.length + 2);
    const limited = setup();
    // 初期測定後の残りを 1 回にする。予約予算により任意の語別計測は省略される。
    limited.deps.maxApiCalls = retry.write.mock.calls[0]![0].queryOptimizationCheckpoint.resume.consumed.apiCalls + 1;
    limited.deps.eutils.sleep = async () => undefined;
    limited.chat.mockRejectedValue(new LlmProviderError('混雑', 'gemini', 429, ''));
    const stopped = await runQueryOptimization(limited.input, limited.deps);
    expect(stopped.stopReason).toBe('api_budget');
    expect(limited.chat).toHaveBeenCalledTimes(1);
    expect(stopped.apiCalls).toBe(limited.fetch.mock.calls.length + 1);
  });
});


test('増える集合だけの通信失敗なら失う書誌の exclude 保存後に採用できる', async () => {
  const remaining = papers(50, ['11', '22']);
  const { input, deps, fetch } = setup({ a: { pmids: [...remaining, '901'] }, b: { pmids: remaining } });
  input.maxIterations = 1;
  input.maxHits = 50;
  const original = fetch.getMockImplementation()!;
  fetch.mockImplementation(async (url: string) => {
    const params = new URL(url).searchParams;
    if (params.get('term')?.includes(') NOT (') && params.get('retmax') === '0') return { ok: false, status: 414 };
    return original(url);
  });
  const result = await runQueryOptimization(input, deps);
  const trial = result.trials[1]!;
  expect(trial).toMatchObject({ accepted: false, held: true, impact: {
    lostHits: 1, gainedHits: null, failedMeasurements: ['gained_search'], error: expect.stringContaining('414'),
  } });
  expect(evaluateHeldCandidateAdoptionGate(trial, { '901': { status: 'saved', decision: 'exclude', error: null } }, { bestCapturedPmids: result.best?.measurement.capturedPmids }).allowed).toBe(true);
});
