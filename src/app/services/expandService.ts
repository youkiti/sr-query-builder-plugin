import {
  isSeedEligibleForValidation,
  type SeedPaper,
  type SeedUserDecision,
} from '@/domain/seedPaper';
import {
  buildBroadenedFormula,
  buildMarginQuery,
  getFormulaVersionById,
  type BlockRecallAdditions,
} from '@/features/formula';
import {
  designSpecificQuery,
  expandQueryForRecall,
  pickBoundaryCases,
  pickSeedCandidates,
  SkillResponseError,
  type BoundaryPick,
  type BoundaryCandidate,
} from '@/features/formula/skills';
import { getProtocolByVersion } from '@/features/protocol';
import { appendSeedPaper, listSeedPapers } from '@/features/seeds';
import { expandFormula } from '@/features/validation';
import type { GoogleApiDeps } from '@/lib/google';
import {
  efetchArticles,
  esearch,
  EutilsError,
  type EfetchArticle,
  type EutilsDeps,
} from '@/lib/ncbi';
import { parsePubmedFormulaMd } from '@/lib/search-formula-md';
import { nowIso } from '@/utils/iso8601';
import type { AppStore } from '../store';
import type { LlmProviderFactory } from './llmProviderService';

/**
 * 対話的 seed 拡張サービス（requirements.md §4.3 の interactive フロー / §4.5 の
 * 初期シードブートストラップ）。
 *
 * - fetchBoundaryCandidates: 有効 seed の件数で margin / inside の 2 モードに分岐し、
 *   pick-boundary-cases（境界事例）または pick-seed-candidates（初期代表例）skill に
 *   候補を渡して数件返す
 * - recordDecision: ユーザーの判定（include / exclude / maybe）を
 *   SeedPapers に source=interactive で追記する
 *
 * UI は候補を列挙して各候補に対して recordDecision を呼ぶ。
 */

/**
 * 境界事例取得（fetchBoundaryCandidates）の進捗ステップ。
 * 画面（#/expand）の進捗トラッカーが「いま何をやっているか」を可視化するために使う。
 * draft 画面と同じ思想で、各段階の開始時に onProgress で通知する。
 *
 * margin / inside でステップ名を分けている（'esearch' 等を共用しない）のは、
 * #/expand の進捗トラッカーが「実行中の 1 ステップ」だけから現在のモードを判定して
 * 表示するステップ一覧を切り替える必要があるため（inside モードでは broaden を
 * 一切踏まないので、トラッカーにも出してはいけない）。
 */
export type ExpandFetchStep =
  | 'protocol' // プロトコル（RQ・組入/除外基準）を取得。モード分岐前の共通ステップ
  // --- margin モード（有効 seed ≥ 1）: 式を広げてその外側から境界事例を拾う ---
  | 'broaden' // LLM に各ブロックの拡張語（MeSH 一段上 / フリーワード）を提案させる
  | 'esearch' // 拡張式の外側（margin = 拡張式 NOT 現式）を PubMed で検索
  | 'dedup' // 既存 seed と重複する PMID を除去
  | 'efetch' // 候補論文のメタデータ（title/year/MeSH）を取得
  | 'pick-boundary' // LLM に境界事例を選定させる
  // --- inside モード（有効 seed = 0）: 式は広げず内側から初期シードを拾う ---
  | 'inside-design' // LLM に精度優先の specific 式を設計させる（insideStrategy='specific' のときだけ）
  | 'inside-esearch' // 内側（specific 式、または現式そのもの）を PubMed で検索
  | 'inside-dedup' // 既存 seed 行（判定済みも含む）と重複する PMID を除去
  | 'inside-efetch' // 候補論文のメタデータ（title/year/MeSH）を取得
  | 'pick-seed'; // LLM に初期シード代表例を選定させる

/**
 * 取得モード。
 * - `margin`: 現式を 2 軸で緩めた拡張式の **外側**（拡張式 NOT 現式）から境界事例を拾う。
 *   有効 seed が 1 件以上あるときに使う（取りこぼし発見が目的）。
 * - `inside`: 有効 seed が 0 件のときの初期シードブートストラップ。現式の **内側**
 *   （現式ヒット集合）から「明確に該当しそうな代表例」を拾い、include で初期 seed を育てる。
 */
export type ExpandMode = 'margin' | 'inside';

/**
 * inside モードで候補の母集団に使う式の選び方（issue #93）。
 * - `specific`: LLM（design-specific-query skill）に精度優先の絞り込み式を作らせ、その
 *   relevance 上位を母集団にする。現式は感度優先でヒット数が多く、その上位（最新順）から
 *   選ぶだけでは「明確に該当する論文」が母集団に入っている保証が無いため、こちらを既定にする。
 *   specific 式が作れない / 0 件 / 構文エラーのときは `current` に自動フォールバックする。
 * - `current`: 従来どおり現式そのもののヒット上位を母集団にする。
 */
export type InsideStrategy = 'specific' | 'current';

/** specific 式で検索できなかったとき、現式にフォールバックした理由。 */
export type SpecificQueryFallback =
  | 'design_failed' // LLM の応答が壊れていた / 式が空・括弧不整合
  | 'zero_hits' // specific 式のヒットが 0 件
  | 'search_failed'; // specific 式が PubMed の構文エラー等（恒久エラー）で検索できなかった

/**
 * inside モード（insideStrategy='specific'）で LLM が設計した specific 式の結果。
 * 画面に式そのものを見せて「どの式の上位から候補を選んだか」をユーザーが確認できるようにする。
 */
export interface SpecificQueryOutcome {
  /** LLM が設計した 1 行の PubMed クエリ。設計に失敗したときは null */
  query: string | null;
  /** 設計意図（日本語）。設計に失敗したときは null */
  rationale: string | null;
  /** specific 式のヒット数。設計失敗・検索失敗時は 0 */
  hits: number;
  /** 現式へフォールバックした理由。null なら specific 式の結果をそのまま使った */
  fallback: SpecificQueryFallback | null;
}

export interface ExpandServiceDeps {
  google: GoogleApiDeps;
  eutils: EutilsDeps;
  store: AppStore;
  llmFactory: LlmProviderFactory;
  /** 判定者メールアドレス（SeedPapers.decided_by に記録する）。取得できなければ null */
  userEmail?: string | null;
  /** esearch で取得する上位件数。既定 50 */
  retmax?: number;
  /**
   * pick skill に渡す候補件数上限。既定は margin / inside(current) で 20、
   * inside(specific) では relevance 上位を全部見せたいので retmax と同じ 50
   */
  skillCandidateLimit?: number;
  /**
   * inside モード（有効 seed 0 件）で母集団に使う式の選び方。既定 'specific'（issue #93）。
   * margin モードでは無視される
   */
  insideStrategy?: InsideStrategy;
  /** 任意: 各段階の開始時に呼ばれる進捗コールバック（進捗トラッカー表示用） */
  onProgress?: (step: ExpandFetchStep) => void;
  now?: () => string;
}

export interface BoundaryCaseView {
  pmid: string;
  title: string | null;
  year: number | null;
  /** skill が付けた「迷う理由」 */
  reason: string;
  /** efetch で取得したアブストラクト本文。無ければ null */
  abstract: string | null;
  /** efetch で取得した MeSH 見出し（更新提案の由来照合に使う）。 */
  meshHeadings: string[];
}

export interface BoundaryCasesResult {
  /** この取得がどちらのモードで走ったか。UI のメッセージ切替に使う。 */
  mode: ExpandMode;
  candidates: BoundaryCaseView[];
  /** 現検索式のヒット数。 */
  originalHits: number;
  /** 拡張式（現式 ⊆ 拡張式）のヒット数。= originalHits + marginHits。inside モードでは originalHits と同値。 */
  broadenedHits: number;
  /** 式の外側（margin = 拡張式 NOT 現式）のヒット数。inside モードでは常に 0。 */
  marginHits: number;
  /** 重複除去後に skill に渡した候補の件数 */
  evaluatedCount: number;
  /** LLM が提案した拡張語（ブロック別）。ラウンド完了時の更新提案の集計に使う。inside モードでは常に []。 */
  additions: BlockRecallAdditions[];
  /** inside モードで使った母集団の選び方。margin モードでは null */
  insideStrategy: InsideStrategy | null;
  /** inside モード（insideStrategy='specific'）で LLM が設計した specific 式の結果。それ以外は null */
  specific: SpecificQueryOutcome | null;
}

/** 候補抽出に渡すプロトコル要素（resolveBoundaryProtocol の戻り値）。 */
interface BoundaryProtocol {
  researchQuestion: string;
  inclusionCriteria: string;
  exclusionCriteria: string;
  /** 研究デザイン（specific 式の Publication Type 選定に渡す）。無ければ '' */
  studyDesign: string;
}

/**
 * 現在の検索式から判定候補を取得するエントリ。
 *
 * 有効 seed（{@link isSeedEligibleForValidation}）の件数で 2 モードに分岐する:
 * - 1 件以上 → margin モード（式の外側から境界事例を拾い、取りこぼしを発見）
 * - 0 件   → inside モード（式の内側から代表例を拾い、初期シードをブートストラップ）
 *
 * seed が 0 件のときは捕捉率の基準が無く、式の外側を探しても include の意味が薄い
 * （margin から拾った論文を include しても比較対象が無いので取りこぼしを検出できない）。
 * その局面では「まず確度の高い初期シードを作る」ことが先決なので、式の内側から
 * 明確に該当しそうな論文を候補に出す（include しても捕捉率は構造上 100% だが、
 * これはブートストラップとして正しい挙動）。
 */
export async function fetchBoundaryCandidates(
  deps: ExpandServiceDeps
): Promise<BoundaryCasesResult> {
  const state = deps.store.getState();
  if (state.project === null) {
    throw new Error('プロジェクトが選択されていません');
  }
  if (!state.currentFormulaMarkdown) {
    throw new Error('検索式ドラフトが未生成です。先に /draft で生成してください');
  }
  deps.onProgress?.('protocol');
  const protocol = await resolveBoundaryProtocol(deps);
  const formula = parsePubmedFormulaMd(state.currentFormulaMarkdown);
  const originalQuery = expandFormula(formula).trim();
  if (originalQuery === '') {
    throw new Error('検索式の展開結果が空です');
  }

  // 既存 seed を 1 回だけ取得し、重複除去（existingPmids）とモード判定（eligible 件数）に使う。
  const seeds = await listSeedPapers(state.project.spreadsheetId, deps.google);
  const existingPmids = new Set(
    seeds.map((s) => s.pmid).filter((p): p is string => p !== null)
  );
  const eligibleSeedCount = seeds.filter((seed) => isSeedEligibleForValidation(seed)).length;

  if (eligibleSeedCount === 0) {
    return fetchInsideCandidates(deps, protocol, formula, originalQuery, existingPmids);
  }
  return fetchMarginCandidates(deps, protocol, formula, originalQuery, existingPmids);
}

/**
 * margin モード（有効 seed ≥ 1）。現式を 2 軸で緩めた拡張式の外側から境界事例を拾う。
 */
async function fetchMarginCandidates(
  deps: ExpandServiceDeps,
  protocol: BoundaryProtocol,
  formula: ReturnType<typeof parsePubmedFormulaMd>,
  originalQuery: string,
  existingPmids: ReadonlySet<string>
): Promise<BoundaryCasesResult> {
  // 各概念ブロックを 2 軸（MeSH 一段上 / フリーワード）で広げる拡張語を LLM に提案させる。
  deps.onProgress?.('broaden');
  const conceptBlocks = formula.blocks
    .filter((b) => !b.isCombination)
    .map((b) => ({ id: b.id, expression: b.expression }));
  const additions = await expandQueryForRecall(
    { researchQuestion: protocol.researchQuestion, blocks: conceptBlocks },
    deps.llmFactory.forPurpose('expand_recall')
  );

  // 拡張式が広がらなかった（提案 0）なら margin は空。式の外側に候補なしとして早期に返す。
  if (additions.length === 0) {
    const original = await esearch(originalQuery, deps.eutils, { retmax: 0 });
    return {
      mode: 'margin',
      candidates: [],
      originalHits: original.count,
      broadenedHits: original.count,
      marginHits: 0,
      evaluatedCount: 0,
      additions: [],
      insideStrategy: null,
      specific: null,
    };
  }

  const broadenedFormula = buildBroadenedFormula(formula, additions);
  const broadenedQuery = expandFormula(broadenedFormula).trim();
  const marginQuery = buildMarginQuery(broadenedQuery, originalQuery);

  // 式の外側（margin）を検索。現式は拡張式の部分集合なので broadenedHits = originalHits + marginHits。
  deps.onProgress?.('esearch');
  const marginResult = await esearch(marginQuery, deps.eutils, {
    retmax: deps.retmax ?? 50,
  });
  const original = await esearch(originalQuery, deps.eutils, { retmax: 0 });
  const originalHits = original.count;
  const marginHits = marginResult.count;

  deps.onProgress?.('dedup');
  const novelPmids = marginResult.pmids.filter((p) => !existingPmids.has(p));
  const limit = deps.skillCandidateLimit ?? 20;
  const toFetch = novelPmids.slice(0, limit);
  if (toFetch.length === 0) {
    return {
      mode: 'margin',
      candidates: [],
      originalHits,
      broadenedHits: originalHits + marginHits,
      marginHits,
      evaluatedCount: 0,
      additions,
      insideStrategy: null,
      specific: null,
    };
  }
  deps.onProgress?.('efetch');
  const { articleMap, candidates } = await fetchCandidateArticles(toFetch, deps);

  deps.onProgress?.('pick-boundary');
  const picks = await pickBoundaryCases(
    {
      researchQuestion: protocol.researchQuestion,
      inclusionCriteria: protocol.inclusionCriteria,
      exclusionCriteria: protocol.exclusionCriteria,
      candidates,
    },
    deps.llmFactory.forPurpose('pick_boundary')
  );

  return {
    mode: 'margin',
    candidates: picksToViews(picks, articleMap),
    originalHits,
    broadenedHits: originalHits + marginHits,
    marginHits,
    evaluatedCount: candidates.length,
    additions,
    insideStrategy: null,
    specific: null,
  };
}

/**
 * inside モード（有効 seed = 0）。式の内側から「明確に該当しそうな代表例」を拾い、
 * 初期シード集合をブートストラップする。broaden は行わない（式は広げない）ので
 * expand_recall / pick_boundary は一切呼ばない。
 *
 * 母集団の式は insideStrategy で選ぶ（issue #93）:
 * - `specific`（既定）: LLM に精度優先の specific 式を設計させ、その relevance（Best Match）
 *   上位 retmax 件を母集団にする。設計失敗 / 0 件 / 構文エラーなら現式へフォールバックする
 *   （そのときも relevance 順）。フォールバックの有無と理由は result.specific に残す
 * - `current`: 従来どおり現式のヒット上位（NCBI 既定順）を母集団にする
 */
async function fetchInsideCandidates(
  deps: ExpandServiceDeps,
  protocol: BoundaryProtocol,
  formula: ReturnType<typeof parsePubmedFormulaMd>,
  originalQuery: string,
  existingPmids: ReadonlySet<string>
): Promise<BoundaryCasesResult> {
  const strategy: InsideStrategy = deps.insideStrategy ?? 'specific';
  const retmax = deps.retmax ?? 50;

  let specific: SpecificQueryOutcome | null = null;
  let poolPmids: string[] | null = null;
  if (strategy === 'specific') {
    deps.onProgress?.('inside-design');
    specific = await designInsideSpecificQuery(deps, protocol, formula);
    if (specific.query !== null) {
      deps.onProgress?.('inside-esearch');
      const searched = await searchSpecificQuery(specific.query, deps, retmax);
      if (searched.fallback !== null) {
        specific.fallback = searched.fallback;
      } else {
        specific.hits = searched.count;
        poolPmids = searched.pmids;
      }
    }
  }

  // 現式のヒット数は常に取る（ステータス表示の基準）。specific 式を母集団に使えたときは
  // 件数だけ（retmax 0）、それ以外（current / フォールバック）は母集団としても使う。
  if (poolPmids === null) {
    deps.onProgress?.('inside-esearch');
  }
  const originalResult = await esearch(originalQuery, deps.eutils, {
    retmax: poolPmids === null ? retmax : 0,
    // フォールバック時も「代表例を選ぶ」目的は同じなので relevance 順で上位を見る。
    // current 戦略は従来挙動（NCBI 既定順）を維持する
    ...(strategy === 'specific' ? { sort: 'relevance' as const } : {}),
  });
  const originalHits = originalResult.count;
  const pool = poolPmids ?? originalResult.pmids;

  deps.onProgress?.('inside-dedup');
  // 既に判定済み（exclude/maybe など）の seed 行と重複する PMID は再提示しない。
  const novelPmids = pool.filter((p) => !existingPmids.has(p));
  const limit = deps.skillCandidateLimit ?? (strategy === 'specific' ? retmax : 20);
  const toFetch = novelPmids.slice(0, limit);
  if (toFetch.length === 0) {
    return {
      mode: 'inside',
      candidates: [],
      originalHits,
      broadenedHits: originalHits,
      marginHits: 0,
      evaluatedCount: 0,
      additions: [],
      insideStrategy: strategy,
      specific,
    };
  }
  deps.onProgress?.('inside-efetch');
  const { articleMap, candidates } = await fetchCandidateArticles(toFetch, deps);

  deps.onProgress?.('pick-seed');
  const picks = await pickSeedCandidates(
    {
      researchQuestion: protocol.researchQuestion,
      inclusionCriteria: protocol.inclusionCriteria,
      exclusionCriteria: protocol.exclusionCriteria,
      candidates,
      limit: INSIDE_PICK_LIMIT,
    },
    deps.llmFactory.forPurpose('pick_seed')
  );

  return {
    mode: 'inside',
    candidates: picksToViews(picks, articleMap),
    originalHits,
    broadenedHits: originalHits,
    marginHits: 0,
    evaluatedCount: candidates.length,
    additions: [],
    insideStrategy: strategy,
    specific,
  };
}

/** inside モードで人のレビューに回す候補の上限（issue #93: 「最大 5 件を選んで human review へ」）。 */
const INSIDE_PICK_LIMIT = 5;

/**
 * design-specific-query skill を呼び、specific 式を組み立てる。応答が壊れている
 * （SkillResponseError）ときは例外にせず fallback='design_failed' の結果を返す
 * （API キー欠落・通信エラー等はそのまま伝播させ、画面のエラー表示に載せる）。
 */
async function designInsideSpecificQuery(
  deps: ExpandServiceDeps,
  protocol: BoundaryProtocol,
  formula: ReturnType<typeof parsePubmedFormulaMd>
): Promise<SpecificQueryOutcome> {
  const conceptBlocks = formula.blocks
    .filter((b) => !b.isCombination)
    .map((b) => ({ id: b.id, expression: b.expression }));
  try {
    const design = await designSpecificQuery(
      {
        researchQuestion: protocol.researchQuestion,
        inclusionCriteria: protocol.inclusionCriteria,
        exclusionCriteria: protocol.exclusionCriteria,
        studyDesign: protocol.studyDesign,
        blocks: conceptBlocks,
      },
      deps.llmFactory.forPurpose('design_specific_query')
    );
    return { query: design.query, rationale: design.rationale, hits: 0, fallback: null };
  } catch (err) {
    if (err instanceof SkillResponseError) {
      return { query: null, rationale: null, hits: 0, fallback: 'design_failed' };
    }
    throw err;
  }
}

/**
 * specific 式を relevance 順で検索する。0 件なら 'zero_hits'、PubMed の恒久エラー
 * （構文エラー・不明タグ等。LLM 生成の式では起こりうる）なら 'search_failed' を返し、
 * 呼び出し側が現式へフォールバックできるようにする。一時エラーはそのまま伝播させる。
 */
async function searchSpecificQuery(
  query: string,
  deps: ExpandServiceDeps,
  retmax: number
): Promise<{ count: number; pmids: string[]; fallback: SpecificQueryFallback | null }> {
  try {
    const result = await esearch(query, deps.eutils, { retmax, sort: 'relevance' });
    if (result.count === 0 || result.pmids.length === 0) {
      return { count: result.count, pmids: [], fallback: 'zero_hits' };
    }
    return { count: result.count, pmids: result.pmids, fallback: null };
  } catch (err) {
    if (err instanceof EutilsError && err.permanent) {
      return { count: 0, pmids: [], fallback: 'search_failed' };
    }
    throw err;
  }
}

/** efetch して articleMap と pick skill 用の候補配列を組み立てる（margin / inside 共通）。 */
async function fetchCandidateArticles(
  pmids: string[],
  deps: ExpandServiceDeps
): Promise<{ articleMap: Map<string, EfetchArticle>; candidates: BoundaryCandidate[] }> {
  const articles = await efetchArticles(pmids, deps.eutils);
  const articleMap = new Map(articles.map((a) => [a.pmid, a]));
  const candidates: BoundaryCandidate[] = pmids
    .map((pmid) => {
      const a = articleMap.get(pmid);
      if (!a) return null;
      return {
        pmid: a.pmid,
        title: a.title,
        year: a.year,
        meshHeadings: a.meshHeadings,
      };
    })
    .filter((v): v is BoundaryCandidate => v !== null);
  return { articleMap, candidates };
}

export interface RecordDecisionInput {
  pmid: string;
  title: string | null;
  year: number | null;
  decision: SeedUserDecision;
  reason: string;
}

export interface RecordDecisionResult {
  /** 実際に SeedPapers に追記した行 */
  seed: SeedPaper;
}

/**
 * 対話判定を SeedPapers に追記する。
 *
 * is_valid は「E-utilities で存在確認できたか」を表す列なので、境界事例候補は
 * すべて efetch 済み = 存在確認済みのため判定によらず is_valid=true で保存する
 * （requirements.md §4.5）。検証ロジックからの除外は user_decision 列のフィルタ
 * （isSeedEligibleForValidation が exclude / maybe を除外）で行い、is_valid を
 * 二重に落とさない。user_removed はユーザーが行を手動無効化したとき専用。
 */
export async function recordDecision(
  input: RecordDecisionInput,
  deps: ExpandServiceDeps
): Promise<RecordDecisionResult> {
  const state = deps.store.getState();
  if (state.project === null) {
    throw new Error('プロジェクトが選択されていません');
  }
  const nowFn = deps.now ?? nowIso;
  const seed: SeedPaper = {
    pmid: input.pmid,
    title: input.title,
    year: input.year,
    source: 'interactive',
    ingestFormat: 'interactive',
    originalDb: null,
    // 候補は efetch 済み = 存在確認済みなので判定によらず is_valid=true。
    isValid: true,
    exclusionReason: null,
    originalPayloadRef: null,
    userDecision: input.decision,
    decidedAt: nowFn(),
    decidedBy: deps.userEmail ?? null,
    note: input.reason === '' ? null : input.reason,
  };
  await appendSeedPaper(state.project.spreadsheetId, seed, deps.google);
  return { seed };
}

function picksToViews(
  picks: BoundaryPick[],
  articleMap: Map<string, EfetchArticle>
): BoundaryCaseView[] {
  return picks.map((pick) => {
    // pick.pmid は必ず articleMap のキーに含まれる（呼び出し側で allowedPmids でフィルタ済）
    const a = articleMap.get(pick.pmid) as EfetchArticle;
    return {
      pmid: pick.pmid,
      title: a.title,
      year: a.year,
      reason: pick.reason,
      abstract: a.abstract,
      meshHeadings: a.meshHeadings,
    };
  });
}

async function resolveBoundaryProtocol(deps: ExpandServiceDeps): Promise<BoundaryProtocol> {
  const state = deps.store.getState();
  /* istanbul ignore if -- fetchBoundaryCandidates が呼び出し前に project を検証済み */
  if (state.project === null) {
    throw new Error('プロジェクトが選択されていません');
  }
  if (state.protocolDraft !== null) {
    return {
      researchQuestion: state.protocolDraft.researchQuestion,
      inclusionCriteria: state.protocolDraft.inclusionCriteria,
      exclusionCriteria: state.protocolDraft.exclusionCriteria,
      studyDesign: state.protocolDraft.studyDesign,
    };
  }

  let protocolVersion: number | null = state.currentProtocolVersion;
  if (state.currentFormulaVersionId) {
    const version = await getFormulaVersionById(
      state.project.spreadsheetId,
      state.currentFormulaVersionId,
      deps.google
    );
    if (version !== null) {
      protocolVersion = version.protocolVersion;
    }
  }
  if (protocolVersion === null) {
    throw new Error('protocolDraft が未設定です。プロトコル入力を先に行ってください');
  }

  const protocol = await getProtocolByVersion(
    state.project.spreadsheetId,
    protocolVersion,
    deps.google
  );
  if (protocol === null) {
    throw new Error(`Protocol version ${protocolVersion} が見つかりません`);
  }
  return {
    researchQuestion: protocol.researchQuestion,
    inclusionCriteria: protocol.inclusionCriteria ?? '',
    exclusionCriteria: protocol.exclusionCriteria ?? '',
    studyDesign: protocol.studyDesign ?? '',
  };
}
