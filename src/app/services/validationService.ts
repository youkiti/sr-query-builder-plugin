import type { ValidationLogEntry } from '@/domain/validationLog';
import { isSeedEligibleForValidation } from '@/domain/seedPaper';
import { listSeedPapers } from '@/features/seeds';
import {
  aggregateMeshFrequency,
  appendValidationLog,
  buildMeshHierarchy,
  checkFinalQuery,
  checkSearchLines,
  extractMeshForSeeds,
  toMermaidFlowchart,
  type FinalQueryResult,
  type LineHitResult,
  type MeshForSeed,
  type MeshHierarchyNode,
} from '@/features/validation';
import {
  interpretResult,
  type FormulaLineInput,
  type MissedSeedAnalysis,
} from '@/features/formula/skills';
import { efetchArticles, fetchMeshTreeNumbers, type EutilsDeps } from '@/lib/ncbi';
import { ensureChildFolder, uploadTextFile, type GoogleApiDeps } from '@/lib/google';
import { parsePubmedFormulaMd } from '@/lib/search-formula-md';
import { nowIso } from '@/utils/iso8601';
import { newUuid } from '@/utils/uuid';
import type { AppStore } from '../store';
import type { LlmProviderFactory } from './llmProviderService';

/**
 * 検証サービス。requirements.md §4.6 の P0 3 機能を統一インターフェースで
 * 実行し、結果を `ValidationLog` タブに 1 行ずつ追記する。
 *
 * - `line_hits`: 行ごとヒット数
 * - `final_query`: 最終検索式のシード論文捕捉率
 * - `mesh`: seed の MeSH 記述子一覧 + 頻度
 *
 * 実行には現在の FormulaVersion と project が必要。
 */

export interface ValidationServiceDeps {
  google: GoogleApiDeps;
  eutils: EutilsDeps;
  store: AppStore;
  newUuid?: () => string;
  now?: () => string;
}

export interface ValidationSummary {
  lineHits: LineHitResult[];
  finalQuery: FinalQueryResult;
  finalQueryError: string | null;
  mesh: MeshForSeed[];
  meshFrequency: Array<{ descriptor: string; count: number }>;
  meshError: string | null;
  /** MeSH tree number 階層（Mermaid 描画用）。mesh 取得に失敗した場合は空配列 */
  meshHierarchy: MeshHierarchyNode[];
  /** `flowchart TD` 形式の Mermaid ソース。view で `<pre class="mermaid">` 等に流し込む */
  meshMermaid: string;
  /** 階層取得に失敗した場合のメッセージ（frequency は出せたが tree 取得だけ失敗 等） */
  meshHierarchyError: string | null;
  /** 検証に使用した有効 seed（検証対象から外れた seed 数も UI で伝えるため件数を保持） */
  eligibleSeedCount: number;
  totalSeedCount: number;
  /** ValidationLog に追記した行の id 一覧（実装確認用） */
  loggedValidationIds: string[];
}

/**
 * 3 検証をまとめて実行する。どれか 1 つで失敗しても残りは最後まで走らせたいので、
 * 例外は summary.lineHits[].error にまとめず、各サブ機能の結果型に閉じ込める。
 */
export async function runValidation(deps: ValidationServiceDeps): Promise<ValidationSummary> {
  const state = deps.store.getState();
  if (state.project === null) {
    throw new Error('プロジェクトが選択されていません');
  }
  if (!state.currentFormulaVersionId || !state.currentFormulaMarkdown) {
    throw new Error('検索式ドラフトが未生成です。先に /draft で生成してください');
  }
  const formula = parsePubmedFormulaMd(state.currentFormulaMarkdown);
  const seeds = await listSeedPapers(state.project.spreadsheetId, deps.google);
  const eligible = seeds.filter((seed) => isSeedEligibleForValidation(seed));
  const eligiblePmids = eligible
    .map((seed) => seed.pmid)
    .filter((pmid): pmid is string => pmid !== null);

  const lineHits = await checkSearchLines(formula, deps.eutils);

  let finalQuery = buildEmptyFinalQuery();
  let finalQueryError: string | null = null;
  try {
    finalQuery = await checkFinalQuery(formula, eligiblePmids, deps.eutils);
  } catch (err) {
    finalQueryError = formatError(err);
  }

  let mesh: MeshForSeed[] = [];
  let meshFrequency: Array<{ descriptor: string; count: number }> = [];
  let meshError: string | null = null;
  try {
    mesh = await extractMeshForSeeds(eligiblePmids, deps.eutils);
    meshFrequency = aggregateMeshFrequency(mesh);
  } catch (err) {
    meshError = formatError(err);
  }

  // MeSH 階層可視化（requirements.md §4.6）: descriptor → tree numbers を取って
  // Mermaid flowchart ソースに変換する。tree 取得だけ失敗した場合も meshFrequency は
  // 返したいので、別チャネルのエラーとして記録する。
  let meshHierarchy: MeshHierarchyNode[] = [];
  let meshMermaid: string = toMermaidFlowchart([]);
  let meshHierarchyError: string | null = null;
  if (meshError === null && meshFrequency.length > 0) {
    try {
      const treeMap = await fetchMeshTreeNumbers(
        meshFrequency.map((entry) => entry.descriptor),
        deps.eutils
      );
      meshHierarchy = buildMeshHierarchy(treeMap);
      meshMermaid = toMermaidFlowchart(meshHierarchy);
    } catch (err) {
      meshHierarchyError = formatError(err);
    }
  }

  const uuidFn = deps.newUuid ?? newUuid;
  const nowFn = deps.now ?? nowIso;
  const loggedValidationIds: string[] = [];
  const version = state.currentFormulaVersionId;

  // 行ごと内訳を Drive に 1 ファイル保存し、全 ValidationLog 行の detail_ref に紐づける
  // （requirements.md §3.1 / §3.3）。アップロードに失敗しても検証は止めず detail_ref=null で続行。
  const detailRef = await uploadValidationDetail(
    {
      driveFolderId: state.project.driveFolderId,
      validationId: uuidFn(),
      versionId: version,
      executedAt: nowFn(),
      lineHits,
      finalQuery,
      finalQueryError,
      meshFrequency,
      meshError,
    },
    deps.google
  );

  const logEntry = async (entry: Omit<ValidationLogEntry, 'validationId' | 'versionId' | 'executedAt'>): Promise<void> => {
    const full: ValidationLogEntry = {
      validationId: uuidFn(),
      versionId: version,
      ...entry,
      executedAt: nowFn(),
    };
    await appendValidationLog(state.project!.spreadsheetId, full, deps.google);
    loggedValidationIds.push(full.validationId);
  };

  // line_hits は行ごと 1 行ずつ記録する（既存の UI 仕様に合わせる）
  for (const line of lineHits) {
    await logEntry({
      checkType: 'line_hits',
      totalHits: line.error === null ? line.hitCount : null,
      captureRate: null,
      capturedPmids: null,
      missedPmids: null,
      detailRef,
    });
  }

  await logEntry({
    checkType: 'final_query',
    totalHits: finalQueryError === null ? finalQuery.totalHits : null,
    captureRate: finalQueryError === null ? finalQuery.captureRate : null,
    capturedPmids: finalQueryError === null ? finalQuery.capturedPmids.join(',') : null,
    missedPmids: finalQueryError === null ? finalQuery.missedPmids.join(',') : null,
    detailRef,
  });

  await logEntry({
    checkType: 'mesh',
    totalHits: null,
    captureRate: null,
    capturedPmids: null,
    missedPmids: null,
    detailRef,
  });

  return {
    lineHits,
    finalQuery,
    finalQueryError,
    mesh,
    meshFrequency,
    meshError,
    meshHierarchy,
    meshMermaid,
    meshHierarchyError,
    eligibleSeedCount: eligible.length,
    totalSeedCount: seeds.length,
    loggedValidationIds,
  };
}

/**
 * 漏れ PMID 原因分析サービス（requirements.md §4.6）の依存。
 * runValidation とは別に、ユーザー操作（validate 画面のボタン）起点で呼ばれる。
 */
export interface AnalyzeMissedSeedsDeps {
  eutils: EutilsDeps;
  store: AppStore;
  /** interpret-result skill 呼び出しに使う LLM プロバイダファクトリ */
  llmFactory: LlmProviderFactory;
  /** 検証で得た未捕捉 PMID 一覧 */
  missedPmids: string[];
}

export interface AnalyzeMissedSeedsResult {
  analyses: MissedSeedAnalysis[];
  /** 書誌取得（efetch）に失敗した PMID 一覧（分析対象から落ちたもの） */
  fetchedPmids: string[];
}

/**
 * シード捕捉率検証で漏れた PMID について、原因と改善候補語を AI に推定させる。
 *
 * 1. efetch で漏れ PMID の書誌（title / abstract / MeSH）を取得
 * 2. 現在の検索式の行（blockId + expression）と合わせて interpret-result skill を実行
 * 3. PMID ごとの原因分析を返す
 *
 * LLM 呼び出しは llmFactory.forPurpose('interpret_result') 経由で、apiLogger が
 * LLMApiLog + Drive に記録する（draftService の forPurpose 使用例と同じ配線）。
 *
 * @throws missedPmids が空のときは呼び出し側のバグなので明示的なエラー
 * @throws LlmApiKeyMissingError（factory 生成側）は呼び出し側で案内する
 */
export async function analyzeMissedSeeds(
  deps: AnalyzeMissedSeedsDeps
): Promise<AnalyzeMissedSeedsResult> {
  const state = deps.store.getState();
  if (!state.currentFormulaMarkdown) {
    throw new Error('検索式ドラフトが未生成です。先に /draft で生成してください');
  }
  if (deps.missedPmids.length === 0) {
    throw new Error('漏れ PMID がありません');
  }

  const formula = parsePubmedFormulaMd(state.currentFormulaMarkdown);
  const lines: FormulaLineInput[] = formula.blocks.map((block) => ({
    blockId: block.id,
    expression: block.expression,
  }));

  const articles = await efetchArticles(deps.missedPmids, deps.eutils);
  const missedArticles = articles.map((article) => ({
    pmid: article.pmid,
    title: article.title,
    abstract: article.abstract,
    meshHeadings: article.meshHeadings,
  }));

  if (missedArticles.length === 0) {
    return { analyses: [], fetchedPmids: [] };
  }

  const analyses = await interpretResult(
    {
      finalQuery: state.currentFormulaMarkdown,
      lines,
      missedArticles,
    },
    deps.llmFactory.forPurpose('interpret_result')
  );

  return { analyses, fetchedPmids: missedArticles.map((a) => a.pmid) };
}

function buildEmptyFinalQuery(): FinalQueryResult {
  return {
    finalQuery: '',
    totalHits: 0,
    captureRate: 0,
    capturedPmids: [],
    missedPmids: [],
  };
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface ValidationDetailInput {
  driveFolderId: string;
  validationId: string;
  versionId: string;
  executedAt: string;
  lineHits: LineHitResult[];
  finalQuery: FinalQueryResult;
  finalQueryError: string | null;
  meshFrequency: Array<{ descriptor: string; count: number }>;
  meshError: string | null;
}

/**
 * 検証ランの行ごと内訳を JSON 1 ファイルにまとめ、Drive の
 * `{drive_folder_id}/logs/validation/{validation_id}.json` に保存して webViewLink を返す。
 * これを全 ValidationLog 行の detail_ref に紐づけることで、後から行ごとの件数や
 * 捕捉/未捕捉 PMID を監査できるようにする（requirements.md §3.1 / §3.3）。
 *
 * アップロードに失敗しても検証自体は失敗させず、null を返して detail_ref=null で続行する。
 */
async function uploadValidationDetail(
  input: ValidationDetailInput,
  google: GoogleApiDeps
): Promise<string | null> {
  try {
    const logsFolder = await ensureChildFolder('logs', input.driveFolderId, google);
    const validationFolder = await ensureChildFolder('validation', logsFolder.id, google);
    const detail = {
      validation_id: input.validationId,
      version_id: input.versionId,
      executed_at: input.executedAt,
      line_hits: input.lineHits.map((line) => ({
        block_id: line.blockId,
        expression: line.expression,
        expanded_query: line.expandedQuery,
        hit_count: line.error === null ? line.hitCount : null,
        error: line.error,
      })),
      final_query:
        input.finalQueryError === null
          ? {
              final_query: input.finalQuery.finalQuery,
              total_hits: input.finalQuery.totalHits,
              capture_rate: input.finalQuery.captureRate,
              captured_pmids: input.finalQuery.capturedPmids,
              missed_pmids: input.finalQuery.missedPmids,
            }
          : { error: input.finalQueryError },
      mesh:
        input.meshError === null
          ? { frequency: input.meshFrequency }
          : { error: input.meshError },
    };
    const file = await uploadTextFile(
      {
        name: `${input.validationId}.json`,
        content: JSON.stringify(detail, null, 2),
        parentId: validationFolder.id,
        mimeType: 'application/json',
      },
      google
    );
    return file.webViewLink ?? null;
  } catch (err) {
    console.warn('[validation] 行ごと内訳の Drive 保存に失敗したため detail_ref=null で続行します', err);
    return null;
  }
}
