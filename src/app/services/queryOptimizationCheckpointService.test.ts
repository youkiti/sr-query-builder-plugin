import type { ProjectStoreDeps } from '@/features/project';
import type { OptimizationTrial } from '@/features/formula/skills/optimizeQuery';
import { saveQueryOptimizationCheckpoint, getQueryOptimizationCheckpoint, clearQueryOptimizationCheckpoint } from './queryOptimizationCheckpointService';

function setup() {
  const data: Record<string, unknown> = {};
  const deps: ProjectStoreDeps = {
    read: async <T>(key: string) => data[key] as T | undefined,
    write: async (items) => { Object.assign(data, items); },
  };
  const trial: OptimizationTrial = {
    candidateId: 'initial', formula: { blocks: [{ id: '1', expression: 'a[tiab]', isCombination: false }], combinationExpression: null },
    accepted: true, reason: '初期式', rationale: 'AI 文脈は保存しない', before: null,
    after: { id: 'measurement', fingerprint: 'hash', measuredAt: 'date', totalHits: 0,
      capturedPmids: [], missedPmids: ['11'], blocks: [], terms: [{ blockId: '1', query: 'a[tiab]', hits: 0, delta: 0 }] },
  };
  return { data, deps, trial };
}

test('単一キーに要約だけを保存し、復元は中断・要再検証を返す', async () => {
  const { data, deps, trial } = setup();
  const saved = await saveQueryOptimizationCheckpoint('p', 'run', 100, [trial], deps, () => 'fixed-time');
  expect(Object.keys(data)).toEqual(['queryOptimizationCheckpoint']);
  expect(saved.trials).toEqual([{ candidateId: 'initial', formula: trial.formula, totalHits: 0,
    capturedSeedCount: 0, accepted: true, reason: '初期式', fingerprint: 'hash' }]);
  for (const field of ['before', 'after', 'measurement', 'terms', 'capturedPmids', 'missedPmids', 'rationale']) {
    expect(JSON.stringify(saved)).not.toContain(`"${field}"`);
  }
  expect(await getQueryOptimizationCheckpoint('p', deps)).toEqual({ ...saved, status: 'interrupted', needsRevalidation: true });
  expect(saved.savedAt).toBe('fixed-time');
  trial.formula.blocks[0]!.expression = 'mutated';
  expect(saved.trials[0]!.formula.blocks[0]!.expression).toBe('a[tiab]');
});

test('プロジェクト違い・保存なし・破棄済みを復元しない', async () => {
  const { deps, trial } = setup();
  expect(await getQueryOptimizationCheckpoint('p', deps)).toBeNull();
  await saveQueryOptimizationCheckpoint('p', 'run', 100, [trial], deps);
  expect(await getQueryOptimizationCheckpoint('other', deps)).toBeNull();
  await clearQueryOptimizationCheckpoint(deps);
  expect(await getQueryOptimizationCheckpoint('p', deps)).toBeNull();
});

test('上書きは最新だけを残し、未測定を null として保持する', async () => {
  const { deps, trial } = setup();
  await saveQueryOptimizationCheckpoint('p', 'old', 100, [trial], deps);
  trial.after = null;
  const saved = await saveQueryOptimizationCheckpoint('p', 'new', 50, [trial], deps);
  expect(saved.savedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect((await getQueryOptimizationCheckpoint('p', deps))?.runId).toBe('new');
  expect(saved.trials[0]).toMatchObject({ totalHits: null, capturedSeedCount: null, fingerprint: null });
});

test('保存失敗を呼び出し側へ返す', async () => {
  const { deps, trial } = setup();
  deps.write = async () => { throw new Error('容量不足'); };
  await expect(saveQueryOptimizationCheckpoint('p', 'r', 100, [trial], deps)).rejects.toThrow('容量不足');
});

test('終了状態・理由・未達理由を要約へ保存し、完了済みでも再検証を要求する', async () => {
  const { deps, trial } = setup();
  const completion = { status: 'needs_review' as const, stopReason: 'revalidation_failed' as const,
    unmetReasons: ['最大件数 100 件を超えています（実測 120 件）', '未捕捉シード: 11'] };
  const saved = await saveQueryOptimizationCheckpoint('p', 'run', 100, [trial], deps, () => 'finished-at', completion);
  completion.unmetReasons.push('変更後');
  expect(saved.completion!.unmetReasons).toHaveLength(2);
  expect(await getQueryOptimizationCheckpoint('p', deps)).toEqual({ ...saved,
    status: 'completed', needsRevalidation: true });
  expect(await getQueryOptimizationCheckpoint('other', deps)).toBeNull();
  expect(saved).not.toHaveProperty('measurement');
  expect(saved.trials[0]).not.toHaveProperty('terms');
});

test('新しい実行の途中保存では前回の終了記録を持ち越さない', async () => {
  const { deps, trial } = setup();
  await saveQueryOptimizationCheckpoint('p', 'old', 100, [trial], deps, undefined,
    { status: 'achieved', stopReason: 'conditions_met', unmetReasons: [] });
  await saveQueryOptimizationCheckpoint('p', 'new', 100, [trial], deps);
  expect(await getQueryOptimizationCheckpoint('p', deps)).toMatchObject({ runId: 'new', status: 'interrupted', needsRevalidation: true });
  expect(await getQueryOptimizationCheckpoint('p', deps)).not.toHaveProperty('completion');
});
