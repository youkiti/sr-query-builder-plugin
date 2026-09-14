/** @jest-environment node */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from 'dotenv';
import type { LlmProviderFactory } from '../../src/app/services/llmProviderService';
import { buildBroadenedFormula, buildMarginQuery, type BlockRecallAdditions } from '../../src/features/formula/recallExpansion';
import { expandFormula } from '../../src/features/validation/expandFormula';
import type { LLMProvider } from '../../src/lib/llm/LLMProvider';
import { sharedEutilsRateLimiters, type EutilsDeps } from '../../src/lib/ncbi/eutils';
import type { PubmedFormula } from '../../src/lib/search-formula-md';
import { hashC0Content, type C0Artifact } from './c0Artifact';
import { installDomParser } from './domParser';
import { hashMarginContent, type MarginContent } from './freezeMargin';
import * as gitInfo from './gitInfo';
import { STAGE_NAMES, type OutsideStage } from './outsideStages';
import {
  allocatePerBlockRetmax,
  interleaveRoundRobin,
  loadTermCounts,
  main,
  marginDesignResultDir,
  parseMarginDesignArgs,
  planMarginDesignVariants,
  runPerBlockVariant,
  termCaptureTablePath,
  termCountsPath,
  type MarginDesignVariantRun,
} from './marginDesign';
import { marginDesignRows } from './marginDesignReport';
import type { BenchCase, FrozenSeeds } from './types';

jest.mock('dotenv', () => ({ config: jest.fn() }));
const caseId = 'r3-vascular-bleeding';
const marginName = 'criteria-only-draft1-margin1';
const args = ['--case', caseId, '--margin', marginName];
const oldGemini = process.env.GEMINI_API_KEY;
const oldNcbi = process.env.NCBI_API_KEY;

// --- 検索式（2 概念ブロック + 結合行）。文字列は product の関数で組み立て、手打ちしない。 ---
const formula: PubmedFormula = {
  blocks: [
    { id: '1', expression: 'base1[tiab]', isCombination: false },
    { id: '2', expression: 'base2[tiab]', isCombination: false },
    { id: '3', expression: '#1 AND #2', isCombination: true },
  ],
  combinationExpression: null,
};
const originalQuery = expandFormula(formula).trim();
const termA1 = { term: 'termA1[tiab]', axis: 'freeword' as const, rationale: 'r' };
const termA2 = { term: 'termA2[tiab]', axis: 'freeword' as const, rationale: 'r' };
const termB1 = { term: 'termB1[tiab]', axis: 'freeword' as const, rationale: 'r' };
const additions: BlockRecallAdditions[] = [
  { blockId: '1', additions: [termA1, termA2] },
  { blockId: '2', additions: [termB1] },
];
const marginQueryFor = (adds: BlockRecallAdditions[]) => buildMarginQuery(expandFormula(buildBroadenedFormula(formula, adds)).trim(), originalQuery);
const termA1MarginQuery = marginQueryFor([{ blockId: '1', additions: [termA1] }]);
const termA2MarginQuery = marginQueryFor([{ blockId: '1', additions: [termA2] }]);
const termB1MarginQuery = marginQueryFor([{ blockId: '2', additions: [termB1] }]);
const blockOneMarginQuery = marginQueryFor([{ blockId: '1', additions: [termA1, termA2] }]);
const fullMarginQuery = marginQueryFor(additions);

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'margin-design-'));
  const results = join(root, 'results');
  const dir = join(root, caseId);
  mkdirSync(join(dir, 'c0'), { recursive: true });
  mkdirSync(join(dir, 'margin'));
  const original = JSON.parse(readFileSync(join(__dirname, 'fixtures', caseId, 'c0', 'criteria-only-draft1.json'), 'utf8')) as C0Artifact;
  const { sha256, ...content } = original;
  expect(hashC0Content(content)).toBe(sha256);
  content.formula = formula;
  content.protocol = { ...content.protocol, researchQuestion: '研究課題', inclusionCriteria: '組入', exclusionCriteria: '除外' };
  const c0 = { ...content, sha256: hashC0Content(content) };
  writeFileSync(join(dir, 'c0', 'criteria-only-draft1.json'), JSON.stringify(c0));
  const margin: MarginContent = { schemaVersion: 1, name: marginName, caseId, c0: { name: 'criteria-only-draft1', sha256: c0.sha256 },
    additions, broadenedQuery: expandFormula(buildBroadenedFormula(formula, additions)).trim(), marginQuery: fullMarginQuery,
    originalHits: 9, marginHits: 8, searchDate: '2022-03-31', model: 'fake', createdAt: '2026-09-14T00:00:00Z', gitCommit: 'frozen', gitDirty: false };
  const marginPath = join(dir, 'margin', `${marginName}.json`);
  writeFileSync(marginPath, JSON.stringify({ ...margin, sha256: hashMarginContent(margin) }));
  const seeds: FrozenSeeds = { seed: 20260912, selections: ['900', '901', '902'].map((pmid) => ({ groupId: pmid, pmid, year: null })) };
  const gold = [
    ...['900', '901', '902'].map((pmid) => ({ id: pmid, pmids: [pmid], members: [{ studyId: `シード${pmid}`, pmids: [pmid] }] })),
    { id: 'G-current', pmids: ['501'], members: [{ studyId: 'H-current', pmids: ['501'] }] },
    { id: 'G-presented', pmids: ['201'], members: [{ studyId: 'H-presented', pmids: ['201'] }] },
    // どの margin（full・cutoff-5・per-block のどのブロック）の pmids にも入れない held-out。
    // 選定（efetch の id・LLM への入力）に gold が混ざっていないかを、tautology にならない形で検査するために使う。
    { id: 'G-hidden', pmids: ['777'], members: [{ studyId: 'H-hidden', pmids: ['777'] }] },
  ];
  const fixture: BenchCase = { id: caseId, pmcid: 'fake', searchDate: margin.searchDate, license: 'CC BY', protocolPath: 'unused', gold, heldOut: [], seeds };
  writeFileSync(join(dir, 'case.json'), JSON.stringify(fixture));
  writeFileSync(join(dir, 'seeds.json'), JSON.stringify(seeds));
  return { root, dir, results, c0, margin };
}

beforeEach(() => {
  // main() 経由のテストは main() 内部で呼ぶが、runPerBlockVariant を直接呼ぶテストは
  // efetchArticles（DOMParser 必須）に届くまで誰も呼ばないため、ここで補っておく。冪等。
  installDomParser();
  process.env.GEMINI_API_KEY = 'fake-gemini-secret';
  process.env.NCBI_API_KEY = 'fake-ncbi-secret';
  jest.spyOn(sharedEutilsRateLimiters.withApiKey, 'acquire').mockResolvedValue(undefined);
  jest.spyOn(gitInfo, 'getGitCommit').mockReturnValue('same-commit');
  jest.spyOn(gitInfo, 'isGitDirty').mockReturnValue(false);
  jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  if (oldGemini === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = oldGemini;
  if (oldNcbi === undefined) delete process.env.NCBI_API_KEY; else process.env.NCBI_API_KEY = oldNcbi;
});

// ---------------------------------------------------------------------------
// 引数
// ---------------------------------------------------------------------------

test('引数の既定値・thresholds の正規化・不正値・排他条件を検証する', () => {
  expect(parseMarginDesignArgs(args)).toMatchObject({ caseId, marginName, seed: 20260912, thresholds: [1000, 2500, 5000], rankDepth: 10000, dryRun: false });
  expect(parseMarginDesignArgs([...args, '--thresholds', '5000, 1000 ,2500', '--rank-depth', '0', '--label', 'a.B_1-2', '--dry-run']))
    .toMatchObject({ thresholds: [1000, 2500, 5000], rankDepth: 0, label: 'a.B_1-2', dryRun: true });
  for (const pair of [['--thresholds', '0,100'], ['--thresholds', '100,100'], ['--thresholds', '1.5,100'], ['--thresholds', '-1,100'],
    ['--thresholds', ''], ['--thresholds', '100,'], ['--rank-depth', '-1'], ['--rank-depth', '10001'], ['--rank-depth', '1.5'],
    ['--label', '../escape'], ['--label', 'replay-test'], ['--unknown'], ['--thresholds']]) {
    expect(() => parseMarginDesignArgs([...args, ...pair])).toThrow();
  }
  for (const invalid of [[], ['--case', 'unknown', '--margin', marginName], ['--case', caseId], ['--margin', marginName],
    [...args, '--margin', marginName]]) expect(() => parseMarginDesignArgs(invalid)).toThrow();
});

// ---------------------------------------------------------------------------
// 段階 1: term-counts.jsonl
// ---------------------------------------------------------------------------

test('term-counts.jsonl は最終行勝ちで圧縮し、壊れた行・欠測ファイルを無視する', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'term-counts-')), 'term-counts.jsonl');
  expect(loadTermCounts(path)).toEqual(new Map());
  const record1 = { blockId: '1', term: 'a[tiab]', marginQuery: 'q1', count: 10, countedAt: '2026-01-01T00:00:00Z' };
  const record2 = { blockId: '1', term: 'a[tiab]', marginQuery: 'q1', count: 99, countedAt: '2026-01-02T00:00:00Z' };
  writeFileSync(path, [JSON.stringify(record1), 'not-json{{', JSON.stringify(record2), ''].join('\n'));
  const loaded = loadTermCounts(path);
  expect(loaded.size).toBe(1);
  expect([...loaded.values()][0]).toEqual(record2);
});

// ---------------------------------------------------------------------------
// 段階 2: 案の組み立て（純粋関数）
// ---------------------------------------------------------------------------

describe('planMarginDesignVariants', () => {
  const lookup = new Map([['1 termA1[tiab]', 5], ['1 termA2[tiab]', 50], ['2 termB1[tiab]', 30]]);

  test('full はブロック・語順を保ったまま全語を保持する', () => {
    const plans = planMarginDesignVariants(additions, lookup, [1, 5, 50]);
    const full = plans.get('full')!;
    expect(full).toMatchObject({ sameAs: null, emptyMargin: false, additions });
    expect(full.keptTerms).toEqual([
      { blockId: '1', term: 'termA1[tiab]', count: 5 }, { blockId: '1', term: 'termA2[tiab]', count: 50 }, { blockId: '2', term: 'termB1[tiab]', count: 30 },
    ]);
    expect(full.droppedTerms).toEqual([]);
  });

  test('cutoff は件数超過の語を落とし、0 語のブロックを除く。ブロック内の語順は保つ', () => {
    const plans = planMarginDesignVariants(additions, lookup, [1, 5, 50]);
    const cutoff5 = plans.get('cutoff-5')!;
    expect(cutoff5.sameAs).toBeNull();
    expect(cutoff5.emptyMargin).toBe(false);
    expect(cutoff5.additions).toEqual([{ blockId: '1', additions: [termA1] }]);
    expect(cutoff5.keptTerms).toEqual([{ blockId: '1', term: 'termA1[tiab]', count: 5 }]);
    expect(cutoff5.droppedTerms).toEqual([{ blockId: '1', term: 'termA2[tiab]', count: 50 }, { blockId: '2', term: 'termB1[tiab]', count: 30 }]);
  });

  test('全語が超過なら emptyMargin、既に計算した案（full・先に処理した cutoff）と同一なら sameAs', () => {
    const plans = planMarginDesignVariants(additions, lookup, [1, 5, 50]);
    expect(plans.get('cutoff-1')).toMatchObject({ sameAs: null, emptyMargin: true, additions: null, keptTerms: [] });
    expect(plans.get('cutoff-1')!.droppedTerms).toHaveLength(3);
    // 50 は全語を残すため full と同一 -> sameAs
    expect(plans.get('cutoff-50')).toMatchObject({ sameAs: 'full', emptyMargin: false, additions: null });
  });

  test('空集合どうしも同一集合として扱い、2 個目以降の emptyMargin は最初の emptyMargin へ sameAs する', () => {
    const plans = planMarginDesignVariants(additions, lookup, [1, 2, 50]);
    expect(plans.get('cutoff-1')).toMatchObject({ sameAs: null, emptyMargin: true });
    expect(plans.get('cutoff-2')).toMatchObject({ sameAs: 'cutoff-1', emptyMargin: false });
  });

  test('per-block はブロック順を保ち、語が 1 ブロックしかなければ full に sameAs する', () => {
    const twoBlocks = planMarginDesignVariants(additions, lookup, [50]).get('per-block')!;
    expect(twoBlocks).toMatchObject({ sameAs: null, emptyMargin: false });
    expect(twoBlocks.blocksWithTerms).toEqual(additions);
    const oneBlock: BlockRecallAdditions[] = [{ blockId: '1', additions: [termA1] }];
    const single = planMarginDesignVariants(oneBlock, lookup, [50]).get('per-block')!;
    expect(single).toMatchObject({ sameAs: 'full', emptyMargin: false });
  });
});

// ---------------------------------------------------------------------------
// per-block 専用の純粋関数
// ---------------------------------------------------------------------------

test('allocatePerBlockRetmax: 余りは先頭のブロックから 1 件ずつ配る', () => {
  expect(allocatePerBlockRetmax(3, 200)).toEqual([67, 67, 66]);
  expect(allocatePerBlockRetmax(2, 200)).toEqual([100, 100]);
  expect(allocatePerBlockRetmax(4, 10)).toEqual([3, 3, 2, 2]);
  expect(allocatePerBlockRetmax(1, 5)).toEqual([5]);
});

test('interleaveRoundRobin: ブロック順のラウンドロビンで並べ、異なる位置の重複は先着を残す', () => {
  expect(interleaveRoundRobin([['a', 'b', 'c'], ['x', 'y']])).toEqual(['a', 'x', 'b', 'y', 'c']);
  // 'b' はブロック 0 では 2 番目、ブロック 1 では 1 番目に出現する（ブロック間で順位が異なる重複）。
  // ラウンドロビンの走査順（ブロック 0 の 1 番目 -> ブロック 1 の 1 番目 -> ブロック 0 の 2 番目 -> ...）で
  // 先に現れた出現だけを残し、後の重複は捨てる。
  expect(interleaveRoundRobin([['a', 'b'], ['b', 'c']])).toEqual(['a', 'b', 'c']);
  expect(interleaveRoundRobin([[], ['x']])).toEqual(['x']);
  expect(interleaveRoundRobin([])).toEqual([]);
});

// ---------------------------------------------------------------------------
// runPerBlockVariant: 単体（main() の統合テストとは別に、最小限のフェイクだけで検証する）
// ---------------------------------------------------------------------------

function fakePerBlockEutils(marginInfo: Record<string, { count: number; pmids: string[] }>): EutilsDeps {
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/esearch.fcgi')) {
      const term = url.searchParams.get('term') ?? '';
      const retmax = Number(url.searchParams.get('retmax') ?? '0');
      const info = marginInfo[term];
      if (!info) throw new Error(`想定外のクエリ: ${term}`);
      return new Response(JSON.stringify({ esearchresult: { count: String(info.count), idlist: info.pmids.slice(0, retmax) } }));
    }
    if (url.pathname.endsWith('/efetch.fcgi')) {
      const ids = (url.searchParams.get('id') ?? '').split(',').filter(Boolean);
      const xml = ids.map((pmid) => `<PubmedArticle><MedlineCitation><PMID>${pmid}</PMID><Article><ArticleTitle>Title ${pmid}</ArticleTitle></Article></MedlineCitation></PubmedArticle>`).join('');
      return new Response(`<PubmedArticleSet>${xml}</PubmedArticleSet>`);
    }
    throw new Error(`想定外の通信: ${url.toString()}`);
  };
  // apiKey ありのバケット（beforeEach で acquire を即時解決にモック済み）を使い、実時間のレート制御を避ける。
  return { fetch: fetchImpl, apiKey: 'fake', strictCounts: true };
}

function fakePerBlockLlmFactory(chat: LLMProvider['chat']): LlmProviderFactory {
  return { model: 'fake-model', forPurpose: () => ({ providerId: 'gemini', model: 'fake-model', chat }) };
}

const protocolForPerBlock = { researchQuestion: 'RQ', inclusionCriteria: '組入', exclusionCriteria: '除外' };
// runPerBlockVariant は c0.formula から buildBlockMarginQuery を組む。marginQueryFor と同じ formula を渡し、
// テストの期待クエリ文字列（q1/q2）と実装が内部で組むクエリを一致させる。他フィールドは使わない。
const fakeC0ForPerBlock = { formula } as C0Artifact;

test('runPerBlockVariant: 既知の seed は novel から除外され、efetch・LLM には渡らない', async () => {
  const blocks: BlockRecallAdditions[] = [{ blockId: '1', additions: [termA1] }, { blockId: '2', additions: [termB1] }];
  const q1 = marginQueryFor([{ blockId: '1', additions: [termA1] }]);
  const q2 = marginQueryFor([{ blockId: '2', additions: [termB1] }]);
  const marginInfo = { [q1]: { count: 2, pmids: ['900', '201'] }, [q2]: { count: 1, pmids: ['301'] } };
  let chatCalls = 0;
  const llmFactory = fakePerBlockLlmFactory(async () => { chatCalls++; return { text: JSON.stringify({ picks: [] }), tokensIn: 1, tokensOut: 1, raw: null }; });
  const result = await runPerBlockVariant(fakeC0ForPerBlock, blocks, new Set(['900']), protocolForPerBlock, originalQuery,
    { retmax: 4, skillCandidateLimit: 20, sort: 'relevance' },
    { eutils: fakePerBlockEutils(marginInfo), llmFactory, progress: () => undefined });
  // '900' は既知シードなので novelPmids・requestedPmids・fetchedPmids のどこにも現れない
  expect(result.stages.retrievedPmids).toEqual(['900', '301', '201']);
  expect(result.stages.novelPmids).toEqual(['301', '201']);
  expect(result.stages.fetchedPmids).not.toContain('900');
  expect(chatCalls).toBe(1);
});

test('runPerBlockVariant: skillCandidateLimit を超える分は requested に入らない', async () => {
  const blocks: BlockRecallAdditions[] = [{ blockId: '1', additions: [termA1] }];
  const q1 = marginQueryFor([{ blockId: '1', additions: [termA1] }]);
  const marginInfo = { [q1]: { count: 5, pmids: ['101', '102', '103', '104', '105'] } };
  const llmFactory = fakePerBlockLlmFactory(async () => ({ text: JSON.stringify({ picks: [] }), tokensIn: 1, tokensOut: 1, raw: null }));
  const result = await runPerBlockVariant(fakeC0ForPerBlock, blocks, new Set(), protocolForPerBlock, originalQuery,
    { retmax: 5, skillCandidateLimit: 2, sort: 'relevance' },
    { eutils: fakePerBlockEutils(marginInfo), llmFactory, progress: () => undefined });
  expect(result.stages.novelPmids).toEqual(['101', '102', '103', '104', '105']);
  expect(result.stages.requestedPmids).toEqual(['101', '102']);
  expect(result.stages.fetchedPmids).toEqual(['101', '102']);
});

test('runPerBlockVariant: 書誌が 0 件（efetch が何も返さない）なら LLM を呼ばない', async () => {
  const blocks: BlockRecallAdditions[] = [{ blockId: '1', additions: [termA1] }];
  const q1 = marginQueryFor([{ blockId: '1', additions: [termA1] }]);
  // esearch は PMID を返すが、efetch 側の articles マップに無い（欠落）ため fetchedPmids は 0 件になる。
  const marginInfo = { [q1]: { count: 1, pmids: ['999999'] } };
  const eutils = fakePerBlockEutils(marginInfo);
  const originalEfetchImpl = eutils.fetch;
  eutils.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/efetch.fcgi')) return new Response('<PubmedArticleSet></PubmedArticleSet>');
    return originalEfetchImpl(input, init);
  };
  const llmFactory = fakePerBlockLlmFactory(async () => { throw new Error('LLM は呼ばれない想定です'); });
  const result = await runPerBlockVariant(fakeC0ForPerBlock, blocks, new Set(), protocolForPerBlock, originalQuery,
    { retmax: 5, skillCandidateLimit: 20, sort: 'relevance' },
    { eutils, llmFactory, progress: () => undefined });
  expect(result.stages.requestedPmids).toEqual(['999999']);
  expect(result.stages.fetchedPmids).toEqual([]);
  expect(result.candidates).toEqual([]);
});

// ---------------------------------------------------------------------------
// main(): 統合（フェイク通信）
// ---------------------------------------------------------------------------

interface EsearchEvent { kind: 'esearch'; term: string; retmax: string | null }
interface EfetchEvent { kind: 'efetch'; ids: string[] }
interface LlmEvent { kind: 'llm'; body: string }
type FakeEvent = EsearchEvent | EfetchEvent | LlmEvent;

/**
 * @param options.failTermCountFor 段階 1（retmax=0 の件数取得）でこの語の margin クエリだけ 1 回失敗させる
 * @param options.failCaptureFor 語ごとの捕捉表（writeTermCaptureTable）がこの語の margin クエリを
 *   base にした gold 照合（`(<marginQuery>) AND (...)` 形の uid クエリ）を送ったときだけ 1 回失敗させる
 */
function fakeNetwork(options: { failTermCountFor?: string; failCaptureFor?: string } = {}) {
  const events: FakeEvent[] = [];
  const marginInfo: Record<string, { count: number; pmids: string[] }> = {
    [termA1MarginQuery]: { count: 5, pmids: ['201', '202'] },
    [termA2MarginQuery]: { count: 50, pmids: [] },
    [termB1MarginQuery]: { count: 30, pmids: ['301'] },
    [blockOneMarginQuery]: { count: 6, pmids: ['201', '202'] },
    [fullMarginQuery]: { count: 8, pmids: ['201', '202', '301', '999'] },
  };
  const goldBases: { key: string; allowed: string[] }[] = [
    { key: originalQuery, allowed: ['900', '901', '902', '501'] },
    { key: fullMarginQuery, allowed: ['201'] },
    { key: termA1MarginQuery, allowed: ['201'] },
    { key: blockOneMarginQuery, allowed: ['201'] },
    { key: termB1MarginQuery, allowed: [] },
    { key: termA2MarginQuery, allowed: [] },
  ];
  let failTermA1SelectionOnce = false;
  let termCountFailurePending = options.failTermCountFor !== undefined;
  let captureFailurePending = options.failCaptureFor !== undefined;
  const network = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const body = String(init?.body ?? '');
    const params = init?.method === 'POST' ? new URLSearchParams(body) : url.searchParams;
    if (url.hostname === 'generativelanguage.googleapis.com') {
      events.push({ kind: 'llm', body });
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ picks: [{ pmid: '201', reason: 'boundary' }] }) }] } }],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4 } }));
    }
    if (url.pathname.endsWith('/efetch.fcgi')) {
      const ids = (params.get('id') ?? '').split(',').filter(Boolean);
      events.push({ kind: 'efetch', ids });
      const xml = ids.map((pmid) => `<PubmedArticle><MedlineCitation><PMID>${pmid}</PMID><Article><ArticleTitle>Title ${pmid}</ArticleTitle></Article></MedlineCitation></PubmedArticle>`).join('');
      return new Response(`<PubmedArticleSet>${xml}</PubmedArticleSet>`);
    }
    if (url.pathname.endsWith('/esearch.fcgi')) {
      const term = params.get('term') ?? '';
      const retmax = params.get('retmax');
      events.push({ kind: 'esearch', term, retmax });
      if (retmax === '0' && termCountFailurePending && term === options.failTermCountFor) {
        // 段階 1（件数取得）の恒久失敗を再現する。plain Error で throw すると retryWithBackoff に
        // 再送されてしまうため（下の simulated-permanent-failure と同じ理由）、in-band エラーで返す。
        termCountFailurePending = false;
        return new Response(JSON.stringify({ esearchresult: { ERROR: 'simulated-term-count-failure' } }));
      }
      if (term.includes('[uid]')) {
        const matched = goldBases.find((base) => term.startsWith(`(${base.key}) AND (`));
        if (captureFailurePending && matched?.key === options.failCaptureFor) {
          captureFailurePending = false;
          return new Response(JSON.stringify({ esearchresult: { ERROR: 'simulated-term-capture-failure' } }));
        }
        const uidSection = matched ? term.slice(`(${matched.key}) AND (`.length, -1) : term.slice(1, -1);
        const requested = [...uidSection.matchAll(/([\w-]+)\[uid\]/g)].map((m) => m[1]!);
        const allowed = matched ? matched.allowed : requested; // 日付範囲の検証は全件 in-date とする
        const pmids = requested.filter((pmid) => allowed.includes(pmid));
        return new Response(JSON.stringify({ esearchresult: { count: String(pmids.length), idlist: pmids } }));
      }
      if (term === originalQuery) return new Response(JSON.stringify({ esearchresult: { count: '9', idlist: [] } }));
      if (failTermA1SelectionOnce && term === termA1MarginQuery && retmax !== '0') {
        // createEvalFetch は fetch 実装が投げた例外を redact して plain Error に包み直すため、
        // ここで EutilsError を throw しても permanent フラグが失われ retryWithBackoff に
        // 再送されてしまう（実際に一度それで 31 秒の実バックオフを踏んだ）。恒久エラー（in-band
        // ERROR）を再現するには、esearch() 自身がそう解釈する 200 応答を返す必要がある。
        failTermA1SelectionOnce = false;
        return new Response(JSON.stringify({ esearchresult: { ERROR: 'simulated-permanent-failure' } }));
      }
      const info = marginInfo[term];
      if (!info) throw new Error(`想定外のクエリ: ${term}`);
      return new Response(JSON.stringify({ esearchresult: { count: String(info.count), idlist: info.pmids.slice(0, Number(retmax ?? '20')) } }));
    }
    throw new Error('想定外の通信');
  });
  return { network, events, failTermA1Once: () => { failTermA1SelectionOnce = true; } };
}

test('main(): 段階 1〜3・保存・スキップ・失敗の再実行を一気通貫で検証する', async () => {
  const fixture = setup();
  const { events, failTermA1Once } = fakeNetwork();
  const runArgs = [...args, '--thresholds', '1,5,50', '--rank-depth', '5'];

  failTermA1Once();
  await main(runArgs, fixture.root, fixture.results);

  // 段階 1: 3 語ぶんが 1 行ずつ永続化される
  const countsPath = termCountsPath(fixture.results, caseId, marginName);
  const countLines = readFileSync(countsPath, 'utf8').trim().split('\n');
  expect(countLines).toHaveLength(3);
  expect(loadTermCounts(countsPath).size).toBe(3);

  const dirFor = (variant: string) => marginDesignResultDir(fixture.results, caseId, marginName, 20260912, variant);
  const readRun = (variant: string) => JSON.parse(readFileSync(join(dirFor(variant), 'run.json'), 'utf8')) as MarginDesignVariantRun;

  // cutoff-5 は 1 回目の esearch で失敗 -> failed。他の案は完了する。
  const cutoff5Failed = readRun('cutoff-5');
  expect(cutoff5Failed.status).toBe('failed');
  expect(cutoff5Failed.error).toContain('simulated-permanent-failure');
  expect(process.exitCode).toBe(1);
  process.exitCode = 0;

  const full = readRun('full');
  expect(full.status).toBe('completed');
  expect(full.sameAs).toBeNull();
  expect(full.emptyMargin).toBe(false);
  expect(full.marginHits).toBe(8);
  expect(full.stages?.marginQuery).toBe(fullMarginQuery);
  expect(full.candidates).toEqual([{ pmid: '201', reason: 'boundary' }]);
  expect(full.heldOutStages.find((s) => s.studyId === 'H-current')).toMatchObject({ stage: 'captured_by_current' });
  expect(full.heldOutStages.find((s) => s.studyId === 'H-presented')).toMatchObject({ stage: 'presented', deepRank: 1, deepRankBlockId: null });
  // H-hidden（777）はどの margin にも入らないので not_in_margin。取りこぼしは H-presented と合わせて 2 件。
  expect(full.heldOutStages.find((s) => s.studyId === 'H-hidden')).toMatchObject({ stage: 'not_in_margin' });
  expect(full.missedHeldOutCount).toBe(2);
  expect(full.config).toEqual({ retmax: 200, candidateLimit: 200, sort: 'relevance', rankDepth: 5 });

  const cutoff1 = readRun('cutoff-1');
  expect(cutoff1.emptyMargin).toBe(true);
  expect(cutoff1.marginHits).toBe(0);
  expect(cutoff1.keptTerms).toEqual([]);
  expect(cutoff1.droppedTerms).toHaveLength(3);
  // margin が空 -> 未捕捉はすべて not_in_margin
  expect(cutoff1.heldOutStages.find((s) => s.studyId === 'H-current')).toMatchObject({ stage: 'captured_by_current' });
  expect(cutoff1.heldOutStages.find((s) => s.studyId === 'H-presented')).toMatchObject({ stage: 'not_in_margin' });
  expect(cutoff1.heldOutStages.find((s) => s.studyId === 'H-hidden')).toMatchObject({ stage: 'not_in_margin' });

  const cutoff50 = readRun('cutoff-50');
  expect(cutoff50.sameAs).toBe('full');
  expect(cutoff50.heldOutStages).toEqual([]);
  expect(cutoff50.stageCounts).toEqual(Object.fromEntries(Object.keys(full.stageCounts).map((k) => [k, 0])));

  const perBlock = readRun('per-block');
  expect(perBlock.status).toBe('completed');
  expect(perBlock.marginHits).toBeNull();
  expect(perBlock.marginHitsByBlock).toEqual([
    { blockId: '1', marginQuery: blockOneMarginQuery, count: 6 }, { blockId: '2', marginQuery: termB1MarginQuery, count: 30 },
  ]);
  expect(perBlock.marginHitsSumAllowingOverlap).toBe(36);
  expect(perBlock.stages?.retrievedPmids).toEqual(['201', '301', '202']);
  expect(perBlock.candidates).toEqual([{ pmid: '201', reason: 'boundary' }]);
  const presented = perBlock.heldOutStages.find((s) => s.studyId === 'H-presented')!;
  expect(presented).toMatchObject({ stage: 'presented', deepRank: 1, deepRankBlockId: '1' });
  expect(perBlock.heldOutStages.find((s) => s.studyId === 'H-current')).toMatchObject({ stage: 'captured_by_current', deepRankBlockId: null });
  expect(perBlock.heldOutStages.find((s) => s.studyId === 'H-hidden')).toMatchObject({ stage: 'not_in_margin' });

  // gold（シード 900/901/902、held-out 501/777）が選定の実際の通信（efetch の id・LLM への入力）に
  // 一切現れないこと。`!term.includes('501')` のような非 uid クエリの文字列検査は、PMID がクエリ文字列に
  // 直接書かれることがそもそも無いため必ず通ってしまう（tautology）。efetch の id・LLM のリクエスト本文は
  // 実際に PMID を運ぶ経路なので、ここで検査して初めて意味を持つ。
  const efetchIds = events.filter((e): e is EfetchEvent => e.kind === 'efetch').flatMap((e) => e.ids);
  const llmBodies = events.filter((e): e is LlmEvent => e.kind === 'llm').map((e) => e.body);
  for (const goldOnlyPmid of ['900', '901', '902', '501', '777']) {
    expect(efetchIds).not.toContain(goldOnlyPmid);
    expect(llmBodies.some((llmBody) => llmBody.includes(goldOnlyPmid))).toBe(false);
  }

  // term-capture.json: 現式で未捕捉（H-presented・H-hidden）の研究について語ごとの捕捉を記録
  const capturePath = join(fixture.results, 'margin-design', caseId, marginName, 's20260912', 'term-capture.json');
  const capture = JSON.parse(readFileSync(capturePath, 'utf8')) as { term: string; blockId: string; count: number; capturedStudyIds: string[] }[];
  expect(capture).toHaveLength(3);
  expect(capture.find((row) => row.term === 'termA1[tiab]')).toMatchObject({ capturedStudyIds: ['H-presented'] });
  expect(capture.find((row) => row.term === 'termB1[tiab]')).toMatchObject({ capturedStudyIds: [] });

  // --report: 失敗行・sameAs 行を含めて集計できる
  const rows = marginDesignRows([full, cutoff1, cutoff50, perBlock, cutoff5Failed]);
  expect(rows[0]).toEqual(['case', 'margin', 'seedSplit', 'variant', 'label', 'sameAs', 'keptTerms', 'marginHits', 'missedHeldOutCount',
    'presentedCount', 'missedStudies', 'fetchedCount', 'pickedCount', 'llmTokensIn', 'llmCostUsd', 'elapsedMs']);
  const perBlockRow = rows.find((row) => row[3] === 'per-block')!;
  expect(perBlockRow[2]).toBe('s20260912');
  expect(perBlockRow[7]).toBe('6+30');
  const failedRow = rows.find((row) => row[3] === 'cutoff-5')!;
  expect(failedRow[7]).toBe('失敗');
  // sameAs（cutoff-50 -> full）の行は測定していない列を =full と表示し、0 や - を出さない
  const sameAsRow = rows.find((row) => row[3] === 'cutoff-50')!;
  expect(sameAsRow[5]).toBe('full');
  expect([sameAsRow[7], sameAsRow[8], sameAsRow[9], sameAsRow[11], sameAsRow[12], sameAsRow[13], sameAsRow[14]])
    .toEqual(['=full', '=full', '=full', '=full', '=full', '=full', '=full']);
  // missedStudies は取得順位と深い順位を区別し、per-block はブロック ID を付記する
  const fullRow = rows.find((row) => row[3] === 'full')!;
  const fullPresented = full.heldOutStages.find((s) => s.studyId === 'H-presented')!;
  expect(fullRow[10]).toContain(`H-presented:presented@取得${fullPresented.retrievedRank ?? '-'}/深い${fullPresented.deepRank ?? '-'}`);
  expect(fullRow[10]).not.toContain('(#');
  expect(perBlockRow[10]).toContain(`H-presented:presented@取得${presented.retrievedRank ?? '-'}/深い${presented.deepRank ?? '-'} (#1)`);

  // cutoff-5 は failed のままなので再実行される。他の完了済み案は再実行時に触られない
  // （このモックへ問い合わせが行かない = 同じコミットの完了はスキップされている）。今度は成功させる。
  const { events: secondEvents } = fakeNetwork();
  await main(runArgs, fixture.root, fixture.results);
  const cutoff5Retried = readRun('cutoff-5');
  expect(cutoff5Retried.status).toBe('completed');
  expect(cutoff5Retried.marginHits).toBe(5);
  expect(cutoff5Retried.heldOutStages.find((s) => s.studyId === 'H-presented')).toMatchObject({ stage: 'presented' });
  expect(secondEvents.some((e) => e.kind === 'esearch' && e.term === fullMarginQuery)).toBe(false);
  expect(secondEvents.some((e) => e.kind === 'esearch' && e.term === blockOneMarginQuery)).toBe(false);
  // 段階 1 は数え済みの語について retmax=0 の件数取得を一切再送しない
  const termCountRequeries = secondEvents.filter((e): e is EsearchEvent => e.kind === 'esearch' && e.retmax === '0'
    && [termA1MarginQuery, termA2MarginQuery, termB1MarginQuery].includes(e.term));
  expect(termCountRequeries).toEqual([]);

  // すべて完了した後の再実行は全案スキップし、config() すら呼ばず一切通信しない
  jest.mocked(config).mockClear();
  const rerunNetwork = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('実通信禁止'));
  // globalThis.fetch は fakeNetwork() の spyOn を再利用するため、直前までの呼び出し履歴が
  // 残っている。ここからの「通信していない」判定に使うので、このモック自身の履歴を消しておく。
  rerunNetwork.mockClear();
  await main(runArgs, fixture.root, fixture.results);
  expect(rerunNetwork).not.toHaveBeenCalled();
  expect(config).not.toHaveBeenCalled();
}, 20000);

test('段階 1 で esearch が恒久失敗した語は jsonl に残らず main が失敗する。再実行はその語だけ数え直す', async () => {
  const fixture = setup();
  const runArgs = [...args, '--thresholds', '1,5,50'];
  const countsPath = termCountsPath(fixture.results, caseId, marginName);

  fakeNetwork({ failTermCountFor: termA2MarginQuery });
  // additions の順は termA1(block1) -> termA2(block1) -> termB1(block2)。termA2 で失敗するので
  // termA1 はすでに 1 行書かれているが、termA2 の行は書かれず、termB1 にはまだ到達しない。
  await expect(main(runArgs, fixture.root, fixture.results)).rejects.toThrow('simulated-term-count-failure');
  const afterFailure = loadTermCounts(countsPath);
  expect([...afterFailure.values()].map((r) => r.term)).toEqual(['termA1[tiab]']);
  // 段階 1 より後（案の実行）には一切進んでいない
  expect(existsSync(join(fixture.results, 'margin-design', caseId, marginName, 's20260912'))).toBe(false);

  // 再実行: termA1 は数え済みなので通信しない。termA2・termB1 だけ数え直す。
  const { events } = fakeNetwork();
  await main(runArgs, fixture.root, fixture.results);
  const afterRetry = loadTermCounts(countsPath);
  expect(afterRetry.size).toBe(3);
  const termCountCalls = events.filter((e): e is EsearchEvent => e.kind === 'esearch' && e.retmax === '0'
    && [termA1MarginQuery, termA2MarginQuery, termB1MarginQuery].includes(e.term));
  expect(termCountCalls.map((e) => e.term)).toEqual([termA2MarginQuery, termB1MarginQuery]);
});

test('全案 completed で term-capture.json が無ければ、選定を一切せずに捕捉表だけを作り直す', async () => {
  const fixture = setup();
  const runArgs = [...args, '--thresholds', '1,5,50', '--rank-depth', '5'];
  fakeNetwork();
  await main(runArgs, fixture.root, fixture.results); // 通常どおり完走させる（term-capture.json も作られる）

  const capturePath = termCaptureTablePath(fixture.results, caseId, marginName, 20260912);
  expect(existsSync(capturePath)).toBe(true);
  rmSync(capturePath); // 何らかの理由で欠落したことを模擬する

  // GEMINI_API_KEY を外しても失敗しないこと（この経路は LLM を一切使わない）を合わせて確認する。
  delete process.env.GEMINI_API_KEY;
  const { events } = fakeNetwork();
  await main(runArgs, fixture.root, fixture.results);

  expect(existsSync(capturePath)).toBe(true);
  // 案の選定（LLM・efetch）は一切走らない
  expect(events.some((e) => e.kind === 'llm')).toBe(false);
  expect(events.some((e) => e.kind === 'efetch')).toBe(false);
  // margin の取得・件数の再取得（[uid] を含まない esearch）も一切ない。段階 1 はキャッシュ済みで、
  // 案を実行しないので originalHitsShared の再計算もしない。gold 照合（[uid]）だけが通信する。
  const nonUidEsearch = events.filter((e): e is EsearchEvent => e.kind === 'esearch' && !e.term.includes('[uid]'));
  expect(nonUidEsearch).toEqual([]);
});

test('term-capture.json の作成が失敗したら run.json は完了のまま・ファイルは残らず非ゼロ終了。次回また作り直す', async () => {
  const fixture = setup();
  const runArgs = [...args, '--thresholds', '1,5,50', '--rank-depth', '5'];
  fakeNetwork();
  await main(runArgs, fixture.root, fixture.results);

  const capturePath = termCaptureTablePath(fixture.results, caseId, marginName, 20260912);
  expect(existsSync(capturePath)).toBe(true);
  rmSync(capturePath);
  const fullRunPath = join(marginDesignResultDir(fixture.results, caseId, marginName, 20260912, 'full'), 'run.json');
  const fullBefore = readFileSync(fullRunPath, 'utf8');

  fakeNetwork({ failCaptureFor: termA1MarginQuery });
  await main(runArgs, fixture.root, fixture.results);
  expect(existsSync(capturePath)).toBe(false);
  expect(existsSync(`${capturePath}.tmp`)).toBe(false);
  expect(process.exitCode).toBe(1);
  process.exitCode = 0;
  // 案の run.json は触られていない（完了のまま）
  expect(readFileSync(fullRunPath, 'utf8')).toBe(fullBefore);

  // 次の実行でまた作られる
  fakeNetwork();
  await main(runArgs, fixture.root, fixture.results);
  expect(existsSync(capturePath)).toBe(true);
});

// ---------------------------------------------------------------------------
// marginDesignRows: seedSplit（別の --seeds の run を取り違えないこと）
// ---------------------------------------------------------------------------

/** marginDesignRows のテスト専用の最小限の run。実行結果には興味がなく、識別列の挙動だけを見る。 */
function fakeRun(overrides: Partial<MarginDesignVariantRun> & Pick<MarginDesignVariantRun, 'caseId' | 'seedSplit' | 'variant'>): MarginDesignVariantRun {
  return {
    status: 'completed', error: null, runId: 'r', margin: { name: marginName, sha256: 'x' }, c0: { name: 'c0', sha256: 'x' },
    threshold: null, label: null, searchDate: '2022-03-31', model: 'fake', gitCommit: null, gitDirty: null,
    sameAs: null, emptyMargin: false, keptTerms: [], droppedTerms: [],
    config: { retmax: 200, candidateLimit: 200, sort: 'relevance', rankDepth: 0 },
    originalHits: 10, marginHits: 5, marginHitsByBlock: null, marginHitsSumAllowingOverlap: null,
    stages: { broadenedQuery: null, marginQuery: null, retrievedPmids: [], novelPmids: [], requestedPmids: [], fetchedPmids: [], pickedPmids: [] },
    candidates: [], heldOutStages: [], missedHeldOutCount: 0,
    stageCounts: Object.fromEntries(STAGE_NAMES.map((stage) => [stage, 0])) as Record<OutsideStage, number>,
    apiCalls: { ncbi: 0, llm: 0 }, apiElapsedMs: { ncbi: 0, llm: 0 },
    llmUsage: { calls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, unpricedCalls: 0, untrackedCalls: 0 },
    elapsedMs: 1, llmLogs: [],
    ...overrides,
  };
}

test('marginDesignRows: 同じ case・margin で seedSplit だけ違う run は別行になり、seedSplit 順に並ぶ', () => {
  // 投入順はわざと「既定分割 -> 名前付き分割」にし、ソートが効いていることを検査する。
  const runDefault = fakeRun({ caseId, seedSplit: 's20260912', variant: 'full' });
  const runNamed = fakeRun({ caseId, seedSplit: 'confirmed', variant: 'full' });
  const rows = marginDesignRows([runDefault, runNamed]);
  expect(rows).toHaveLength(3); // header + 2 行（同じ case・margin・variant でも別 run として混ざらない）
  expect(rows[1]![2]).toBe('confirmed'); // 'c' < 's' なので seedSplit 順で先に来る
  expect(rows[2]![2]).toBe('s20260912');
});

test('dry-run は margin・C0 ハッシュを照合するだけで .env・通信・書き込みなし', async () => {
  const fixture = setup();
  const network = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('実通信禁止'));
  await main([...args, '--dry-run'], fixture.root, fixture.results);
  expect(network).not.toHaveBeenCalled();
  expect(config).not.toHaveBeenCalled();
  expect(existsSync(fixture.results)).toBe(false);
  expect(process.stdout.write).toHaveBeenCalledWith(expect.stringContaining('full ->'));
  // term-capture.json の出力先と要否（未作成なので「案の実行後に作成する」）も表示する
  expect(process.stdout.write).toHaveBeenCalledWith(expect.stringContaining('term-capture ->'));
  expect(process.stdout.write).toHaveBeenCalledWith(expect.stringContaining('案の実行後に作成する'));
});

test('前提（margin・C0 ハッシュ、検索日）の不一致は dry-run でも拒否する', async () => {
  const fixture = setup();
  const badMargin = JSON.parse(readFileSync(join(fixture.dir, 'margin', `${marginName}.json`), 'utf8'));
  badMargin.sha256 = 'bad';
  writeFileSync(join(fixture.dir, 'margin', `${marginName}.json`), JSON.stringify(badMargin));
  await expect(main([...args, '--dry-run'], fixture.root, fixture.results)).rejects.toThrow('一致しません');
});
