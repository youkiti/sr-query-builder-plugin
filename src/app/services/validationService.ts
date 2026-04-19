import type { ValidationLogEntry } from '@/domain/validationLog';
import { isSeedEligibleForValidation } from '@/domain/seedPaper';
import { listSeedPapers } from '@/features/seeds';
import {
  aggregateMeshFrequency,
  appendValidationLog,
  checkFinalQuery,
  checkSearchLines,
  extractMeshForSeeds,
  type FinalQueryResult,
  type LineHitResult,
  type MeshForSeed,
} from '@/features/validation';
import type { EutilsDeps } from '@/lib/ncbi';
import type { GoogleApiDeps } from '@/lib/google';
import { parsePubmedFormulaMd } from '@/lib/search-formula-md';
import { nowIso } from '@/utils/iso8601';
import { newUuid } from '@/utils/uuid';
import type { AppStore } from '../store';

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

  const uuidFn = deps.newUuid ?? newUuid;
  const nowFn = deps.now ?? nowIso;
  const loggedValidationIds: string[] = [];
  const version = state.currentFormulaVersionId;

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
      detailRef: null,
    });
  }

  await logEntry({
    checkType: 'final_query',
    totalHits: finalQueryError === null ? finalQuery.totalHits : null,
    captureRate: finalQueryError === null ? finalQuery.captureRate : null,
    capturedPmids: finalQueryError === null ? finalQuery.capturedPmids.join(',') : null,
    missedPmids: finalQueryError === null ? finalQuery.missedPmids.join(',') : null,
    detailRef: null,
  });

  await logEntry({
    checkType: 'mesh',
    totalHits: null,
    captureRate: null,
    capturedPmids: null,
    missedPmids: null,
    detailRef: null,
  });

  return {
    lineHits,
    finalQuery,
    finalQueryError,
    mesh,
    meshFrequency,
    meshError,
    eligibleSeedCount: eligible.length,
    totalSeedCount: seeds.length,
    loggedValidationIds,
  };
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
