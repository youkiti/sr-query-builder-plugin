import { createStore, INITIAL_STATE } from '../store';
import { createOptimizationProgressPublisher } from './queryOptimizationProgressPublisher';

function setup() {
  const progress = { step: 'adjusting' as const, iterations: 1, bestTotalHits: 100, bestCapturedSeedCount: 1, trial: null };
  const store = createStore({ ...INITIAL_STATE, queryOptimizationRun: {
    runId: 'r', projectId: 'p', status: 'running', maxHits: 100, maxIterations: 5, seedCount: 1,
    startedAtMs: 0, finishedAtMs: null, stopRequested: false, error: null, meshContext: [], progress, trials: [], result: null,
  } });
  const changed = jest.fn();
  store.subscribe(changed);
  const silent = jest.spyOn(store, 'setStateSilently');
  const publisher = createOptimizationProgressPublisher(store, (s) => s.queryOptimizationRun?.runId === 'r');
  return { store, progress, changed, silent, publisher };
}
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

test('600件の語別通知をまとめて最新値だけ描画し、silent更新を使わない', () => {
  jest.useFakeTimers();
  const f = setup();
  for (let completed = 1; completed <= 600; completed += 1) {
    f.publisher.publish({ ...f.progress, task: { kind: 'terms', completed, total: 600 } });
  }
  expect(f.changed).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(1);
  jest.advanceTimersByTime(100);
  expect(f.changed).toHaveBeenCalledTimes(1);
  expect(f.store.getState().queryOptimizationRun?.progress.task?.completed).toBe(600);
  expect(f.silent).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
  f.publisher.dispose();
});

test('段階遷移と試行確定は即時反映し、同一通知を再描画・履歴重複させない', () => {
  jest.useFakeTimers();
  const f = setup();
  f.publisher.publish({ ...f.progress, task: { kind: 'terms', completed: 1, total: 10 } });
  const next = { ...f.progress, step: 'measuring' as const, trial: {
    kind: 'proposal' as const, candidateId: 'c1', formula: { blocks: [], combinationExpression: null },
    before: null, after: null, accepted: false, reason: '検証', rationale: '', apiEvents: [],
  } };
  f.publisher.publish(next);
  expect(f.changed).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
  expect(f.store.getState().queryOptimizationRun?.trials).toHaveLength(1);
  f.publisher.publish(next);
  expect(f.changed).toHaveBeenCalledTimes(1);
  expect(f.store.getState().queryOptimizationRun?.trials).toHaveLength(1);
  f.publisher.dispose();
});

test('完了直前のflushは最新値を保持し、dispose後やrun切替後は通知しない', () => {
  jest.useFakeTimers();
  const f = setup();
  f.publisher.publish({ ...f.progress, iterations: 2 });
  f.publisher.flush();
  expect(f.store.getState().queryOptimizationRun?.progress.iterations).toBe(2);
  f.publisher.publish({ ...f.progress, iterations: 3 });
  f.store.setState((s) => ({ ...s, queryOptimizationRun: { ...s.queryOptimizationRun!, runId: 'new' } }));
  const current = f.store.getState();
  jest.advanceTimersByTime(100);
  expect(f.store.getState()).toBe(current);
  f.publisher.dispose();
  f.publisher.publish(f.progress);
  expect(jest.getTimerCount()).toBe(0);
});

test('診断の進捗を実行状態に反映する', () => {
  jest.useFakeTimers();
  const f = setup();
  const blockDiagnosis = { fingerprint: '診断した式', note: '未判定: 結合式が単純な AND ではない', overlaps: [], narrowing: [] };
  f.publisher.publish({ ...f.progress, blockDiagnosis });
  f.publisher.flush();
  expect(f.store.getState().queryOptimizationRun?.blockDiagnosis).toEqual(blockDiagnosis);
  f.publisher.dispose();
});
