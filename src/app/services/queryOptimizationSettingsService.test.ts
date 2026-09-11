import type { ProjectStoreDeps } from '@/features/project';
import { HIT_THRESHOLD } from '@/features/formula/skills/filterDesigner';
import { DEFAULT_MAX_ITERATIONS } from './queryOptimizationService';
import { MAX_SAVED_OPTIMIZATION_PROJECTS, DEFAULT_QUERY_OPTIMIZATION_SETTINGS, getQueryOptimizationSettings, saveQueryOptimizationSettings,
  validateQueryOptimizationSettings } from './queryOptimizationSettingsService';

test('既定値は既存閾値と反復サービスの既定値を参照する', () => {
  expect(DEFAULT_QUERY_OPTIMIZATION_SETTINGS).toEqual({ maxHits: HIT_THRESHOLD, maxIterations: DEFAULT_MAX_ITERATIONS });
});

test('単一キーの設定を同じプロジェクトでだけ復元する', async () => {
  const data: Record<string, unknown> = {};
  const deps: ProjectStoreDeps = { read: async <T>(key: string) => data[key] as T | undefined,
    write: async (items) => { Object.assign(data, items); } };
  expect(await getQueryOptimizationSettings('p', deps)).toBeNull();
  await saveQueryOptimizationSettings('p', { maxHits: 321, maxIterations: 2 }, deps);
  expect(await getQueryOptimizationSettings('p', deps)).toEqual({ projectId: 'p', maxHits: 321, maxIterations: 2 });
  expect(await getQueryOptimizationSettings('other', deps)).toBeNull();
  expect(Object.keys(data)).toHaveLength(1);
  data.queryOptimizationSettings = { projectId: 'p', maxHits: -1, maxIterations: 2 };
  expect(await getQueryOptimizationSettings('p', deps)).toBeNull();
});

test.each([0, -1, 1.5, NaN, Infinity])('不正な最大件数 %s を保存しない', async (maxHits) => {
  const write = jest.fn();
  await expect(saveQueryOptimizationSettings('p', { maxHits, maxIterations: 5 }, { read: async () => undefined, write })).rejects.toThrow();
  expect(write).not.toHaveBeenCalled();
});

test('シード数より小さい最大件数と不正な反復上限を弾き、シードなしは許す', () => {
  expect(validateQueryOptimizationSettings({ maxHits: 1, maxIterations: 5 }, 2)).toContain('シード数');
  expect(validateQueryOptimizationSettings({ maxHits: 1, maxIterations: 0 })).toContain('反復上限');
  expect(validateQueryOptimizationSettings({ maxHits: 1, maxIterations: 5 }, 0)).toBeNull();
});


function memoryStore(initial: unknown = undefined) {
  const data: Record<string, unknown> = { queryOptimizationSettings: initial };
  const deps: ProjectStoreDeps = { read: async <T>(key: string) => data[key] as T | undefined,
    write: async (items) => { Object.assign(data, items); } };
  return { data, deps };
}

test('A 保存 → B 保存 → A 読み込みで A の前回値を保持する', async () => {
  const { data, deps } = memoryStore();
  await saveQueryOptimizationSettings('A', { maxHits: 321, maxIterations: 2 }, deps);
  await saveQueryOptimizationSettings('B', { maxHits: 456, maxIterations: 3 }, deps);
  expect(await getQueryOptimizationSettings('A', deps)).toEqual({ projectId: 'A', maxHits: 321, maxIterations: 2 });
  expect(await getQueryOptimizationSettings('B', deps)).toEqual({ projectId: 'B', maxHits: 456, maxIterations: 3 });
  expect(Object.keys(data)).toEqual(['queryOptimizationSettings']);
});

test('保持上限では最終保存が古いものから削除し、再保存したプロジェクトは保持する', async () => {
  const { data, deps } = memoryStore();
  for (let i = 0; i < MAX_SAVED_OPTIMIZATION_PROJECTS; i += 1) {
    await saveQueryOptimizationSettings(`p${i}`, { maxHits: 100 + i, maxIterations: 2 }, deps);
  }
  await saveQueryOptimizationSettings('p0', { maxHits: 999, maxIterations: 3 }, deps);
  // 読み込みだけでは最終保存順を変えない。
  await getQueryOptimizationSettings('p1', deps);
  await saveQueryOptimizationSettings('new', { maxHits: 888, maxIterations: 4 }, deps);
  expect(await getQueryOptimizationSettings('p1', deps)).toBeNull();
  expect(await getQueryOptimizationSettings('p0', deps)).toMatchObject({ maxHits: 999, maxIterations: 3 });
  expect(await getQueryOptimizationSettings('new', deps)).toMatchObject({ maxHits: 888 });
  const stored = data.queryOptimizationSettings as { projects: Record<string, unknown>; order: string[] };
  expect(Object.keys(stored.projects)).toHaveLength(MAX_SAVED_OPTIMIZATION_PROJECTS);
  expect(stored.order).toHaveLength(MAX_SAVED_OPTIMIZATION_PROJECTS);
});

test('旧形式を読み込み、新形式で別プロジェクトを保存しても旧値を保持する', async () => {
  const { deps } = memoryStore({ projectId: 'A', maxHits: 321, maxIterations: 2 });
  expect(await getQueryOptimizationSettings('A', deps)).toMatchObject({ maxHits: 321 });
  await saveQueryOptimizationSettings('B', { maxHits: 456, maxIterations: 3 }, deps);
  expect(await getQueryOptimizationSettings('A', deps)).toMatchObject({ maxHits: 321 });
});

test.each([null, 'broken', [], { projects: null, order: ['A'] },
  { projects: { A: null }, order: ['A'] },
  { projects: { A: { projectId: 'A', maxHits: -1, maxIterations: 2 } }, order: ['A'] },
  { projects: { A: { projectId: 'B', maxHits: 123, maxIterations: 2 } }, order: ['A'] },
])('不正な保存内容は例外を投げず既定値へのフォールバックを許す: %j', async (stored) => {
  const { deps } = memoryStore(stored);
  expect(await getQueryOptimizationSettings('A', deps)).toBeNull();
  await saveQueryOptimizationSettings('A', { maxHits: 123, maxIterations: 2 }, deps);
  expect(await getQueryOptimizationSettings('A', deps)).toMatchObject({ maxHits: 123 });
});
