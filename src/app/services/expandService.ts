import type { SeedPaper, SeedUserDecision } from '@/domain/seedPaper';
import {
  buildBroadenedFormula,
  buildMarginQuery,
  getFormulaVersionById,
  type BlockRecallAdditions,
} from '@/features/formula';
import {
  expandQueryForRecall,
  pickBoundaryCases,
  type BoundaryPick,
  type BoundaryCandidate,
} from '@/features/formula/skills';
import { getProtocolByVersion } from '@/features/protocol';
import { appendSeedPaper, listSeedPapers } from '@/features/seeds';
import { expandFormula } from '@/features/validation';
import type { GoogleApiDeps } from '@/lib/google';
import { efetchArticles, esearch, type EutilsDeps } from '@/lib/ncbi';
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

export interface BoundaryCasesResult {
  candidates: BoundaryCaseView[];
  /** 現検索式のヒット数。 */
  originalHits: number;
  /** 拡張式（現式 ⊆ 拡張式）のヒット数。= originalHits + marginHits。 */
  broadenedHits: number;
  /** 式の外側（margin = 拡張式 NOT 現式）のヒット数。 */
  marginHits: number;
  /** 重複除去後に skill に渡した候補の件数 */
  evaluatedCount: number;
  /** LLM が提案した拡張語（ブロック別）。ラウンド完了時の更新提案の集計に使う。 */
  additions: BlockRecallAdditions[];
}

/**
 * 現在の検索式で PubMed を検索し、既存 seed と重複しない上位候補を
 * pick-boundary-cases skill に渡して境界事例を抽出する。
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
  const seeds = await listSeedPapers(state.project.spreadsheetId, deps.google);
  const existingPmids = new Set(
    seeds.map((s) => s.pmid).filter((p): p is string => p !== null)
  );
  const novelPmids = marginResult.pmids.filter((p) => !existingPmids.has(p));
  const limit = deps.skillCandidateLimit ?? 20;
  const toFetch = novelPmids.slice(0, limit);
  if (toFetch.length === 0) {
    return {
      candidates: [],
      originalHits,
      broadenedHits: originalHits + marginHits,
      marginHits,
      evaluatedCount: 0,
      additions,
    };
  }
  deps.onProgress?.('efetch');
  const articles = await efetchArticles(toFetch, deps.eutils);
  const articleMap = new Map(articles.map((a) => [a.pmid, a]));
  const candidates: BoundaryCandidate[] = toFetch
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

  deps.onProgress?.('pick-boundary');
  const provider = deps.llmFactory.forPurpose('pick_boundary');
  const picks = await pickBoundaryCases(
    {
      researchQuestion: protocol.researchQuestion,
      inclusionCriteria: protocol.inclusionCriteria,
      exclusionCriteria: protocol.exclusionCriteria,
      candidates,
    },
    provider
  );

  return {
    candidates: picksToViews(picks, articleMap),
    originalHits,
    broadenedHits: originalHits + marginHits,
    marginHits,
    evaluatedCount: candidates.length,
    additions,
  };
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
  articleMap: Map<
    string,
    { title: string | null; year: number | null; abstract: string | null; meshHeadings: string[] }
  >
): BoundaryCaseView[] {
  return picks.map((pick) => {
    // pick.pmid は必ず articleMap のキーに含まれる（呼び出し側で allowedPmids でフィルタ済）
    const a = articleMap.get(pick.pmid) as {
      title: string | null;
      year: number | null;
      abstract: string | null;
      meshHeadings: string[];
    };
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

async function resolveBoundaryProtocol(
  deps: ExpandServiceDeps
): Promise<{
  researchQuestion: string;
  inclusionCriteria: string;
  exclusionCriteria: string;
}> {
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
