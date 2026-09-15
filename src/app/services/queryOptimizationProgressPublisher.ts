import type { AppState, AppStore } from '../store';
import type { QueryOptimizationProgress } from './queryOptimizationService';

/** 細かな進捗を最大 100ms まとめる。試行確定と段階遷移は待たずに通知する。 */
export function createOptimizationProgressPublisher(store: AppStore, owns: (state: AppState) => boolean) {
  let pending: QueryOptimizationProgress | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  const flush = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    const progress = pending;
    pending = null;
    if (!progress || disposed) return;
    store.setState((s) => {
      const run = s.queryOptimizationRun;
      if (!owns(s) || !run || JSON.stringify(run.progress) === JSON.stringify(progress)) return s;
      return { ...s, queryOptimizationRun: { ...run, progress, blockDiagnosis: progress.blockDiagnosis ?? run.blockDiagnosis,
        trials: progress.trial && !run.trials.some((trial) => trial.candidateId === progress.trial!.candidateId)
          ? [...run.trials, progress.trial] : run.trials,
      } };
    });
  };
  return {
    publish(progress: QueryOptimizationProgress): void {
      if (disposed || !owns(store.getState())) return;
      pending = progress;
      if (progress.trial || progress.step !== store.getState().queryOptimizationRun?.progress.step) flush();
      else if (timer === null) timer = setTimeout(flush, 100);
    },
    flush,
    dispose(): void {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending = null;
    },
  };
}
