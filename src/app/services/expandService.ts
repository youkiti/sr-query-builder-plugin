import { isSeedEligibleForValidation, type SeedPaper, type SeedUserDecision } from '@/domain/seedPaper';
import {
  buildBroadenedFormula,
  buildMarginQuery,
  getFormulaVersionById,
  type BlockRecallAdditions,
} from '@/features/formula';
import {
  expandQueryForRecall,
  pickBoundaryCases,
  pickSeedCandidates,
  type BoundaryPick,
  type BoundaryCandidate,
} from '@/features/formula/skills';
import { getProtocolByVersion } from '@/features/protocol';
import { appendSeedPaper, listSeedPapers } from '@/features/seeds';
import { expandFormula } from '@/features/validation';
import type { GoogleApiDeps } from '@/lib/google';
import { efetchArticles, esearch, type EfetchArticle, type EutilsDeps } from '@/lib/ncbi';
import { parsePubmedFormulaMd } from '@/lib/search-formula-md';
import { nowIso } from '@/utils/iso8601';
import type { AppStore } from '../store';
import type { LlmProviderFactory } from './llmProviderService';

/**
 * 対話的 seed 拡張サービス（requirements.md §4.3 の interactive フロー）。
 *
 * - fetchBoundaryCandidates: 現在の検索式を実行し、上位を efetch して
 *   pick-boundary-cases skill に渡し、境界事例候補を数件返す
 * - recordDecision: ユーザーの判定（include / exclude / maybe）を
 *   SeedPapers に source=interactive で追記する
 *
 * UI は候補を列挙して各候補に対して recordDecision を呼ぶ。
 */

/**
 * 境界事例取得（fetchBoundaryCandidates）の進捗ステップ。
 * 画面（#/expand）の進捗トラッカーが「いま何をやっているか」を可視化するために使う。
 * draft 画面と同じ思想で、各段階の開始時に onProgress で通知する。
 */
export type ExpandFetchStep =
  | 'protocol' // プロトコル（RQ・組入/除外基準）を取得
  | 'broaden' // LLM に各ブロックの拡張語（MeSH 一段上 / フリーワード）を提案させる
  | 'esearch' // 拡張式の外側（margin = 拡張式 NOT 現式）を PubMed で検索
  | 'dedup' // 既存 seed と重複する PMID を除去
  | 'efetch' // 候補論文のメタデータ（title/year/MeSH）を取得
  | 'pick-boundary'; // LLM に境界事例を選定させる

export interface ExpandServiceDeps {
  google: GoogleApiDeps;
  eutils: EutilsDeps;
  store: AppStore;
  llmFactory: LlmProviderFactory;
  /** 判定者メールアドレス（SeedPapers.decided_by に記録する）。取得できなければ null */
  userEmail?: string | null;
  /** esearch で取得する上位件数。既定 50 */
  retmax?: number;
  /** pick-boundary-cases に渡す候補件数上限。既定 20 */
  skillCandidateLimit?: number;
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

/**
 * 取得モード。
 * - `margin`: 通常。現式を緩めた拡張式の **外側**（拡張式 NOT 現式）から境界事例を拾う。
 *   有効 seed が 1 件以上あるときに使う（取りこぼし発見が目的）。
 * - `inside`: 有効 seed が 0 件のときの初期シードブートストラップ。現式の **内側**
 *   （現式ヒット集合）から「明確に該当しそうな代表例」を拾い、include で初期 seed を育てる。
 */
export type ExpandMode = 'margin' | 'inside';

export interface BoundaryCasesResult {
  /** この取得がどちらのモードで走ったか。UI のメッセージ切替に使う。 */
  mode: ExpandMode;
  candidates: BoundaryCaseView[];
  /** 現検索式のヒット数。 */
  originalHits: number;
  /** 拡張式（現式 ⊆ 拡張式）のヒット数。inside モードでは originalHits と同値。 */
  broadenedHits: number;
  /** 式の外側（margin = 拡張式 NOT 現式）のヒット数。inside モードでは 0。 */
  marginHits: number;
  /** 重複除去後に skill に渡した候補の件数 */
  evaluatedCount: number;
  /** LLM が提案した拡張語（ブロック別）。ラウンド完了時の更新提案の集計に使う。inside では []。 */
  additions: BlockRecallAdditions[];
}

/**
 * 現在の検索式から判定候補を取得するエントリ。
 *
 * 有効 seed（{@link isSeedEligibleForValidation}）の件数で 2 モードに分岐する:
 * - 1 件以上 → margin モード（式の外側から境界事例を拾い、取りこぼしを発見）
 * - 0 件   → inside モード（式の内側から代表例を拾い、初期シードをブートストラップ）
 *
 * seed が 0 件のときは捕捉率の基準が無く、式の外側を探しても include の意味が薄い。
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
    return fetchInsideCandidates(deps, protocol, originalQuery, existingPmids);
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
  };
}

/**
 * inside モード（有効 seed = 0）。現式の内側から「明確に該当しそうな代表例」を拾い、
 * 初期シード集合をブートストラップする。broaden は行わない（式は広げない）。
 */
async function fetchInsideCandidates(
  deps: ExpandServiceDeps,
  protocol: BoundaryProtocol,
  originalQuery: string,
  existingPmids: ReadonlySet<string>
): Promise<BoundaryCasesResult> {
  // 現式（内側）をそのまま検索。式は広げないので broaden ステップは踏まない。
  deps.onProgress?.('esearch');
  const insideResult = await esearch(originalQuery, deps.eutils, {
    retmax: deps.retmax ?? 50,
  });
  const originalHits = insideResult.count;

  deps.onProgress?.('dedup');
  // 既に判定済み（exclude/maybe など）の seed 行と重複する PMID は再提示しない。
  const novelPmids = insideResult.pmids.filter((p) => !existingPmids.has(p));
  const limit = deps.skillCandidateLimit ?? 20;
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
    };
  }
  deps.onProgress?.('efetch');
  const { articleMap, candidates } = await fetchCandidateArticles(toFetch, deps);

  deps.onProgress?.('pick-boundary');
  const picks = await pickSeedCandidates(
    {
      researchQuestion: protocol.researchQuestion,
      inclusionCriteria: protocol.inclusionCriteria,
      exclusionCriteria: protocol.exclusionCriteria,
      candidates,
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
  };
}

/** efetch して articleMap と pick skill 用の候補配列を組み立てる（両モード共通）。 */
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

/** 候補抽出に渡すプロトコル要素（resolveBoundaryProtocol の戻り値）。 */
interface BoundaryProtocol {
  researchQuestion: string;
  inclusionCriteria: string;
  exclusionCriteria: string;
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
  };
}
