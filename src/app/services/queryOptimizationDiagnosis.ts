import type { OptimizationTrial } from '@/features/formula/skills/optimizeQuery';
import type { BlockDiagnosis } from '@/features/validation/blockDiagnosis';

/** 実式の差分を優先し、同じブロックの採用・却下だけで保留の連続を数え直す。 */
export function diagnosedHeldBlock(trials: readonly OptimizationTrial[], diagnosis?: BlockDiagnosis): string | null {
  const diagnosed = new Set([
    ...(diagnosis?.overlaps.filter((row) => row.kind !== 'unknown').flatMap((row) => row.blockIds) ?? []),
    ...(diagnosis?.narrowing.filter((row) => row.ineffective).map((row) => row.blockId) ?? []),
  ]);
  const counts = new Map<string, number>();
  for (const trial of trials) {
    if (trial.kind !== 'proposal' || trial.duplicateOf) continue;
    if (trial.held && !(trial.impact && trial.impact.lostHits !== null && trial.impact.lostHits >= 1)) continue;
    const diff = trial.formulaDiff?.filter((block) => block.added.length || block.removed.length);
    const id = diff?.length === 1 ? diff[0]!.blockId : trial.changes?.targetBlockId;
    if (!id || !diagnosed.has(id)) continue;
    counts.set(id, trial.held ? (counts.get(id) ?? 0) + 1 : 0);
  }
  return [...counts].find(([, count]) => count >= 2)?.[0] ?? null;
}
