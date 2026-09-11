import { runOptimizeQuery, startApp } from './bootstrap';
import { createStore, INITIAL_STATE } from './store';
import type { ChromeRuntimeDeps } from './services/factories';
import * as optimization from './services/queryOptimizationService';
import * as llm from './services/llmProviderService';
import * as ncbi from './services/ncbiConfigService';
import * as seeds from '@/features/seeds/seedRepository';
import { serializePubmedFormulaMd } from '@/lib/search-formula-md';

function setup() {
  const store = createStore({ ...INITIAL_STATE,
    project: { projectId: 'p', spreadsheetId: 's', driveFolderId: 'd', title: '研究' },
    blocksDraft: { blocks: [{ blockLabel: '疾患', description: '', aiGenerated: false, note: '' }], combinationExpression: '#1' },
    protocolDraft: { frameworkType: 'pico', researchQuestion: 'RQ', inclusionCriteria: '組入', exclusionCriteria: '除外',
      studyDesign: '', sourceType: 'manual', sourceFilename: null, rawTextRef: null, rawTextPreview: '', rawTextInline: '' },
    protocolDraftPersisted: true, currentProtocolVersion: 1,
    currentFormulaMarkdown: serializePubmedFormulaMd({ blocks: [{ id: '1', expression: 'a[tiab]', isCombination: false }], combinationExpression: null }),
  });
  const data: Record<string, unknown> = {};
  const runtime: ChromeRuntimeDeps = {
    google: { fetch: jest.fn(() => { throw new Error('外部通信は禁止'); }), getAccessToken: async () => 'fake' },
    profile: { getProfileUserInfo: async () => ({ email: '', id: '' }) },
    store: { read: async <T>(key: string) => data[key] as T | undefined, write: async () => undefined },
  };
  const list = jest.spyOn(seeds, 'listSeedPapers').mockResolvedValue([]);
  jest.spyOn(ncbi, 'buildEutilsDeps').mockResolvedValue({ fetch: runtime.google.fetch });
  const factory = jest.spyOn(llm, 'buildLlmProviderFactory').mockResolvedValue({ model: 'test', forPurpose: jest.fn() });
  const result: optimization.QueryOptimizationResult = { status: 'needs_review', stopReason: 'iteration_limit', best: null,
    trials: [], iterations: 1, apiCalls: 1, elapsedMs: 10, unmetReasons: [] };
  const run = jest.spyOn(optimization, 'runQueryOptimization').mockResolvedValue(result);
  return { store, runtime, data, list, factory, run, result };
}
async function flush() { for (let i = 0; i < 30; i += 1) await Promise.resolve(); }
afterEach(() => { jest.restoreAllMocks(); document.body.innerHTML = ''; });

test('専用ファクトリで受けた費用だけを run に累積し、終了後の遅い通知を混入させない', async () => {
  const f = setup();
  const accumulated = jest.fn();
  f.run.mockImplementation(async () => {
    const callback = f.factory.mock.calls[0]![0].onCostAccumulate!;
    callback(0.01);
    callback(0.02);
    expect(f.store.getState().queryOptimizationRun?.costUsd).toBeCloseTo(0.03);
    return f.result;
  });
  await runOptimizeQuery(f.store, f.runtime, { google: f.runtime.google, store: f.runtime.store, onCostAccumulate: accumulated },
    { maxHits: 100, maxIterations: 2 });
  expect(accumulated.mock.calls).toEqual([[0.01], [0.02]]);
  f.factory.mock.calls[0]![0].onCostAccumulate!(1);
  expect(f.store.getState().queryOptimizationRun?.costUsd).toBeCloseTo(0.03);
  expect(f.run.mock.calls[0]![1].measureTermDetails).toBe(true);
});

test('費用が通知されなければ未取得のままにする', async () => {
  const f = setup();
  await runOptimizeQuery(f.store, f.runtime, { google: f.runtime.google, store: f.runtime.store }, { maxHits: 100, maxIterations: 2 });
  expect(f.store.getState().queryOptimizationRun?.costUsd).toBeUndefined();
});

test('MeSH 文脈は run のトップレベルだけに保持し、終了後の通知では置き換えない', async () => {
  const f = setup();
  const nodes = [{ id: 'D1', descriptor: 'Parent', label: 'Parent', treeNumbers: ['C01'],
    parentIds: [], childIds: [], explode: true, note: '取得済み' }];
  f.run.mockImplementation(async (_input, deps) => {
    expect(f.store.getState().queryOptimizationRun?.meshContext).toEqual([]);
    deps.onMeshContext!(nodes);
    const run = f.store.getState().queryOptimizationRun!;
    expect(run.meshContext).toEqual(nodes);
    expect(run.progress).not.toHaveProperty('meshContext');
    expect(run.trials).toEqual([]);
    return f.result;
  });
  await runOptimizeQuery(f.store, f.runtime, { google: f.runtime.google, store: f.runtime.store }, { maxHits: 100, maxIterations: 2 });
  expect(f.store.getState().queryOptimizationRun?.meshContext).toEqual(nodes);
  expect(f.store.getState().queryOptimizationRun?.result).not.toHaveProperty('meshContext');
  f.run.mock.calls[0]![1].onMeshContext!([]);
  expect(f.store.getState().queryOptimizationRun?.meshContext).toEqual(nodes);
});

test('初期式生成中の AI 待機と失敗を実行状態へ通知する', async () => {
  const f = setup();
  f.run.mockImplementation(async () => {
    const notify = f.factory.mock.calls[0]![0].onRequestState!;
    notify('retry');
    expect(f.store.getState().queryOptimizationRun?.progress.apiWaiting).toEqual({ source: 'AI', status: 'retry' });
    notify('idle');
    expect(f.store.getState().queryOptimizationRun?.progress.apiWaiting).toBeNull();
    notify('failure');
    expect(f.store.getState().queryOptimizationRun?.progress.apiEvents).toContainEqual({ source: 'AI', status: 'failure' });
    return f.result;
  });
  await runOptimizeQuery(f.store, f.runtime, { google: f.runtime.google, store: f.runtime.store }, { maxHits: 100, maxIterations: 2 });
});

test.each(['interrupted', 'completed', 'other', 'seed_failure'])('チェックポイント %s を project と終了記録に従い state へ復元する', async (mode) => {
  const f = setup();
  f.data.queryOptimizationCheckpoint = {
    projectId: mode === 'other' ? 'other' : 'p', runId: 'old', savedAt: '2026-09-10', maxHits: 10,
    trials: [{ candidateId: 'initial', totalHits: 8, capturedSeedCount: 1, accepted: true, reason: '初期式', fingerprint: 'f' }],
    ...(mode === 'completed' ? { completion: { status: 'achieved', stopReason: 'conditions_met', unmetReasons: [] } } : {}),
  };
  if (mode === 'seed_failure') f.list.mockRejectedValue(new Error('シード取得失敗'));
  document.body.innerHTML = '<section id="app-content"></section>';
  const app = startApp(document, { store: f.store, runtime: f.runtime, getHash: () => '#/draft',
    onHashChange: () => () => undefined, setHash: jest.fn() });
  await flush();
  const restored = f.store.getState().queryOptimizationSetup?.checkpoint;
  if (mode === 'other') expect(restored).toBeNull();
  else {
    expect(restored?.status).toBe(mode === 'completed' ? 'completed' : 'interrupted');
    expect(restored?.needsRevalidation).toBe(true);
    expect(document.querySelector('.optimization__restored')?.textContent).toContain('8 件');
  }
  expect(f.store.getState().queryOptimizationRun).toBeNull();
  expect(f.run).not.toHaveBeenCalled();
  app.dispose();
});
