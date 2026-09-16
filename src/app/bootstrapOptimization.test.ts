import { runOptimizeQuery, runDecideOutsideCandidate, runReadjustOptimization, startApp } from './bootstrap';
import * as expand from './services/expandService';
import * as checkpointService from './services/queryOptimizationCheckpointService';
import { buildOptimizationReviewSections } from './services/queryOptimizationReviewSections';
import { createStore, INITIAL_STATE } from './store';
import type { ChromeRuntimeDeps } from './services/factories';
import * as optimization from './services/queryOptimizationService';
import * as factory from './services/llmProviderService';
import * as ncbiConfig from './services/ncbiConfigService';
import * as seeds from '@/features/seeds/seedRepository';
import * as draft from './services/draftService';
import * as mesh from '@/lib/ncbi/mesh';
import * as meshRdf from '@/lib/ncbi/meshRdf';
import * as protocolRepository from '@/features/protocol/protocolRepository';
import * as formulaRepository from '@/features/formula/formulaRepository';
import * as improveSkill from '@/features/formula/skills/improveBlock';
import { getQueryOptimizationSettings } from './services/queryOptimizationSettingsService';
import { createQueryOptimizationInputIdentity, type InterruptedQueryOptimization } from './services/queryOptimizationCheckpointService';
import type { SeedPaper } from '@/domain/seedPaper';
import { serializePubmedFormulaMd } from '@/lib/search-formula-md';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const formula = { blocks: [{ id: '1', expression: 'a[tiab]', isCombination: false }], combinationExpression: null };
const result: optimization.QueryOptimizationResult = {
  status: 'needs_review', stopReason: 'iteration_limit', best: null, trials: [], unmetReasons: [],
  iterations: 1, apiCalls: 2, elapsedMs: 100,
};
const seed = (pmid: string | null, extra: Partial<SeedPaper> = {}): SeedPaper => ({
  pmid, title: '論文', year: null, source: 'initial', ingestFormat: 'pmid_direct', originalDb: null,
  isValid: true, exclusionReason: null, originalPayloadRef: null, userDecision: null,
  decidedAt: null, decidedBy: null, note: null, ...extra,
});
function setup() {
  const store = createStore({ ...INITIAL_STATE,
    project: { projectId: 'p', spreadsheetId: 's', driveFolderId: 'd', title: '研究' },
    blocksDraft: { blocks: [{ blockLabel: '疾患', description: '説明', aiGenerated: false, note: '' }], combinationExpression: '#1' },
    protocolDraft: { frameworkType: 'pico', researchQuestion: 'RQ', inclusionCriteria: '組入', exclusionCriteria: '除外',
      studyDesign: '', sourceType: 'manual', sourceFilename: null, rawTextRef: null, rawTextPreview: '', rawTextInline: '' },
    protocolDraftPersisted: true, currentProtocolVersion: 1,
    currentFormulaMarkdown: serializePubmedFormulaMd(formula), currentFormulaVersionId: 'saved',
  });
  const data: Record<string, unknown> = {};
  const runtime: ChromeRuntimeDeps = {
    google: { fetch: jest.fn(() => { throw new Error('外部通信は禁止'); }), getAccessToken: async () => 'fake' },
    profile: { getProfileUserInfo: async () => ({ email: '', id: '' }) },
    store: { read: async <T>(key: string) => data[key] as T | undefined,
      write: jest.fn(async (items) => { Object.assign(data, items); }) },
  };
  jest.spyOn(protocolRepository, 'getLatestProtocol').mockResolvedValue(null);
  jest.spyOn(formulaRepository, 'getLatestFormulaVersion').mockResolvedValue(null);
  const list = jest.spyOn(seeds, 'listSeedPapers').mockResolvedValue([seed('11')]);
  const buildFactory = jest.spyOn(factory, 'buildLlmProviderFactory').mockResolvedValue({ model: 'fake', forPurpose: jest.fn() });
  jest.spyOn(ncbiConfig, 'buildEutilsDeps').mockResolvedValue({ fetch: runtime.google.fetch });
  const run = jest.spyOn(optimization, 'runQueryOptimization').mockResolvedValue(result);
  const invoke = (maxHits = 123) => runOptimizeQuery(store, runtime,
    { google: runtime.google, store: runtime.store }, { maxHits, maxIterations: 2 });
  return { store, runtime, run, list, buildFactory, invoke, data };
}
async function flush() { for (let i = 0; i < 30; i += 1) await Promise.resolve(); }
async function switchProject(fixture: ReturnType<typeof setup>, projectId = 'other') {
  fixture.data.currentProject = { ...fixture.store.getState().project!, projectId };
  const app = startApp(document.implementation.createHTMLDocument('切替'), {
    store: fixture.store, runtime: fixture.runtime,
    getHash: () => '#/home', onHashChange: () => () => undefined, setHash: jest.fn(),
  });
  await flush();
  app.dispose();
}
afterEach(() => { jest.restoreAllMocks(); document.body.innerHTML = ''; });

function prepareResume(f: ReturnType<typeof setup>) {
  const state = f.store.getState();
  const checkpoint: InterruptedQueryOptimization = { projectId: 'p', runId: 'old', maxHits: 123, savedAt: 'old-time',
    status: 'interrupted', needsRevalidation: true,
    trials: [{ candidateId: 'rejected', formula, reason: 'シードを失う', fingerprint: 'old-hash', accepted: false,
      totalHits: 1, capturedSeedCount: 0 }],
    resume: { bestFormula: { blocks: [{ id: '1', expression: 'best[tiab]', isCombination: false }], combinationExpression: null },
      inputIdentity: createQueryOptimizationInputIdentity(state.protocolDraft!, state.blocksDraft!, ['11'], 123),
      limits: { apiCalls: 200, elapsedMs: 600000, evaluatedTrials: 5 },
      consumed: { apiCalls: 120, elapsedMs: 300000, evaluatedTrials: 2 },
      previousRejectedTrials: [{ formula, reason: 'さらに前の却下', fingerprint: 'older-hash' }] },
  };
  f.data.queryOptimizationCheckpoint = checkpoint;
  f.store.setState((s) => ({ ...s, queryOptimizationSetup: { projectId: 'p', status: 'ready',
    maxHits: '123', maxIterations: '5', seedCount: 1, seedPmids: ['11'], error: null, checkpoint } }));
  const resume = () => runOptimizeQuery(f.store, f.runtime, { google: f.runtime.google, store: f.runtime.store },
    { maxHits: 123, maxIterations: 5 }, 'old');
  return { checkpoint, resume };
}

test('再開は最良式・新 runId・3種類の残予算を使い、初期式を生成せず旧記録を保持する', async () => {
  const f = setup();
  const { checkpoint, resume } = prepareResume(f);
  const generate = jest.spyOn(draft, 'generateDraftFormula');
  await resume();
  const [input, deps] = f.run.mock.calls[0]!;
  expect(input.runId).not.toBe('old');
  expect(input.initialFormula).toEqual(checkpoint.resume!.bestFormula);
  expect(input.maxIterations).toBe(3);
  expect(input.resumeBudget).toEqual({ runId: 'old', limits: checkpoint.resume!.limits, consumed: checkpoint.resume!.consumed });
  expect(input.previousRejectedTrials?.map((trial) => trial.reason)).toEqual(['さらに前の却下', 'シードを失う']);
  expect(input.previousRejectedTrials?.[1]).not.toHaveProperty('totalHits');
  expect(deps).toMatchObject({ maxApiCalls: 80, maxElapsedMs: 300000 });
  expect(f.store.getState().queryOptimizationRun?.maxIterations).toBe(3);
  expect(await getQueryOptimizationSettings('p', f.runtime.store)).toMatchObject({ maxIterations: 5 });
  expect(generate).not.toHaveBeenCalled();
  expect(f.store.getState().queryOptimizationRun?.generationNotices).toBeUndefined();
  expect(f.data.queryOptimizationCheckpoint).toBe(checkpoint);
});

test.each(['criteria', 'blocks', 'seeds', 'budget', 'completed', 'missing'] as const)('再開時にも %s を確認し、run 作成前に拒否する', async (kind) => {
  const f = setup();
  const { checkpoint, resume } = prepareResume(f);
  if (kind === 'criteria') f.store.setState((s) => ({ ...s, protocolDraft: { ...s.protocolDraft!, researchQuestion: '変更' } }));
  if (kind === 'blocks') f.store.setState((s) => ({ ...s, blocksDraft: { ...s.blocksDraft!, combinationExpression: '#2' } }));
  if (kind === 'seeds') f.store.setState((s) => ({ ...s, queryOptimizationSetup: { ...s.queryOptimizationSetup!, seedPmids: ['22'] } }));
  if (kind === 'budget') checkpoint.resume!.consumed.evaluatedTrials = 5;
  if (kind === 'completed') checkpoint.completion = { status: 'achieved', stopReason: 'conditions_met', unmetReasons: [] };
  if (kind === 'missing') f.store.setState((s) => ({ ...s, queryOptimizationSetup: null }));
  await resume();
  expect(f.run).not.toHaveBeenCalled();
  expect(f.list).not.toHaveBeenCalled();
  expect(f.store.getState().queryOptimizationRun).toBeNull();
  expect(f.store.getState().queryOptimizationSetup?.error).toBeTruthy();
});

test('準備後に外部シード集合が変わっていたら取得し直した集合で拒否し、旧ログを保持する', async () => {
  const f = setup();
  const { checkpoint, resume } = prepareResume(f);
  f.list.mockResolvedValue([seed('22')]);
  await resume();
  expect(f.run).not.toHaveBeenCalled();
  expect(f.buildFactory).not.toHaveBeenCalled();
  expect(f.store.getState().queryOptimizationRun).toBeNull();
  expect(f.store.getState().queryOptimizationSetup?.error).toContain('変わっている');
  expect(f.data.queryOptimizationCheckpoint).toBe(checkpoint);
});

test('UI の入力値を実行と固定表示に共用し、入力・停止・復元を store 経由で行う', async () => {
  const fixture = setup();
  const pending = deferred<optimization.QueryOptimizationResult>();
  fixture.run.mockReturnValue(pending.promise);
  fixture.data.queryOptimizationSettings = { projectId: 'p', maxHits: 432, maxIterations: 3 };
  document.body.innerHTML = '<section id="app-content"></section>';
  const app = startApp(document, { store: fixture.store, runtime: fixture.runtime,
    getHash: () => '#/draft', onHashChange: () => () => undefined, setHash: jest.fn() });
  await flush();
  const inputs = document.querySelectorAll<HTMLInputElement>('.optimization__setup input');
  expect(inputs[0]!.value).toBe('432');
  expect(inputs[1]!.value).toBe('3');
  inputs[0]!.value = '321';
  inputs[0]!.dispatchEvent(new Event('input'));
  expect(fixture.store.getState().queryOptimizationSetup?.maxHits).toBe('321');
  document.querySelector<HTMLButtonElement>('.optimization__start')!.click();
  await flush();
  expect(fixture.run.mock.calls[0]![0].maxHits).toBe(321);
  expect(document.querySelector('.optimization__metrics')!.textContent).toContain('目安件数: 321 件');
  document.querySelector<HTMLButtonElement>('.optimization__stop')!.click();
  expect(fixture.store.getState().queryOptimizationRun?.stopRequested).toBe(true);
  expect(fixture.run.mock.calls[0]![1].shouldStop!()).toBe(true);
  pending.resolve({ ...result, status: 'stopped', stopReason: 'user_stop' });
  await flush();
  expect(fixture.store.getState().queryOptimizationRun?.status).toBe('ready');
  expect(await getQueryOptimizationSettings('p', fixture.runtime.store)).toEqual({ projectId: 'p', maxHits: 321, maxIterations: 3 });
  app.dispose();
});

test('適格シードの重複・null を除き、現在式・承認ブロック順・基準を入力する', async () => {
  const fixture = setup();
  fixture.list.mockResolvedValue([seed('11'), seed('11'), seed(null), seed('22', { isValid: false }), seed('33', { userDecision: 'maybe' })]);
  await fixture.invoke();
  expect(fixture.run.mock.calls[0]![0]).toMatchObject({ seedPmids: ['11'], maxHits: 123,
    initialFormula: formula, approvedBlocks: [{ id: '1', approvedBlockId: '1', label: '疾患' }],
    criteria: { researchQuestion: 'RQ', inclusionCriteria: '組入', exclusionCriteria: '除外' } });
  expect(fixture.store.getState().currentFormulaVersionId).toBe('saved');
  expect(fixture.store.getState().queryOptimizationRun?.generationNotices).toBeUndefined();
});

test('二重起動を防ぎ、確定済み試行の重複通知を履歴に重ねない', async () => {
  const fixture = setup();
  const pending = deferred<optimization.QueryOptimizationResult>();
  fixture.run.mockReturnValue(pending.promise);
  const first = fixture.invoke();
  await fixture.invoke();
  await flush();
  expect(fixture.run).toHaveBeenCalledTimes(1);
  const progress: optimization.QueryOptimizationProgress = { step: 'adjusting', iterations: 1, bestTotalHits: 120,
    bestCapturedSeedCount: 1, trial: { kind: 'initial', apiEvents: [], candidateId: 'initial', formula, before: null, after: null, accepted: true, reason: '実測', rationale: '' } };
  fixture.run.mock.calls[0]![1].onProgress!(progress);
  fixture.run.mock.calls[0]![1].onProgress!(progress);
  expect(fixture.store.getState().queryOptimizationRun?.trials).toHaveLength(1);
  pending.resolve(result);
  await first;
});

test.each(['project', 'clear', 'replace', 'away-back'] as const)('遅延した進捗・結果を適用しない: %s', async (mode) => {
  const fixture = setup();
  const pending = deferred<optimization.QueryOptimizationResult>();
  fixture.run.mockReturnValue(pending.promise);
  const running = fixture.invoke();
  await flush();
  const deps = fixture.run.mock.calls[0]![1];
  if (mode === 'project' || mode === 'away-back') await switchProject(fixture);
  if (mode === 'away-back') await switchProject(fixture, 'p');
  if (mode === 'clear') fixture.store.setState((s) => ({ ...s, queryOptimizationRun: null }));
  if (mode === 'replace') fixture.store.setState((s) => ({ ...s, queryOptimizationRun: { ...s.queryOptimizationRun!, runId: 'new-run' } }));
  const before = fixture.store.getState();
  expect(deps.shouldStop!()).toBe(true);
  deps.onProgress!({ step: 'review', iterations: 9, bestTotalHits: 99, bestCapturedSeedCount: 1, trial: null });
  pending.resolve(result);
  await running;
  expect(fixture.store.getState()).toBe(before);
  expect(fixture.store.getState().currentFormulaVersionId).toBe('saved');
});

test('プロジェクト切替後の遅延エラーも適用しない', async () => {
  const fixture = setup();
  const pending = deferred<optimization.QueryOptimizationResult>();
  fixture.run.mockReturnValue(pending.promise);
  const running = fixture.invoke();
  await flush();
  await switchProject(fixture);
  const before = fixture.store.getState();
  pending.reject(new Error('古い応答'));
  await running;
  expect(fixture.store.getState()).toBe(before);
});

test('目安件数がシード数未満なら LLM 準備・最適化・設定保存前に止める', async () => {
  const fixture = setup();
  fixture.list.mockResolvedValue([seed('11'), seed('22')]);
  await fixture.invoke(1);
  expect(fixture.store.getState().queryOptimizationRun).toBeNull();
  expect(fixture.store.getState().queryOptimizationSetup?.error).toContain('シード数');
  expect(fixture.buildFactory).not.toHaveBeenCalled();
  expect(fixture.run).not.toHaveBeenCalled();
  expect(fixture.runtime.store.write).not.toHaveBeenCalled();
});

test.each([0, 1.5, -1])('不正な目安件数 %s はシードの読み込み前に弾く', async (maxHits) => {
  const fixture = setup();
  await fixture.invoke(maxHits);
  expect(fixture.list).not.toHaveBeenCalled();
  expect(fixture.run).not.toHaveBeenCalled();
  expect(fixture.store.getState().queryOptimizationRun).toBeNull();
  expect(fixture.store.getState().queryOptimizationSetup?.error).toContain('正の整数');
});

test('シードなし・式なしは保存なし生成を経て実行する', async () => {
  const fixture = setup();
  fixture.list.mockResolvedValue([]);
  fixture.store.setState((s) => ({ ...s, currentFormulaMarkdown: null }));
  const generationNotices = {
    filterNotice: '研究デザインに RCT 以外を含むため RCT フィルタを付けませんでした',
    parenthesizedTerms: [{ blockIndex: 0, blockId: '1', blockLabel: '疾患', term: 'a AND b' }],
    removedMeshHeadings: [{ blockIndex: 0, blockId: '1', blockLabel: '疾患', descriptor: 'Unknown' }],
    replacedMeshHeadings: [{ blockIndex: 0, blockId: '1', blockLabel: '疾患', from: '旧見出し', to: ['正式見出し'] }],
  };
  const generate = jest.spyOn(draft, 'generateDraftFormula').mockResolvedValue({ formula, markdown: '', ...generationNotices,
    filter: { filters: [], appendToCombination: '', excessFilterCandidates: [] }, blockSkeletons: [], meshSuggestions: [], freewordSuggestions: [], blockHits: [] });
  await fixture.invoke();
  expect(generate).toHaveBeenCalledTimes(1);
  expect(fixture.store.getState().queryOptimizationRun?.generationNotices).toEqual(generationNotices);
  const checkMesh = jest.spyOn(mesh, 'resolveMeshDescriptors').mockResolvedValue(new Map([['Term', { status: 'resolved', headings: ['Term'] }]]));
  expect(await generate.mock.calls[0]![1].resolveMeshDescriptors!(['Term'])).toEqual(new Map([['Term', { status: 'resolved', headings: ['Term'] }]]));
  expect(checkMesh).toHaveBeenCalledWith(['Term'], { fetch: fixture.runtime.google.fetch });
  expect(fixture.run.mock.calls[0]![0].seedPmids).toEqual([]);
  expect(fixture.store.getState().queryOptimizationRun?.seedCount).toBe(0);
  expect(fixture.store.getState().currentFormulaMarkdown).toBeNull();
});


test('MeSH 追加文脈は確認した親子だけを結び、枝数・再試行数を制限する', async () => {
  const fixture = setup();
  jest.spyOn(mesh, 'fetchMeshTreeNumbers').mockResolvedValue({ trees: new Map([['疾患', ['C01', 'C02', 'C03', 'C04']]]), reasons: new Map() });
  jest.spyOn(meshRdf, 'fetchMeshLabels').mockImplementation(async (branches) => new Map([
    [branches[0]!, { treeNumber: branches[0]!, descriptorUi: 'P', label: '親' }],
  ]));
  const children = jest.spyOn(meshRdf, 'fetchMeshChildren').mockImplementation(async (branch) => [
    { treeNumber: `${branch}.001`, descriptorUi: 'C', label: '子' },
  ]);
  fixture.run.mockImplementation(async (_input, deps) => {
    const nodes = await deps.fetchMeshContext!({ descriptor: '疾患', treeNumber: '' });
    expect(nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'P', treeNumbers: ['C01', 'C02', 'C03'], parentIds: [], childIds: ['C'] }),
      expect.objectContaining({ id: 'C', treeNumbers: ['C01.001', 'C02.001', 'C03.001'], parentIds: ['P'], childIds: [] }),
    ]));
    return result;
  });
  await fixture.invoke();
  expect(children).toHaveBeenCalledTimes(3);
  expect(children.mock.calls[0]![1].maxRetries).toBe(1);
});

test('シード取得中の停止は生成・最適化へ進めず、未実測の停止結果を保持する', async () => {
  const fixture = setup();
  const pending = deferred<SeedPaper[]>();
  fixture.list.mockReturnValue(pending.promise);
  const running = fixture.invoke();
  fixture.store.setState((s) => ({ ...s, queryOptimizationRun: { ...s.queryOptimizationRun!, stopRequested: true } }));
  pending.resolve([seed('11')]);
  await running;
  expect(fixture.buildFactory).not.toHaveBeenCalled();
  expect(fixture.run).not.toHaveBeenCalled();
  expect(fixture.store.getState().queryOptimizationRun).toMatchObject({ status: 'ready',
    result: { status: 'stopped', best: null, trials: [] } });
});


test('bootstrap のプロジェクト復元で完了 run と開始設定を明示的に消去する', async () => {
  const fixture = setup();
  await fixture.invoke();
  fixture.store.setState((s) => ({ ...s, queryOptimizationSetup: {
    projectId: 'p', status: 'ready', maxHits: '123', maxIterations: '2', seedCount: 1, error: null,
  } }));
  expect(fixture.store.getState().queryOptimizationRun?.status).toBe('ready');
  await switchProject(fixture);
  expect(fixture.store.getState().project?.projectId).toBe('other');
  expect(fixture.store.getState().queryOptimizationRun).toBeNull();
  expect(fixture.store.getState().queryOptimizationSetup).toBeNull();
});

test.each(['setState', 'setStateSilently'] as const)('汎用 store の %s は updater の結果をそのまま保持する', async (method) => {
  const fixture = setup();
  await fixture.invoke();
  const next = { ...fixture.store.getState(), project: { ...fixture.store.getState().project!, projectId: 'other' } };
  fixture.store[method](() => next);
  expect(fixture.store.getState()).toBe(next);
  expect(fixture.store.getState().queryOptimizationRun?.status).toBe('ready');
});

test.each(['setState', 'setStateSilently'] as const)('クリアを伴わない %s の切替でも owns が古い通知を拒否する', async (method) => {
  const fixture = setup();
  const pending = deferred<optimization.QueryOptimizationResult>();
  fixture.run.mockReturnValue(pending.promise);
  const running = fixture.invoke();
  await flush();
  fixture.store[method]((s) => ({ ...s, project: { ...s.project!, projectId: 'other' } }));
  const before = fixture.store.getState();
  const deps = fixture.run.mock.calls[0]![1];
  expect(deps.shouldStop!()).toBe(true);
  deps.onProgress!({ step: 'review', iterations: 9, bestTotalHits: 99, bestCapturedSeedCount: 1, trial: null });
  pending.resolve(result);
  await running;
  expect(fixture.store.getState()).toBe(before);
});


test('保存版なしでもメモ・指示・提案の手編集を保持し、下書きに対する AI 改善を実行する', async () => {
  const f = setup();
  jest.spyOn(seeds, 'listSeedPapersWithRows').mockResolvedValue([]);
  const pending = deferred<improveSkill.ImproveBlockProposal>();
  const improve = jest.spyOn(improveSkill, 'improveBlockExpression').mockReturnValue(pending.promise);
  const origin = { projectId: 'p', runId: 'optimization-run', model: 'optimization-model' };
  f.store.setState((s) => ({ ...s, currentFormulaVersionId: null, currentFormulaMarkdown: null,
    formulaEditDraft: { formulaVersionId: null, markdown: serializePubmedFormulaMd(formula), optimizationOrigin: origin } }));
  document.body.innerHTML = '<section id="app-content"></section>';
  const app = startApp(document, { store: f.store, runtime: f.runtime,
    getHash: () => '#/edit', onHashChange: () => () => undefined, setHash: jest.fn() });
  await flush();
  const type = (selector: string, value: string) => {
    const input = document.querySelector<HTMLTextAreaElement>(selector)!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
  };
  type('.edit__note-input', '手編集のメモ');
  document.querySelector<HTMLButtonElement>('.edit__block-improve')!.click();
  type('.edit__block-ai-instruction', '疾患名を限定');
  expect(f.store.getState().formulaEditNote).toEqual({ formulaVersionId: null, note: '手編集のメモ' });
  expect(f.store.getState().blockImprovementInstruction).toEqual({ formulaVersionId: null, blockId: '1', instruction: '疾患名を限定' });
  document.querySelector<HTMLButtonElement>('.edit__block-ai-submit')!.click();
  expect(f.store.getState().blockImprovement?.status).toBe('running');
  await flush();
  expect(improve).toHaveBeenCalledWith(expect.objectContaining({ currentExpression: 'a[tiab]', userInstruction: '疾患名を限定' }), undefined);
  pending.resolve({ proposedExpression: 'b[tiab]', rationale: '対象を限定' });
  await flush();
  expect(f.store.getState().blockImprovement).toMatchObject({ formulaVersionId: null, status: 'ready', error: null });
  type('.edit__block-ai-manual-edit-input', 'c[tiab]');
  expect(f.store.getState().blockImprovementManualEditDraft).toEqual({ formulaVersionId: null, blockId: '1', expression: 'c[tiab]' });
  f.store.setState((s) => ({ ...s }));
  expect(document.querySelector<HTMLTextAreaElement>('.edit__note-input')!.value).toBe('手編集のメモ');
  expect(document.querySelector<HTMLTextAreaElement>('.edit__block-ai-manual-edit-input')!.value).toBe('c[tiab]');
  document.querySelector<HTMLButtonElement>('.edit__block-ai-manual-edit-apply')!.click();
  expect(f.store.getState().formulaEditDraft?.markdown).toContain('c[tiab]');
  expect(f.store.getState().formulaEditDraft?.optimizationOrigin).toEqual(origin);
  app.dispose();
});

test.each(['', '1e400', 'seed-mismatch'])('入力不整合 %s は設定欄のエラーだけを表示し、最終レビューを作らない', async (value) => {
  const f = setup();
  if (value === 'seed-mismatch') f.list.mockResolvedValue([seed('11'), seed('22')]);
  document.body.innerHTML = '<section id="app-content"></section>';
  const app = startApp(document, { store: f.store, runtime: f.runtime,
    getHash: () => '#/draft', onHashChange: () => () => undefined, setHash: jest.fn() });
  await flush();
  const input = document.querySelector<HTMLInputElement>('.optimization__setup input')!;
  input.value = value === 'seed-mismatch' ? '1' : value;
  input.dispatchEvent(new Event('input'));
  document.querySelector<HTMLButtonElement>('.optimization__start')!.click();
  await flush();
  expect(f.store.getState().queryOptimizationRun).toBeNull();
  expect(f.store.getState().queryOptimizationSetup?.error).toBeTruthy();
  expect(document.querySelector('.optimization__review')).toBeNull();
  expect(document.querySelectorAll('.optimization__setup [role=alert]')).toHaveLength(1);
  expect(Array.from(document.querySelectorAll('[role=alert]')).filter((node) => node.textContent?.trim())).toHaveLength(1);
  expect(f.run).not.toHaveBeenCalled();
  app.dispose();
});

test('数値に変換済みの Infinity も run を作る前に拒否する', async () => {
  const f = setup();
  await f.invoke(Number('1e400'));
  expect(f.store.getState().queryOptimizationRun).toBeNull();
  expect(f.store.getState().queryOptimizationSetup?.error).toContain('正の整数');
  expect(f.list).not.toHaveBeenCalled();
});

test('自動調整の固定目安件数が初期式の生成プロンプトに届く', async () => {
  const f = setup();
  f.store.setState((s) => ({ ...s, currentFormulaMarkdown: null, currentFormulaVersionId: null }));
  const prompts: string[] = [];
  f.buildFactory.mockResolvedValue({ model: 'fake', forPurpose: (purpose) => ({
    model: 'fake', providerId: 'gemini', chat: async (messages) => {
      if (purpose === 'draft_block') prompts.push(messages.find((m) => m.role === 'user')!.content);
      return { text: JSON.stringify({ concept_summary: '概念', mesh_requirements: [], freeword_requirements: [],
        suggestions: [], freewords: [{ query: 'a[tiab]', rationale: '' }] }), tokensIn: null, tokensOut: null, raw: {} };
    },
  }) });
  await f.invoke(4321);
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain('目安であって上限ではない）: 4321');
  expect(f.run).toHaveBeenCalledWith(expect.objectContaining({ maxHits: 4321 }), expect.anything());
});

function setupOutside() {
  const f = setup();
  const measurement = { id: 'm', fingerprint: 'fp', measuredAt: '', totalHits: 10,
    capturedPmids: ['11'], missedPmids: [], blocks: [] };
  const best: optimization.VerifiedOptimizationCandidate = { formula: { ...formula,
    blocks: [{ id: '1', expression: 'best[tiab]', isCombination: false }] }, measurement,
    evaluation: { status: 'success', fingerprint: 'fp', measuredAt: '', seedPmids: ['11'], lineHits: [],
      finalQuery: { status: 'success', error: null, finalQuery: 'best[tiab]', totalHits: 10, captureRate: 1,
        capturedPmids: ['11'], missedPmids: [] } } };
  const completed: optimization.QueryOptimizationResult = { ...result, status: 'achieved', stopReason: 'conditions_met', best };
  f.run.mockResolvedValue(completed);
  const outside: expand.BoundaryCasesResult = { mode: 'margin', originalHits: 10, broadenedHits: 15, marginHits: 5,
    evaluatedCount: 5, additions: [], insideStrategy: null, specific: null,
    candidates: [{ pmid: '99', title: '外側の研究', year: 1990, abstract: '抄録', reason: '迷う理由', meshHeadings: [] }] };
  const search = jest.spyOn(expand, 'searchOutsideCandidates').mockResolvedValue(outside);
  return { ...f, completed, outside, search };
}

test.each(['achieved', 'needs_review'] as const)('%s の最良式で外側を調べ、全シード行を除外対象に渡す', async (status) => {
  const f = setupOutside();
  f.completed.status = status;
  f.list.mockResolvedValue([seed('11'), seed('22', { userDecision: 'maybe' }), seed('33', { userDecision: 'exclude' })]);
  const pending = deferred<expand.BoundaryCasesResult>();
  f.search.mockReturnValue(pending.promise);
  const running = f.invoke();
  await flush();
  expect(f.store.getState().queryOptimizationRun).toMatchObject({ status: 'running', result: f.completed,
    progress: { step: 'outside_check' }, outsideCheck: { status: 'running' } });
  expect(f.search).toHaveBeenCalledWith(expect.objectContaining({ formula: f.completed.best!.formula,
    researchQuestion: 'RQ', inclusionCriteria: '組入', exclusionCriteria: '除外', existingPmids: new Set(['11', '22', '33']) }));
  pending.resolve(f.outside);
  await running;
  expect(f.store.getState().queryOptimizationRun).toMatchObject({ status: 'ready', result: { status },
    outsideCheck: { status: 'ready', marginHits: 5, candidates: [{ pmid: '99', source: 'outside' }] } });
});

test.each(['stop', 'error'] as const)('外側の確認の %s は本体の条件達成と停止理由を変えない', async (kind) => {
  const f = setupOutside();
  const pending = deferred<expand.BoundaryCasesResult>();
  f.search.mockReturnValue(pending.promise);
  const running = f.invoke();
  await flush();
  if (kind === 'stop') {
    f.store.setState((s) => ({ ...s, queryOptimizationRun: { ...s.queryOptimizationRun!, stopRequested: true } }));
    pending.resolve(f.outside);
  } else pending.reject(new Error('探索失敗'));
  await running;
  expect(f.store.getState().queryOptimizationRun).toMatchObject({ status: 'ready',
    result: { status: 'achieved', stopReason: 'conditions_met' },
    outsideCheck: { status: kind === 'stop' ? 'skipped' : 'error',
      reason: kind === 'stop' ? 'ユーザーの停止要求で外側の確認を中止しました' : '探索失敗' } });
});

test.each(['stopped', 'error', 'no-best'] as const)('本体が %s のときは外側探索をスキップする', async (kind) => {
  const f = setupOutside();
  if (kind === 'no-best') f.completed.best = null;
  else f.completed.status = kind;
  await f.invoke();
  expect(f.search).not.toHaveBeenCalled();
  expect(f.store.getState().queryOptimizationRun?.outsideCheck?.status).toBe('skipped');
});

test.each(['ready', 'error'] as const)('探索 %s でも保留書誌は重複と全シード行を除外して残す', async (status) => {
  const f = setupOutside();
  f.list.mockResolvedValue([seed('11'), seed('22', { userDecision: 'exclude' })]);
  const held = { kind: 'proposal' as const, candidateId: 'candidate-1', formula, accepted: false, held: true,
    before: null, after: null, reason: '保留', rationale: '', apiEvents: [],
    impact: { lostHits: 150, gainedHits: 0, error: null,
      inspected: ['11', '22', '88', '88'].map((pmid) => ({ pmid, title: '失う研究', year: 2000 })) } };
  f.completed.trials = [held, { ...held, candidateId: 'candidate-2' }];
  if (status === 'error') f.search.mockRejectedValue(new Error('探索失敗'));
  await f.invoke();
  expect(f.store.getState().queryOptimizationRun?.outsideCheck?.candidates.filter((item) => item.source === 'lost'))
    .toEqual([{ pmid: '88', title: '失う研究', year: 2000, abstract: null, source: 'lost', reason: '',
      heldCandidateId: 'candidate-1', lostHits: 150 }]);
});

test.each(['project', 'run'] as const)('外側の探索中に %s が変わったら結果を書き込まない', async (kind) => {
  const f = setupOutside();
  const pending = deferred<expand.BoundaryCasesResult>();
  f.search.mockReturnValue(pending.promise);
  const running = f.invoke();
  await flush();
  f.store.setState((s) => kind === 'project' ? { ...s, project: null }
    : { ...s, queryOptimizationRun: { ...s.queryOptimizationRun!, runId: 'new' } });
  const before = f.store.getState();
  pending.resolve(f.outside);
  await running;
  expect(f.store.getState()).toBe(before);
});

test.each(['include', 'exclude', 'maybe'] as const)('判定 %s を saving → saved にし二重押しを無視する', async (decision) => {
  const f = setupOutside();
  await f.invoke();
  const pending = deferred<void>();
  const append = jest.spyOn(seeds, 'appendSeedPaper').mockReturnValue(pending.promise);
  const first = runDecideOutsideCandidate(f.store, f.runtime, '99', decision);
  expect(f.store.getState().queryOptimizationRun?.outsideCheck?.decisions['99']).toMatchObject({ status: 'saving', decision });
  await runDecideOutsideCandidate(f.store, f.runtime, '99', 'include');
  await flush();
  expect(append).toHaveBeenCalledTimes(1);
  expect(append).toHaveBeenCalledWith('s', expect.objectContaining({ pmid: '99', source: 'interactive',
    userDecision: decision, note: '迷う理由' }), f.runtime.google);
  pending.resolve();
  await first;
  expect(f.store.getState().queryOptimizationRun?.outsideCheck?.decisions['99']).toEqual({ status: 'saved', decision, error: null });
  await runDecideOutsideCandidate(f.store, f.runtime, '99', 'include');
  expect(append).toHaveBeenCalledTimes(1);
});

test('判定失敗は再試行でき、失う文献の理由に run と保留候補を記録する', async () => {
  const f = setupOutside();
  await f.invoke();
  const run = f.store.getState().queryOptimizationRun!;
  run.outsideCheck!.candidates[0] = { ...run.outsideCheck!.candidates[0]!, source: 'lost', heldCandidateId: 'candidate-1' };
  const append = jest.spyOn(seeds, 'appendSeedPaper').mockRejectedValueOnce(new Error('保存失敗')).mockResolvedValue();
  await runDecideOutsideCandidate(f.store, f.runtime, '99', 'maybe');
  expect(f.store.getState().queryOptimizationRun?.outsideCheck?.decisions['99']).toMatchObject({ status: 'error', error: '保存失敗' });
  await runDecideOutsideCandidate(f.store, f.runtime, '99', 'maybe');
  expect(append).toHaveBeenLastCalledWith('s', expect.objectContaining({ userDecision: 'maybe',
    note: `自動調整 run ${run.runId}: 保留候補 candidate-1 で失う文献` }), f.runtime.google);
  expect(f.store.getState().queryOptimizationRun?.outsideCheck?.decisions['99']?.status).toBe('saved');
});

test('include 保護再調整は最良式・同じ設定・更新シードを使い新しい runId で始まる', async () => {
  const f = setupOutside();
  await f.invoke();
  const old = f.store.getState().queryOptimizationRun!;
  old.outsideCheck!.decisions['99'] = { decision: 'include', status: 'saved', error: null };
  f.list.mockResolvedValue([seed('11'), seed('99', { userDecision: 'include', source: 'interactive' })]);
  await runReadjustOptimization(f.store, f.runtime, { google: f.runtime.google, store: f.runtime.store });
  expect(f.run).toHaveBeenCalledTimes(2);
  const input = f.run.mock.calls[1]![0];
  expect(input).toMatchObject({ initialFormula: old.result!.best!.formula, maxHits: old.maxHits,
    maxIterations: old.maxIterations, seedPmids: ['11', '99'] });
  expect(input.runId).not.toBe(old.runId);
  expect(input.resumeBudget).toBeUndefined();
});

test.each(['ready', 'error', 'skipped'] as const)('探索終了 %s と判定保存時に4区分を終了記録へ反映する', async (status) => {
  const f = setupOutside();
  f.run.mockImplementation(async (input) => {
    f.data.queryOptimizationCheckpoint = { projectId: 'p', runId: input.runId, maxHits: 123, savedAt: '', trials: [],
      completion: { status: 'achieved', stopReason: 'conditions_met', unmetReasons: [] } };
    if (status === 'skipped') f.store.setState((s) => ({ ...s, queryOptimizationRun: { ...s.queryOptimizationRun!, stopRequested: true } }));
    return f.completed;
  });
  if (status === 'error') f.search.mockRejectedValue(new Error('探索失敗'));
  await f.invoke();
  const current = f.store.getState().queryOptimizationRun!;
  expect((await checkpointService.getQueryOptimizationCheckpoint('p', f.runtime.store))?.completion?.reviewSections)
    .toEqual(buildOptimizationReviewSections(current).sections);
  if (status === 'ready') {
    jest.spyOn(seeds, 'appendSeedPaper').mockResolvedValue();
    await runDecideOutsideCandidate(f.store, f.runtime, '99', 'include');
    expect((await checkpointService.getQueryOptimizationCheckpoint('p', f.runtime.store))?.completion?.reviewSections)
      .toEqual(buildOptimizationReviewSections(f.store.getState().queryOptimizationRun!).sections);
    expect((await checkpointService.getQueryOptimizationCheckpoint('p', f.runtime.store))?.completion?.reviewSections?.[2]?.state).toBe('unmet');
  }
});

test('確認状況の保存失敗は警告し、最終レビューを維持する', async () => {
  const f = setupOutside();
  jest.spyOn(checkpointService, 'updateQueryOptimizationReviewSections').mockRejectedValue(new Error('保存失敗'));
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  await f.invoke();
  expect(warn).toHaveBeenCalledTimes(1);
  expect(f.store.getState().queryOptimizationRun).toMatchObject({ status: 'ready', outsideCheck: { status: 'ready' } });
});

test.each(['email', 'append'] as const)('判定の %s 待ちで run が切り替わっても古い結果を反映しない', async (phase) => {
  const f = setupOutside();
  await f.invoke();
  const pending = deferred<void>();
  const append = jest.spyOn(seeds, 'appendSeedPaper').mockImplementation(async () => { if (phase === 'append') await pending.promise; });
  f.runtime.profile.getProfileUserInfo = async () => {
    if (phase === 'email') await pending.promise;
    return { email: 'reviewer@example.test', id: 'reviewer' };
  };
  const saving = runDecideOutsideCandidate(f.store, f.runtime, '99', 'include');
  await flush();
  f.store.setState((s) => ({ ...s, queryOptimizationRun: { ...s.queryOptimizationRun!, runId: 'next' } }));
  const before = f.store.getState();
  pending.resolve();
  await saving;
  expect(f.store.getState()).toBe(before);
  expect(append).toHaveBeenCalledTimes(phase === 'email' ? 0 : 1);
});

test('保護再調整の開始式を渡した場合は初期生成の通知を引き継がない', async () => {
  const f = setup();
  f.store.setState((s) => ({ ...s, currentFormulaMarkdown: null }));
  const generate = jest.spyOn(draft, 'generateDraftFormula');
  await runOptimizeQuery(f.store, f.runtime, { google: f.runtime.google, store: f.runtime.store },
    { maxHits: 123, maxIterations: 2 }, undefined, formula);
  expect(generate).not.toHaveBeenCalled();
  expect(f.run.mock.calls[0]![0].initialFormula).toEqual(formula);
  expect(f.store.getState().queryOptimizationRun?.generationNotices).toBeUndefined();
});
