import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from 'dotenv';
import {
  OUTSIDE_DEFAULT_RETMAX,
  OUTSIDE_DEFAULT_SKILL_CANDIDATE_LIMIT,
  OUTSIDE_DEFAULT_SORT,
  searchOutsideCandidates,
  type OutsideSearchStages,
} from '../../src/app/services/expandService';
import type { LlmProviderFactory } from '../../src/app/services/llmProviderService';
import { buildBroadenedFormula, buildMarginQuery, type BlockRecallAdditions } from '../../src/features/formula/recallExpansion';
import { pickBoundaryCases, type BoundaryCandidate } from '../../src/features/formula/skills';
import { expandFormula } from '../../src/features/validation/expandFormula';
import { GeminiProvider } from '../../src/lib/llm/GeminiProvider';
import { efetchArticles, esearch, type EutilsDeps } from '../../src/lib/ncbi';
import { loadC0Artifact, type C0Artifact } from './c0Artifact';
import { installDomParser } from './domParser';
import { loadMarginArtifact, validateMarginName, type MarginArtifact } from './freezeMargin';
import { getGitCommit, isGitDirty } from './gitInfo';
import { createLlmUsageTracker } from './llmUsage';
import { capturedGold, createEvalFetch, observeBackoff, observeRateLimiter, redact } from './ncbiEval';
import { classifyStudy, decideOutsideExisting, STAGE_NAMES, type OutsideStage, type StudyStage } from './outsideStages';
import { computeHeldOut, FIXTURES, loadSeedsFile, parseSeedSplit, SEED, seedSplitId, validateSeeds, type SeedSplit } from './prepare';
import { loggedFactory, reportError, RESULTS } from './run';
import { CASES, type BenchCase, type FrozenSeeds, type LlmUsage } from './types';

/**
 * issue #154: margin（拡張式 NOT 現式）の組み方を変えて margin を小さくする案を比較するハーネス。
 * `eval:outside-stages`（issue #126）が明らかにした「取得段階ではなく margin の大きさが律速」
 * という結論を受け、拡張語の絞り込み方 3 案を同じ取得枠（製品既定 200/200/relevance）で比較する。
 * 製品コード（src/）は変更しない。gold（held-out の PMID）は選定（段階 1・2）の入力に一切使わず、
 * 段階 3（事後集計）でのみ使う。
 */

// ---------------------------------------------------------------------------
// 引数
// ---------------------------------------------------------------------------

export interface MarginDesignArgs {
  caseId: string;
  marginName: string;
  seed: SeedSplit;
  thresholds: number[];
  rankDepth: number;
  label?: string;
  dryRun: boolean;
}

function parseThresholds(raw: string | undefined): number[] {
  const parts = (raw ?? '1000,2500,5000').split(',').map((part) => part.trim());
  const values = parts.map((part) => {
    if (!/^[1-9]\d*$/.test(part)) throw new Error('--thresholds には正整数をカンマ区切りで指定してください');
    const value = Number(part);
    if (!Number.isSafeInteger(value)) throw new Error('--thresholds には正整数をカンマ区切りで指定してください');
    return value;
  });
  if (new Set(values).size !== values.length) throw new Error('--thresholds に重複した値があります');
  return [...values].sort((a, b) => a - b);
}

export function parseMarginDesignArgs(args: string[]): MarginDesignArgs {
  const values: Record<string, string> = {};
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (key === '--dry-run' && !dryRun) dryRun = true;
    else if (['--case', '--margin', '--seeds', '--thresholds', '--rank-depth', '--label'].includes(key)
      && values[key] === undefined && args[i + 1] !== undefined && !args[i + 1]!.startsWith('--')) values[key] = args[++i]!;
    else throw new Error(`未対応・重複または値のない引数: ${key}`);
  }
  const caseId = values['--case'] ?? '';
  if (!CASES.some((item) => item.id === caseId)) throw new Error('--case には既知のケース ID を指定してください');
  const marginName = values['--margin'] ?? '';
  validateMarginName(marginName);
  const thresholds = parseThresholds(values['--thresholds']);
  const rankDepthRaw = values['--rank-depth'];
  const rankDepth = rankDepthRaw === undefined ? 10000 : Number(rankDepthRaw);
  if ((rankDepthRaw !== undefined && !/^\d+$/.test(rankDepthRaw)) || !Number.isSafeInteger(rankDepth) || rankDepth < 0 || rankDepth > 10000) {
    throw new Error('--rank-depth には 0〜10000 の整数を指定してください');
  }
  const label = values['--label'];
  if (label !== undefined && (!/^[A-Za-z0-9._-]{1,40}$/.test(label) || /^replay-/i.test(label))) {
    throw new Error('--label は英数字・.・_・- の 1〜40 文字で指定してください（replay- で始まる名前は使用できません）');
  }
  return { caseId, marginName, seed: values['--seeds'] === undefined ? SEED : parseSeedSplit(values['--seeds']),
    thresholds, rankDepth, label, dryRun };
}

// ---------------------------------------------------------------------------
// 段階 1: 語ごとの margin 件数（gold を使わない）
// ---------------------------------------------------------------------------

export interface TermCountRecord {
  blockId: string;
  term: string;
  marginQuery: string;
  count: number;
  countedAt: string;
}

export function termCountsPath(resultsDir: string, caseId: string, marginName: string): string {
  return join(resultsDir, 'margin-design', caseId, marginName, 'term-counts.jsonl');
}

/** キーは marginQuery の sha256。壊れた行は無視し、同じキーは最終行勝ちで圧縮する。 */
export function loadTermCounts(path: string): Map<string, TermCountRecord> {
  const map = new Map<string, TermCountRecord>();
  if (!existsSync(path)) return map;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean)) {
    try {
      const record = JSON.parse(line) as TermCountRecord;
      if (typeof record.marginQuery !== 'string' || typeof record.blockId !== 'string' || typeof record.term !== 'string'
        || typeof record.count !== 'number') continue;
      map.set(createHash('sha256').update(record.marginQuery).digest('hex'), record);
    } catch { /* 壊れた行は無視する */ }
  }
  return map;
}

/**
 * 凍結 margin の拡張語を 1 語ずつ数える。数え済み（jsonl に既にある marginQuery）は通信せず再利用する。
 * 1 語ごとに永続化し、esearch が失敗した語の行は書き込まない（一過性の失敗を件数として残さない）。
 */
async function countTerms(c0: C0Artifact, margin: MarginArtifact, path: string, eutils: EutilsDeps): Promise<Map<string, TermCountRecord>> {
  const originalQuery = expandFormula(c0.formula).trim();
  const counts = loadTermCounts(path);
  mkdirSync(dirname(path), { recursive: true });
  for (const block of margin.additions) {
    for (const item of block.additions) {
      const single: BlockRecallAdditions[] = [{ blockId: block.blockId, additions: [item] }];
      const broadenedQuery = expandFormula(buildBroadenedFormula(c0.formula, single)).trim();
      const marginQuery = buildMarginQuery(broadenedQuery, originalQuery);
      const key = createHash('sha256').update(marginQuery).digest('hex');
      if (counts.has(key)) continue;
      const result = await esearch(marginQuery, eutils, { retmax: 0 });
      const record: TermCountRecord = { blockId: block.blockId, term: item.term, marginQuery, count: result.count, countedAt: new Date().toISOString() };
      appendFileSync(path, JSON.stringify(record) + '\n');
      counts.set(key, record);
    }
  }
  return counts;
}

function termCountLookup(counts: Map<string, TermCountRecord>): Map<string, number> {
  const lookup = new Map<string, number>();
  for (const record of counts.values()) lookup.set(`${record.blockId} ${record.term}`, record.count);
  return lookup;
}

function lookupCount(lookup: Map<string, number>, blockId: string, term: string): number {
  const count = lookup.get(`${blockId} ${term}`);
  if (count === undefined) throw new Error(`語の件数が見つかりません（先に段階 1 を実行してください）: ${blockId}/${term}`);
  return count;
}

// ---------------------------------------------------------------------------
// 段階 2: 案ごとの候補選定（gold を使わない）
// ---------------------------------------------------------------------------

export type MarginDesignVariantKind = 'full' | 'cutoff' | 'per-block';

export interface KeptTerm { blockId: string; term: string; count: number }

export interface VariantPlan {
  name: string;
  kind: MarginDesignVariantKind;
  threshold: number | null;
  /** 実行に使う additions。sameAs または emptyMargin のときは null（選定しない）。 */
  additions: BlockRecallAdditions[] | null;
  /** per-block 専用: 語が 1 つ以上残ったブロックだけの一覧。 */
  blocksWithTerms?: BlockRecallAdditions[];
  sameAs: string | null;
  emptyMargin: boolean;
  keptTerms: KeptTerm[];
  droppedTerms: KeptTerm[];
}

/** ブロック順・語順を保った比較キー（0 語のブロックは無視。buildBroadenedFormula の挙動と一致させる）。 */
function additionsKey(additions: readonly BlockRecallAdditions[]): string {
  return JSON.stringify(additions.filter((block) => block.additions.length > 0)
    .map((block) => ({ blockId: block.blockId, terms: block.additions.map((item) => item.term) })));
}

/**
 * full・cutoff-<N>（昇順）・per-block の案を組み立てる（純粋関数。通信しない）。
 * cutoff は「既に計算した案（full または先に処理した小さい N の cutoff）と残った語集合が同一」なら
 * sameAs を記録して選定を再実行しない。空集合どうしの一致も同じ規則で扱うため、最初に 0 語になった
 * cutoff だけが emptyMargin を持ち、以降の同じ空集合の cutoff はそれへの sameAs になる。
 */
export function planMarginDesignVariants(additions: readonly BlockRecallAdditions[], lookup: Map<string, number>,
  thresholds: readonly number[]): Map<string, VariantPlan> {
  const plans = new Map<string, VariantPlan>();
  const allTerms: KeptTerm[] = additions.flatMap((block) => block.additions.map((item) =>
    ({ blockId: block.blockId, term: item.term, count: lookupCount(lookup, block.blockId, item.term) })));
  plans.set('full', { name: 'full', kind: 'full', threshold: null, additions: additions as BlockRecallAdditions[],
    sameAs: null, emptyMargin: false, keptTerms: allTerms, droppedTerms: [] });
  const chain: { name: string; key: string }[] = [{ name: 'full', key: additionsKey(additions) }];
  for (const threshold of thresholds) {
    const name = `cutoff-${threshold}`;
    const filtered = additions
      .map((block) => ({ blockId: block.blockId, additions: block.additions.filter((item) => lookupCount(lookup, block.blockId, item.term) <= threshold) }))
      .filter((block) => block.additions.length > 0);
    const keptKeys = new Set(filtered.flatMap((block) => block.additions.map((item) => `${block.blockId} ${item.term}`)));
    const keptTerms = allTerms.filter((term) => keptKeys.has(`${term.blockId} ${term.term}`));
    const droppedTerms = allTerms.filter((term) => !keptKeys.has(`${term.blockId} ${term.term}`));
    const key = additionsKey(filtered);
    const match = chain.find((entry) => entry.key === key);
    if (match) {
      plans.set(name, { name, kind: 'cutoff', threshold, additions: null, sameAs: match.name, emptyMargin: false, keptTerms, droppedTerms });
    } else if (keptTerms.length === 0) {
      plans.set(name, { name, kind: 'cutoff', threshold, additions: null, sameAs: null, emptyMargin: true, keptTerms: [], droppedTerms: allTerms });
      chain.push({ name, key });
    } else {
      plans.set(name, { name, kind: 'cutoff', threshold, additions: filtered, sameAs: null, emptyMargin: false, keptTerms, droppedTerms });
      chain.push({ name, key });
    }
  }
  const blocksWithTerms = additions.filter((block) => block.additions.length > 0);
  plans.set('per-block', blocksWithTerms.length <= 1
    ? { name: 'per-block', kind: 'per-block', threshold: null, additions: null, sameAs: 'full', emptyMargin: false, keptTerms: allTerms, droppedTerms: [] }
    : { name: 'per-block', kind: 'per-block', threshold: null, additions: null, sameAs: null, emptyMargin: false,
      keptTerms: allTerms, droppedTerms: [], blocksWithTerms });
  return plans;
}

// ---------------------------------------------------------------------------
// per-block 専用の取得（製品に経路が無いため、ここだけハーネス内で組み立てる）
// ---------------------------------------------------------------------------

export interface SubMarginInfo { blockId: string; marginQuery: string; count: number; retrievedPmids: string[] }

function buildBlockMarginQuery(c0: C0Artifact, block: BlockRecallAdditions, originalQuery: string): string {
  return buildMarginQuery(expandFormula(buildBroadenedFormula(c0.formula, [block])).trim(), originalQuery);
}

export interface PerBlockConfig { retmax: number; skillCandidateLimit: number; sort: 'relevance' }

export interface PerBlockResult {
  stages: OutsideSearchStages & { subMargins: SubMarginInfo[] };
  candidates: { pmid: string; reason: string }[];
  subMargins: SubMarginInfo[];
}

/** 取得枠 total をブロック数 n に均等配分する。余りは先頭のブロックから 1 件ずつ配る。 */
export function allocatePerBlockRetmax(blockCount: number, total: number): number[] {
  const base = Math.floor(total / blockCount);
  const remainder = total % blockCount;
  return Array.from({ length: blockCount }, (_, index) => base + (index < remainder ? 1 : 0));
}

/** 複数の取得順リストを、リストの並び順のラウンドロビンで重複を除いて 1 列にする（先着優先）。 */
export function interleaveRoundRobin(lists: readonly (readonly string[])[]): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  const depth = Math.max(0, ...lists.map((list) => list.length));
  for (let index = 0; index < depth; index++) {
    for (const list of lists) {
      const pmid = list[index];
      if (pmid !== undefined && !seen.has(pmid)) { seen.add(pmid); merged.push(pmid); }
    }
  }
  return merged;
}

/**
 * per-block 取得（製品の searchOutsideCandidates とは経路が別。違いは取得段階だけ）:
 * ブロックごとに取得枠を均等配分（余りは先頭のブロックから 1 件ずつ）→ ブロック順のラウンドロビンで
 * 重複を除いて並べる → 既知除外・書誌上限・efetch・pickBoundaryCases（1 回だけ）。
 */
export async function runPerBlockVariant(c0: C0Artifact, blocksWithTerms: BlockRecallAdditions[], existingPmids: ReadonlySet<string>,
  protocol: { researchQuestion: string; inclusionCriteria: string; exclusionCriteria: string }, originalQuery: string,
  cfg: PerBlockConfig, deps: { eutils: EutilsDeps; llmFactory: LlmProviderFactory; progress: (event: unknown) => void }): Promise<PerBlockResult> {
  const allocations = allocatePerBlockRetmax(blocksWithTerms.length, cfg.retmax);
  const subMargins: SubMarginInfo[] = [];
  for (const [index, block] of blocksWithTerms.entries()) {
    const allocation = allocations[index]!;
    const marginQuery = buildBlockMarginQuery(c0, block, originalQuery);
    deps.progress({ perBlockEsearch: { blockId: block.blockId, allocation } });
    const result = await esearch(marginQuery, deps.eutils, { retmax: allocation, sort: cfg.sort });
    subMargins.push({ blockId: block.blockId, marginQuery, count: result.count, retrievedPmids: [...result.pmids] });
  }
  const retrievedPmids = interleaveRoundRobin(subMargins.map((sub) => sub.retrievedPmids));
  const novelPmids = retrievedPmids.filter((pmid) => !existingPmids.has(pmid));
  const requestedPmids = novelPmids.slice(0, cfg.skillCandidateLimit);
  let fetchedPmids: string[] = [];
  let candidates: BoundaryCandidate[] = [];
  let picks: { pmid: string; reason: string }[] = [];
  if (requestedPmids.length > 0) {
    deps.progress({ step: 'efetch' });
    const articles = await efetchArticles(requestedPmids, deps.eutils);
    const articleMap = new Map(articles.map((article) => [article.pmid, article]));
    candidates = requestedPmids
      .map((pmid) => { const article = articleMap.get(pmid); return article ? { pmid: article.pmid, title: article.title, year: article.year, meshHeadings: article.meshHeadings } : null; })
      .filter((value): value is BoundaryCandidate => value !== null);
    fetchedPmids = candidates.map((candidate) => candidate.pmid);
    if (fetchedPmids.length > 0) {
      deps.progress({ step: 'pick-boundary' });
      picks = await pickBoundaryCases({ researchQuestion: protocol.researchQuestion, inclusionCriteria: protocol.inclusionCriteria,
        exclusionCriteria: protocol.exclusionCriteria, candidates }, deps.llmFactory.forPurpose('pick_boundary'));
    }
  }
  const stages: OutsideSearchStages & { subMargins: SubMarginInfo[] } = { broadenedQuery: null, marginQuery: null,
    retrievedPmids, novelPmids, requestedPmids, fetchedPmids, pickedPmids: picks.map((pick) => pick.pmid), subMargins };
  return { stages, candidates: picks, subMargins };
}

// ---------------------------------------------------------------------------
// 段階 3: 事後集計（gold を使う。選定後のみ）
// ---------------------------------------------------------------------------

export interface MarginDesignStudyStage extends StudyStage { deepRankBlockId: string | null }

interface PostHocContext {
  heldOutStudies: { studyId: string; pmids: string[] }[];
  inCurrent: string[];
}

/** outsideStages の executeOutsideStages と同じ手順。案に依存しないので一度だけ計算して全案で共有する。 */
async function buildPostHocContext(fixture: BenchCase, seeds: FrozenSeeds, c0: C0Artifact, eutils: EutilsDeps): Promise<PostHocContext> {
  const allPmids = [...new Set(fixture.gold.flatMap((group) => group.pmids))];
  const inDate = await capturedGold('', allPmids, eutils);
  const groups = fixture.gold.map((group) => ({ ...group, pmids: group.pmids.filter((pmid) => inDate.includes(pmid)),
    members: group.members.map((study) => ({ ...study, pmids: study.pmids.filter((pmid) => inDate.includes(pmid)) }))
      .filter((study) => study.pmids.length > 0) })).filter((group) => group.pmids.length > 0);
  if (seeds.selections.some((seed) => !inDate.includes(seed.pmid))) throw new Error('凍結済みシードが検索日範囲外です。自動で差し替えません');
  const heldOut = new Set(computeHeldOut(groups, seeds));
  const studies = groups.filter((group) => heldOut.has(group.id)).flatMap((group) => group.members);
  const heldOutPmids = [...new Set(studies.flatMap((study) => study.pmids))];
  const inCurrent = await capturedGold(expandFormula(c0.formula).trim(), heldOutPmids, eutils);
  return { heldOutStudies: studies, inCurrent };
}

function emptyStageCounts(): Record<OutsideStage, number> {
  return Object.fromEntries(STAGE_NAMES.map((stage) => [stage, 0])) as Record<OutsideStage, number>;
}

interface PostHocOutcome { heldOutStages: MarginDesignStudyStage[]; stageCounts: Record<OutsideStage, number>; missedHeldOutCount: number }

/** margin が数学的に空（additions=[] → 拡張式が現式と同一 → `(A) NOT (A)`）と分かっている案は通信しない。 */
function classifyWithoutMargin(ctx: PostHocContext, stages: OutsideSearchStages): PostHocOutcome {
  const stageCounts = emptyStageCounts();
  const heldOutStages: MarginDesignStudyStage[] = [];
  for (const study of ctx.heldOutStudies) {
    const classified = classifyStudy(study, ctx.inCurrent, [], stages, null);
    heldOutStages.push({ ...classified, deepRankBlockId: null });
    stageCounts[classified.stage]++;
  }
  return { heldOutStages, stageCounts, missedHeldOutCount: ctx.heldOutStudies.length - stageCounts.captured_by_current };
}

async function postHocSingleMargin(marginQuery: string, ctx: PostHocContext, rankDepth: number, sort: 'relevance',
  eutils: EutilsDeps, stages: OutsideSearchStages): Promise<PostHocOutcome> {
  const heldOutPmids = [...new Set(ctx.heldOutStudies.flatMap((study) => study.pmids))];
  const inMargin = await capturedGold(marginQuery, heldOutPmids, eutils);
  const deepPmids = rankDepth === 0 ? null : (await esearch(marginQuery, eutils, { retmax: rankDepth, sort })).pmids;
  const stageCounts = emptyStageCounts();
  const heldOutStages: MarginDesignStudyStage[] = [];
  for (const study of ctx.heldOutStudies) {
    const classified = classifyStudy(study, ctx.inCurrent, inMargin, stages, deepPmids);
    heldOutStages.push({ ...classified, deepRankBlockId: null });
    stageCounts[classified.stage]++;
  }
  return { heldOutStages, stageCounts, missedHeldOutCount: ctx.heldOutStudies.length - stageCounts.captured_by_current };
}

function bestBlockRank(study: { pmids: string[] }, deepByBlock: readonly { blockId: string; pmids: string[] }[]): { rank: number | null; blockId: string | null } {
  let best: { rank: number; blockId: string } | null = null;
  for (const block of deepByBlock) {
    const index = block.pmids.findIndex((pmid) => study.pmids.includes(pmid));
    if (index < 0) continue;
    if (best === null || index + 1 < best.rank) best = { rank: index + 1, blockId: block.blockId };
  }
  return best ? { rank: best.rank, blockId: best.blockId } : { rank: null, blockId: null };
}

/** inMargin はブロック別 margin クエリそれぞれの capturedGold の和集合。deepRank は研究ごとの最良（最小）順位。 */
async function postHocPerBlock(subMargins: readonly SubMarginInfo[], ctx: PostHocContext, rankDepth: number, sort: 'relevance',
  eutils: EutilsDeps, stages: OutsideSearchStages): Promise<PostHocOutcome> {
  const heldOutPmids = [...new Set(ctx.heldOutStudies.flatMap((study) => study.pmids))];
  const inMargin = new Set<string>();
  for (const sub of subMargins) for (const pmid of await capturedGold(sub.marginQuery, heldOutPmids, eutils)) inMargin.add(pmid);
  const deepByBlock: { blockId: string; pmids: string[] }[] = [];
  if (rankDepth > 0) {
    for (const sub of subMargins) deepByBlock.push({ blockId: sub.blockId, pmids: (await esearch(sub.marginQuery, eutils, { retmax: rankDepth, sort })).pmids });
  }
  const stageCounts = emptyStageCounts();
  const heldOutStages: MarginDesignStudyStage[] = [];
  for (const study of ctx.heldOutStudies) {
    const classified = classifyStudy(study, ctx.inCurrent, [...inMargin], stages, null);
    const best = rankDepth > 0 ? bestBlockRank(study, deepByBlock) : { rank: null, blockId: null };
    heldOutStages.push({ ...classified, deepRank: best.rank, deepRankBlockId: best.blockId });
    stageCounts[classified.stage]++;
  }
  return { heldOutStages, stageCounts, missedHeldOutCount: ctx.heldOutStudies.length - stageCounts.captured_by_current };
}

/** 案に依存しない語ごとの捕捉表。現式で未捕捉の held-out 研究についてのみ、各語の margin クエリで捕捉を見る診断。 */
async function writeTermCaptureTable(dir: string, termCounts: Map<string, TermCountRecord>, ctx: PostHocContext, eutils: EutilsDeps): Promise<void> {
  const missedStudies = ctx.heldOutStudies.filter((study) => !study.pmids.some((pmid) => ctx.inCurrent.includes(pmid)));
  const missedPmids = [...new Set(missedStudies.flatMap((study) => study.pmids))];
  const rows: { term: string; blockId: string; count: number; capturedStudyIds: string[] }[] = [];
  if (missedPmids.length > 0) {
    for (const record of termCounts.values()) {
      const captured = await capturedGold(record.marginQuery, missedPmids, eutils);
      rows.push({ term: record.term, blockId: record.blockId, count: record.count,
        capturedStudyIds: missedStudies.filter((study) => study.pmids.some((pmid) => captured.includes(pmid))).map((study) => study.studyId) });
    }
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'term-capture.json'), JSON.stringify(rows, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// 保存形式・出力先
// ---------------------------------------------------------------------------

export interface MarginDesignVariantRun {
  status: 'completed' | 'failed';
  error: string | null;
  runId: string;
  caseId: string;
  margin: { name: string; sha256: string };
  c0: { name: string; sha256: string };
  seedSplit: string;
  variant: string;
  threshold: number | null;
  label: string | null;
  searchDate: string;
  model: string;
  gitCommit: string | null;
  gitDirty: boolean | null;
  sameAs: string | null;
  emptyMargin: boolean;
  keptTerms: KeptTerm[];
  droppedTerms: KeptTerm[];
  config: { retmax: number; candidateLimit: number; sort: 'relevance'; rankDepth: number };
  originalHits: number | null;
  marginHits: number | null;
  marginHitsByBlock: { blockId: string; marginQuery: string; count: number }[] | null;
  /** ブロック別件数の単純合計（重複を含む）。和集合の件数ではない。per-block 以外は null。 */
  marginHitsSumAllowingOverlap: number | null;
  stages: (OutsideSearchStages & { subMargins?: SubMarginInfo[] }) | null;
  candidates: { pmid: string; reason: string }[];
  heldOutStages: MarginDesignStudyStage[];
  missedHeldOutCount: number | null;
  stageCounts: Record<OutsideStage, number>;
  apiCalls: { ncbi: number; llm: number };
  apiElapsedMs: { ncbi: number; llm: number };
  llmUsage: LlmUsage;
  elapsedMs: number;
  llmLogs: string[];
}

export function marginDesignResultDir(resultsDir: string, caseId: string, marginName: string, seed: SeedSplit, variant: string, label?: string): string {
  return join(resultsDir, 'margin-design', caseId, marginName, seedSplitId(seed), label ? `${variant}+${label}` : variant);
}

interface Sink { apiCalls: { ncbi: number; llm: number }; apiElapsedMs: { ncbi: number; llm: number }; progress: (event: unknown) => void }

function printVariantSummary(variant: string, result: MarginDesignVariantRun): void {
  process.stdout.write(`${variant}: status=${result.status}, 語数=${result.keptTerms.length}, `
    + `margin件数=${result.marginHits ?? (result.marginHitsSumAllowingOverlap !== null ? `重複あり合計=${result.marginHitsSumAllowingOverlap}` : '-')}, `
    + `判定別研究数=${JSON.stringify(result.stageCounts)}, AI選定=${result.candidates.length}, `
    + `sameAs=${result.sameAs ?? '-'}, emptyMargin=${result.emptyMargin}${result.error ? `, error=${result.error}` : ''}\n`);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export async function main(args = process.argv.slice(2), fixturesDir = FIXTURES, resultsDir = RESULTS): Promise<void> {
  const options = parseMarginDesignArgs(args);
  const { caseId, marginName, seed, thresholds, rankDepth, dryRun } = options;
  const margin = loadMarginArtifact(fixturesDir, caseId, marginName);
  const c0 = loadC0Artifact(fixturesDir, caseId, margin.c0.name);
  if (c0.sha256 !== margin.c0.sha256) throw new Error('margin が参照する C0 のハッシュが一致しません');
  const splitId = seedSplitId(seed);
  if (c0.seedSplit !== null && c0.seedSplit !== splitId) throw new Error(`凍結 C0 のシード分割 (${c0.seedSplit}) が実行時の分割 (${splitId}) と一致しません`);
  const fixtureDir = join(fixturesDir, caseId);
  const fixture = JSON.parse(readFileSync(join(fixtureDir, 'case.json'), 'utf8')) as BenchCase;
  if (margin.searchDate !== fixture.searchDate) throw new Error('margin とケースの検索日が一致しません');
  const seeds = loadSeedsFile(fixtureDir, seed);
  validateSeeds(seeds, fixture.gold);

  const variantNames = ['full', ...thresholds.map((threshold) => `cutoff-${threshold}`), 'per-block'];
  const dirFor = (variant: string) => marginDesignResultDir(resultsDir, caseId, marginName, seed, variant, options.label);
  const gitCommit = getGitCommit();
  const skipped: string[] = [];
  const pending: string[] = [];
  for (const variant of variantNames) {
    const outPath = join(dirFor(variant), 'run.json');
    if (existsSync(outPath) && decideOutsideExisting(JSON.parse(readFileSync(outPath, 'utf8')) as MarginDesignVariantRun, gitCommit) === 'skip') {
      skipped.push(variant);
    } else {
      pending.push(variant);
    }
  }

  if (dryRun) {
    const lines = variantNames.map((variant) => `${variant} -> ${join(dirFor(variant), 'run.json')}`);
    process.stdout.write(`${caseId}: dry-run OK (margin・C0 ハッシュ照合済み、通信・書き込みなし)\n${lines.join('\n')}\n`);
    return;
  }
  for (const variant of skipped) process.stdout.write(`${variant}: 同じコミットの完了結果をスキップ -> ${join(dirFor(variant), 'run.json')}\n`);
  if (pending.length === 0) return;

  config();
  installDomParser();
  const secrets = [process.env.GEMINI_API_KEY ?? '', process.env.NCBI_API_KEY ?? ''];
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY が未設定です');

  // 案ごとの選定・margin 捕捉だけを apiCalls/progress に計上する（term-counts・事後集計の共有前処理は
  // どの案の通信でもないため計上しない）。activeSink が null の間の呼び出しは静かに数えないだけで、
  // レート制御・バックオフ・日付制限（createEvalFetch）はどの段階でも同じ eutils を通る。
  let activeSink: Sink | null = null;
  const observed = createEvalFetch(fixture.searchDate, globalThis.fetch, (event) => {
    if (!activeSink) return;
    const category = new URL(event.url).hostname === 'generativelanguage.googleapis.com' ? 'llm' : 'ncbi';
    activeSink.apiCalls[category]++;
    activeSink.apiElapsedMs[category] += event.elapsedMs;
    activeSink.progress({ api: category, ...event });
  }, secrets);
  const eutils: EutilsDeps = { fetch: observed, apiKey: process.env.NCBI_API_KEY, strictCounts: true,
    sleep: observeBackoff((ms) => activeSink?.progress({ backoff: ms })) };
  eutils.rateLimiter = observeRateLimiter(eutils, (limiter) => activeSink?.progress({ limiter }));
  const provider = new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY, fetch: observed });

  const originalQuery = expandFormula(c0.formula).trim();
  const termCounts = await countTerms(c0, margin, termCountsPath(resultsDir, caseId, marginName), eutils);
  const lookup = termCountLookup(termCounts);
  const plans = planMarginDesignVariants(margin.additions, lookup, thresholds);
  const ctx = await buildPostHocContext(fixture, seeds, c0, eutils);
  const originalHitsShared = (await esearch(originalQuery, eutils, { retmax: 0 })).count;
  const existingPmids = new Set(seeds.selections.map((selection) => selection.pmid));
  const protocol = { researchQuestion: c0.protocol.researchQuestion, inclusionCriteria: c0.protocol.inclusionCriteria,
    exclusionCriteria: c0.protocol.exclusionCriteria };

  let anyFailed = false;
  for (const variant of pending) {
    const plan = plans.get(variant)!;
    const dir = dirFor(variant);
    const outPath = join(dir, 'run.json');
    const runId = randomUUID();
    const attemptDir = join(dir, runId);
    mkdirSync(join(attemptDir, 'llm'), { recursive: true });
    const serialize = (value: unknown) => redact(JSON.stringify(value, null, 2), secrets) + '\n';
    const progress = (event: unknown) => appendFileSync(join(attemptDir, 'progress.jsonl'),
      redact(JSON.stringify({ at: new Date().toISOString(), event }), secrets) + '\n');
    const usage = createLlmUsageTracker();
    const result: MarginDesignVariantRun = { status: 'failed', error: null, runId, caseId,
      margin: { name: marginName, sha256: margin.sha256 }, c0: margin.c0, seedSplit: splitId, variant, threshold: plan.threshold,
      label: options.label ?? null, searchDate: fixture.searchDate, model: provider.model, gitCommit, gitDirty: isGitDirty(),
      sameAs: plan.sameAs, emptyMargin: plan.emptyMargin, keptTerms: plan.keptTerms, droppedTerms: plan.droppedTerms,
      config: { retmax: OUTSIDE_DEFAULT_RETMAX, candidateLimit: OUTSIDE_DEFAULT_SKILL_CANDIDATE_LIMIT, sort: OUTSIDE_DEFAULT_SORT, rankDepth },
      originalHits: null, marginHits: null, marginHitsByBlock: null, marginHitsSumAllowingOverlap: null,
      stages: null, candidates: [], heldOutStages: [], missedHeldOutCount: null, stageCounts: emptyStageCounts(),
      apiCalls: { ncbi: 0, llm: 0 }, apiElapsedMs: { ncbi: 0, llm: 0 }, llmUsage: usage.usage, elapsedMs: 0, llmLogs: [] };
    const sink: Sink = { apiCalls: result.apiCalls, apiElapsedMs: result.apiElapsedMs, progress };
    const start = Date.now();
    try {
      progress({ process: { pid: process.pid, variant, gitCommit, gitDirty: result.gitDirty, runId } });
      if (plan.sameAs !== null) {
        result.originalHits = originalHitsShared;
        result.status = 'completed';
      } else if (plan.emptyMargin) {
        result.originalHits = originalHitsShared;
        result.marginHits = 0;
        const stages: OutsideSearchStages = { broadenedQuery: null, marginQuery: null, retrievedPmids: [], novelPmids: [], requestedPmids: [], fetchedPmids: [], pickedPmids: [] };
        result.stages = stages;
        const post = classifyWithoutMargin(ctx, stages);
        result.heldOutStages = post.heldOutStages;
        result.stageCounts = post.stageCounts;
        result.missedHeldOutCount = post.missedHeldOutCount;
        result.status = 'completed';
      } else if (plan.kind === 'per-block') {
        activeSink = sink;
        const write = (path: string, value: unknown) => writeFileSync(join(attemptDir, path), serialize(value));
        const llmFactory = loggedFactory(provider, write, result.llmLogs, usage.record);
        result.originalHits = originalHitsShared;
        const perBlock = await runPerBlockVariant(c0, plan.blocksWithTerms!, existingPmids, protocol, originalQuery,
          { retmax: OUTSIDE_DEFAULT_RETMAX, skillCandidateLimit: OUTSIDE_DEFAULT_SKILL_CANDIDATE_LIMIT, sort: OUTSIDE_DEFAULT_SORT },
          { eutils, llmFactory, progress });
        result.stages = perBlock.stages;
        result.candidates = perBlock.candidates;
        result.marginHitsByBlock = perBlock.subMargins.map(({ blockId, marginQuery, count }) => ({ blockId, marginQuery, count }));
        result.marginHitsSumAllowingOverlap = perBlock.subMargins.reduce((sum, sub) => sum + sub.count, 0);
        const post = await postHocPerBlock(perBlock.subMargins, ctx, rankDepth, OUTSIDE_DEFAULT_SORT, eutils, perBlock.stages);
        result.heldOutStages = post.heldOutStages;
        result.stageCounts = post.stageCounts;
        result.missedHeldOutCount = post.missedHeldOutCount;
        result.status = 'completed';
      } else {
        activeSink = sink;
        const write = (path: string, value: unknown) => writeFileSync(join(attemptDir, path), serialize(value));
        const llmFactory = loggedFactory(provider, write, result.llmLogs, usage.record);
        const outside = await searchOutsideCandidates({ formula: c0.formula, researchQuestion: protocol.researchQuestion,
          inclusionCriteria: protocol.inclusionCriteria, exclusionCriteria: protocol.exclusionCriteria, existingPmids,
          additions: plan.additions!, retmax: OUTSIDE_DEFAULT_RETMAX, skillCandidateLimit: OUTSIDE_DEFAULT_SKILL_CANDIDATE_LIMIT,
          sort: OUTSIDE_DEFAULT_SORT, retrieval: 'head', eutils, llmFactory, onProgress: (step) => progress({ step }) });
        if (variant === 'full' && (!outside.stages || outside.stages.marginQuery !== margin.marginQuery)) {
          throw new Error('凍結した margin クエリと段階測定のクエリが一致しません');
        }
        result.originalHits = outside.originalHits;
        result.marginHits = outside.marginHits;
        result.stages = outside.stages ?? null;
        result.candidates = outside.candidates.map(({ pmid, reason }) => ({ pmid, reason }));
        if (outside.stages?.marginQuery) {
          const post = await postHocSingleMargin(outside.stages.marginQuery, ctx, rankDepth, OUTSIDE_DEFAULT_SORT, eutils, outside.stages);
          result.heldOutStages = post.heldOutStages;
          result.stageCounts = post.stageCounts;
          result.missedHeldOutCount = post.missedHeldOutCount;
        }
        result.status = 'completed';
      }
    } catch (err) {
      result.status = 'failed';
      result.error = redact(err instanceof Error ? err.message : String(err), secrets);
      anyFailed = true;
    } finally {
      activeSink = null;
      result.elapsedMs = Date.now() - start;
      progress({ status: result.status, error: result.error });
      const temporary = join(attemptDir, 'run.json.tmp');
      writeFileSync(temporary, serialize(result));
      renameSync(temporary, outPath);
    }
    printVariantSummary(variant, JSON.parse(serialize(result)) as MarginDesignVariantRun);
  }

  try {
    await writeTermCaptureTable(join(resultsDir, 'margin-design', caseId, marginName, splitId), termCounts, ctx, eutils);
  } catch (err) {
    anyFailed = true;
    process.stdout.write(`語ごとの捕捉表の作成に失敗しました: ${redact(err instanceof Error ? err.message : String(err), secrets)}\n`);
  }
  if (anyFailed) process.exitCode = 1;
}

if (require.main === module) void main().catch(reportError);
