import type { ProjectStoreDeps } from '@/features/project';
import type { OptimizationTrial, PreviousOptimizationRejection } from '@/features/formula/skills/optimizeQuery';
import type { PubmedFormula } from '@/lib/search-formula-md';
import { nowIso } from '@/utils/iso8601';
import type { OptimizationStopReason, QueryOptimizationResult } from './queryOptimizationService';
import type { OptimizationReviewSection } from './queryOptimizationReviewSections';
import type { BlocksDraft, ProtocolDraft } from '../store';

const CHECKPOINT_KEY = 'queryOptimizationCheckpoint';

export interface OptimizationBudget {
  apiCalls: number;
  elapsedMs: number;
  evaluatedTrials: number;
}

export interface OptimizationResumeData {
  bestFormula: PubmedFormula | null;
  inputIdentity: string;
  /** 再開を重ねても元の上限と累積消費量を保持する。 */
  limits: OptimizationBudget;
  consumed: OptimizationBudget;
  previousRejectedTrials: PreviousOptimizationRejection[];
  resumedFromRunId?: string;
}

/** キー順を固定し、集合だけをソートする。現在式・書誌・出典メタデータは含めない。 */
export function createQueryOptimizationInputIdentity(
  protocol: ProtocolDraft, blocks: BlocksDraft, seedPmids: readonly string[], maxHits: number
): string {
  const normalize = (value: string) => value.replace(/\r\n?/g, '\n').trim();
  return JSON.stringify({
    criteria: [protocol.frameworkType, protocol.researchQuestion, protocol.inclusionCriteria,
      protocol.exclusionCriteria, protocol.studyDesign].map(normalize),
    blocks: blocks.blocks.map((block) => [block.blockLabel, block.description, block.note].map(normalize)),
    combinationExpression: normalize(blocks.combinationExpression),
    selectedFilterIds: blocks.selectedFilterIds ? [...new Set(blocks.selectedFilterIds)].sort() : null,
    seedPmids: [...new Set(seedPmids.map(normalize))].sort(), maxHits,
  });
}

export type OptimizationResumeAvailability =
  | { available: true; remaining: OptimizationBudget; data: OptimizationResumeData }
  | { available: false; reason: string };

export function getQueryOptimizationResumeAvailability(
  checkpoint: QueryOptimizationCheckpoint, inputIdentity: string | null
): OptimizationResumeAvailability {
  if (checkpoint.completion) return { available: false, reason: 'この実行は終了しています。' };
  const data = checkpoint.resume;
  if (!data?.bestFormula || !data.inputIdentity || !data.limits || !data.consumed) {
    return { available: false, reason: '再開に必要な最良候補・入力・予算の記録がありません。新しく実行してください。' };
  }
  if (!inputIdentity) return { available: false, reason: '再開に必要な入力を確認できません。開始設定を再読み込みしてください。' };
  if (data.inputIdentity !== inputIdentity) return { available: false,
    reason: '中断後に研究基準／ブロック／シード／最大件数が変わっているため再開できません。新しく実行してください。' };
  const keys = ['apiCalls', 'elapsedMs', 'evaluatedTrials'] as const;
  if (keys.some((key) => !Number.isSafeInteger(data.limits[key]) || data.limits[key] <= 0
    || !Number.isSafeInteger(data.consumed[key]) || data.consumed[key] < 0)) {
    return { available: false, reason: '予算の記録が不正なため再開できません。新しく実行してください。' };
  }
  const remaining = {
    apiCalls: data.limits.apiCalls - data.consumed.apiCalls,
    elapsedMs: data.limits.elapsedMs - data.consumed.elapsedMs,
    evaluatedTrials: data.limits.evaluatedTrials - data.consumed.evaluatedTrials,
  };
  if (keys.some((key) => remaining[key] <= 0)) return { available: false,
    reason: '自動調整の予算を使い切っているため再開できません。新しく実行してください。' };
  return { available: true, remaining, data };
}

export interface OptimizationTrialSummary {
  candidateId: string;
  formula: PubmedFormula;
  totalHits: number | null;
  capturedSeedCount: number | null;
  accepted: boolean;
  held?: boolean;
  lostHits?: number | null;
  gainedHits?: number | null;
  reason: string;
  fingerprint: string | null;
}

export interface QueryOptimizationCompletion {
  reviewSections?: OptimizationReviewSection[];
  status: QueryOptimizationResult['status'];
  stopReason: OptimizationStopReason;
  unmetReasons: string[];
}

export interface QueryOptimizationCheckpoint {
  projectId: string;
  runId: string;
  savedAt: string;
  maxHits: number;
  trials: OptimizationTrialSummary[];
  /** 旧形式はログ表示のみ。復元した値は実測済みとして使わない。 */
  resume?: OptimizationResumeData;
  /** 未指定は実行途中（旧形式のチェックポイントも含む）。 */
  completion?: QueryOptimizationCompletion;
}

export interface InterruptedQueryOptimization extends QueryOptimizationCheckpoint {
  status: 'interrupted';
  needsRevalidation: true;
}

export interface CompletedQueryOptimization extends QueryOptimizationCheckpoint {
  status: 'completed';
  completion: QueryOptimizationCompletion;
  needsRevalidation: true;
}

interface SaveCheckpointOptions {
  projectId: string;
  runId: string;
  maxHits: number;
  trials: readonly OptimizationTrial[];
  resume: OptimizationResumeData;
  completion?: QueryOptimizationCompletion;
  now?: () => string;
}

/** 最新キーに要約を残す。測定全体やシード書誌・ツリーは保存しない。 */
export async function saveQueryOptimizationCheckpoint(
  { projectId, runId, maxHits, trials, resume, now = nowIso, completion }: SaveCheckpointOptions,
  deps: ProjectStoreDeps
): Promise<QueryOptimizationCheckpoint> {
  const checkpoint: QueryOptimizationCheckpoint = {
    projectId, runId, maxHits, savedAt: now(),
    resume: JSON.parse(JSON.stringify(resume)) as OptimizationResumeData,
    ...(completion ? { completion: {
      status: completion.status, stopReason: completion.stopReason, unmetReasons: [...completion.unmetReasons],
      ...(completion.reviewSections ? { reviewSections: completion.reviewSections.map((section) => ({ ...section, lines: [...section.lines] })) } : {}),
    } } : {}),
    trials: trials.map((trial) => ({
      candidateId: trial.candidateId,
      formula: {
        blocks: trial.formula.blocks.map(({ id, expression, isCombination }) => ({ id, expression, isCombination })),
        combinationExpression: trial.formula.combinationExpression,
      },
      totalHits: trial.after?.totalHits ?? null,
      capturedSeedCount: trial.after?.capturedPmids?.length ?? null,
      accepted: trial.accepted,
      held: trial.held ?? false,
      lostHits: trial.impact?.lostHits ?? null,
      gainedHits: trial.impact?.gainedHits ?? null,
      reason: trial.reason,
      fingerprint: trial.after?.fingerprint ?? null,
    })),
  };
  await deps.write({ [CHECKPOINT_KEY]: checkpoint });
  return checkpoint;
}

/** 終了記録がない run だけを中断として復元する。完了済みでも新しい測定は必要。 */
export async function getQueryOptimizationCheckpoint(
  projectId: string,
  deps: ProjectStoreDeps
): Promise<InterruptedQueryOptimization | CompletedQueryOptimization | null> {
  const checkpoint = await deps.read<QueryOptimizationCheckpoint | null>(CHECKPOINT_KEY);
  if (!checkpoint || checkpoint.projectId !== projectId) return null;
  if (checkpoint.completion) return { ...checkpoint, completion: checkpoint.completion, status: 'completed', needsRevalidation: true };
  return { ...checkpoint, status: 'interrupted', needsRevalidation: true };
}

export async function clearQueryOptimizationCheckpoint(deps: ProjectStoreDeps): Promise<void> {
  await deps.write({ [CHECKPOINT_KEY]: null });
}

/** 同じ実行の終了記録だけに、人の判定を反映した確認状況を追記する。 */
export async function updateQueryOptimizationReviewSections(
  projectId: string, runId: string,
  reviewSections: OptimizationReviewSection[],
  deps: ProjectStoreDeps,
  owns: () => boolean = () => true
): Promise<void> {
  const checkpoint = await deps.read<QueryOptimizationCheckpoint | null>(CHECKPOINT_KEY);
  if (!owns() || !checkpoint?.completion || checkpoint.projectId !== projectId || checkpoint.runId !== runId) return;
  await deps.write({ [CHECKPOINT_KEY]: { ...checkpoint, completion: { ...checkpoint.completion, reviewSections } } });
}
