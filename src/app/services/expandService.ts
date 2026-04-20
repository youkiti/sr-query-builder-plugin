import type { SeedPaper, SeedUserDecision } from '@/domain/seedPaper';
import {
  pickBoundaryCases,
  type BoundaryPick,
  type BoundaryCandidate,
} from '@/features/formula/skills';
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

export interface ExpandServiceDeps {
  google: GoogleApiDeps;
  eutils: EutilsDeps;
  store: AppStore;
  llmFactory: LlmProviderFactory;
  /** esearch で取得する上位件数。既定 50 */
  retmax?: number;
  /** pick-boundary-cases に渡す候補件数上限。既定 20 */
  skillCandidateLimit?: number;
  now?: () => string;
}

export interface BoundaryCaseView {
  pmid: string;
  title: string | null;
  year: number | null;
  /** skill が付けた「迷う理由」 */
  reason: string;
}

export interface BoundaryCasesResult {
  candidates: BoundaryCaseView[];
  /** esearch のヒット数（上限チェック用） */
  totalHits: number;
  /** 重複除去後に skill に渡した候補の件数 */
  evaluatedCount: number;
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
  if (state.protocolDraft === null) {
    throw new Error('protocolDraft が未設定です。プロトコル入力を先に行ってください');
  }
  if (!state.currentFormulaMarkdown) {
    throw new Error('検索式ドラフトが未生成です。先に /draft で生成してください');
  }
  const formula = parsePubmedFormulaMd(state.currentFormulaMarkdown);
  const query = expandFormula(formula).trim();
  if (query === '') {
    throw new Error('検索式の展開結果が空です');
  }

  const esearchResult = await esearch(query, deps.eutils, {
    retmax: deps.retmax ?? 50,
  });

  const seeds = await listSeedPapers(state.project.spreadsheetId, deps.google);
  const existingPmids = new Set(
    seeds.map((s) => s.pmid).filter((p): p is string => p !== null)
  );
  const novelPmids = esearchResult.pmids.filter((p) => !existingPmids.has(p));
  const limit = deps.skillCandidateLimit ?? 20;
  const toFetch = novelPmids.slice(0, limit);
  if (toFetch.length === 0) {
    return {
      candidates: [],
      totalHits: esearchResult.count,
      evaluatedCount: 0,
    };
  }
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

  const provider = deps.llmFactory.forPurpose('pick_boundary');
  const picks = await pickBoundaryCases(
    {
      researchQuestion: state.protocolDraft.researchQuestion,
      inclusionCriteria: state.protocolDraft.inclusionCriteria,
      exclusionCriteria: state.protocolDraft.exclusionCriteria,
      candidates,
    },
    provider
  );

  return {
    candidates: picksToViews(picks, articleMap),
    totalHits: esearchResult.count,
    evaluatedCount: candidates.length,
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
 * include は is_valid=true、exclude / maybe は is_valid=false（user_removed）。
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
  const isInclude = input.decision === 'include';
  const seed: SeedPaper = {
    pmid: input.pmid,
    title: input.title,
    year: input.year,
    source: 'interactive',
    ingestFormat: 'interactive',
    originalDb: null,
    isValid: isInclude,
    exclusionReason: isInclude ? null : 'user_removed',
    originalPayloadRef: null,
    userDecision: input.decision,
    decidedAt: nowFn(),
    decidedBy: null,
    note: input.reason === '' ? null : input.reason,
  };
  await appendSeedPaper(state.project.spreadsheetId, seed, deps.google);
  return { seed };
}

function picksToViews(
  picks: BoundaryPick[],
  articleMap: Map<string, { title: string | null; year: number | null }>
): BoundaryCaseView[] {
  return picks.map((pick) => {
    // pick.pmid は必ず articleMap のキーに含まれる（呼び出し側で allowedPmids でフィルタ済）
    const a = articleMap.get(pick.pmid) as { title: string | null; year: number | null };
    return {
      pmid: pick.pmid,
      title: a.title,
      year: a.year,
      reason: pick.reason,
    };
  });
}
