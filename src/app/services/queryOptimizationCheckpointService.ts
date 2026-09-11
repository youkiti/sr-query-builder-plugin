import type { ProjectStoreDeps } from '@/features/project';
import type { OptimizationTrial } from '@/features/formula/skills/optimizeQuery';
import type { PubmedFormula } from '@/lib/search-formula-md';
import { nowIso } from '@/utils/iso8601';

const CHECKPOINT_KEY = 'queryOptimizationCheckpoint';

export interface OptimizationTrialSummary {
  candidateId: string;
  formula: PubmedFormula;
  totalHits: number | null;
  capturedSeedCount: number | null;
  accepted: boolean;
  reason: string;
  fingerprint: string | null;
}

export interface QueryOptimizationCheckpoint {
  projectId: string;
  runId: string;
  savedAt: string;
  maxHits: number;
  trials: OptimizationTrialSummary[];
}

export interface InterruptedQueryOptimization extends QueryOptimizationCheckpoint {
  status: 'interrupted';
  needsRevalidation: true;
}

/** 単一キーへ試行の要約だけを射影する。測定全体やシード書誌・ツリーは保存しない。 */
export async function saveQueryOptimizationCheckpoint(
  projectId: string,
  runId: string,
  maxHits: number,
  trials: readonly OptimizationTrial[],
  deps: ProjectStoreDeps,
  now: () => string = nowIso
): Promise<QueryOptimizationCheckpoint> {
  const checkpoint: QueryOptimizationCheckpoint = {
    projectId, runId, maxHits, savedAt: now(),
    trials: trials.map((trial) => ({
      candidateId: trial.candidateId,
      formula: {
        blocks: trial.formula.blocks.map(({ id, expression, isCombination }) => ({ id, expression, isCombination })),
        combinationExpression: trial.formula.combinationExpression,
      },
      totalHits: trial.after?.totalHits ?? null,
      capturedSeedCount: trial.after?.capturedPmids?.length ?? null,
      accepted: trial.accepted,
      reason: trial.reason,
      fingerprint: trial.after?.fingerprint ?? null,
    })),
  };
  await deps.write({ [CHECKPOINT_KEY]: checkpoint });
  return checkpoint;
}

/** 復元は中断ログであり、再開には固定入力の照合と新しい測定が必要。 */
export async function getQueryOptimizationCheckpoint(
  projectId: string,
  deps: ProjectStoreDeps
): Promise<InterruptedQueryOptimization | null> {
  const checkpoint = await deps.read<QueryOptimizationCheckpoint | null>(CHECKPOINT_KEY);
  if (!checkpoint || checkpoint.projectId !== projectId) return null;
  return { ...checkpoint, status: 'interrupted', needsRevalidation: true };
}

export async function clearQueryOptimizationCheckpoint(deps: ProjectStoreDeps): Promise<void> {
  await deps.write({ [CHECKPOINT_KEY]: null });
}
