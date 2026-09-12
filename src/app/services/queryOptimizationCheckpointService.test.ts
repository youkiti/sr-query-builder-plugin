import type { ProjectStoreDeps } from '@/features/project';
import { createStore, INITIAL_STATE, type BlocksDraft, type ProtocolDraft } from '../store';
import type { OptimizationTrial } from '@/features/formula/skills/optimizeQuery';
import { saveQueryOptimizationCheckpoint, getQueryOptimizationCheckpoint, clearQueryOptimizationCheckpoint, getQueryOptimizationResumeAvailability, createQueryOptimizationInputIdentity, type OptimizationResumeData } from './queryOptimizationCheckpointService';

function setup() {
  const data: Record<string, unknown> = {};
  const deps: ProjectStoreDeps = {
    read: async <T>(key: string) => data[key] as T | undefined,
    write: async (items) => { Object.assign(data, items); },
  };
  const trial: OptimizationTrial = {
    kind: 'initial', apiEvents: [],
    candidateId: 'initial', formula: { blocks: [{ id: '1', expression: 'a[tiab]', isCombination: false }], combinationExpression: null },
    accepted: true, reason: '初期式', rationale: 'AI 文脈は保存しない', before: null,
    after: { id: 'measurement', fingerprint: 'hash', measuredAt: 'date', totalHits: 0,
      capturedPmids: [], missedPmids: ['11'], blocks: [], terms: [{ blockId: '1', query: 'a[tiab]', hits: 0, delta: 0 }] },
  };
  const resume: OptimizationResumeData = { bestFormula: trial.formula, inputIdentity: 'same-input',
    limits: { apiCalls: 200, elapsedMs: 600000, evaluatedTrials: 5 },
    consumed: { apiCalls: 120, elapsedMs: 300000, evaluatedTrials: 2 }, previousRejectedTrials: [] };
  const options = { projectId: 'p', runId: 'run', maxHits: 100, trials: [trial], resume };
  return { data, deps, trial, options };
}

test('最新キーだけに要約を保存し、復元は中断・要再検証を返す', async () => {
  const { data, deps, trial, options } = setup();
  const saved = await saveQueryOptimizationCheckpoint({ ...options, now: () => 'fixed-time' }, deps);
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
  const { deps, options } = setup();
  expect(await getQueryOptimizationCheckpoint('p', deps)).toBeNull();
  await saveQueryOptimizationCheckpoint(options, deps);
  expect(await getQueryOptimizationCheckpoint('other', deps)).toBeNull();
  await clearQueryOptimizationCheckpoint(deps);
  expect(await getQueryOptimizationCheckpoint('p', deps)).toBeNull();
});

test('最新キーを更新しても state の復元ログを保持し、新しい未測定値は null にする', async () => {
  const { data, deps, trial, options } = setup();
  await saveQueryOptimizationCheckpoint({ ...options, runId: 'old' }, deps);
  const store = createStore({ ...INITIAL_STATE, queryOptimizationSetup: {
    projectId: 'p', status: 'ready', maxHits: '100', maxIterations: '5', seedCount: 1, error: null,
    checkpoint: await getQueryOptimizationCheckpoint('p', deps),
  } });
  trial.after = null;
  const saved = await saveQueryOptimizationCheckpoint({ ...options, runId: 'new', maxHits: 50 }, deps);
  expect(saved.savedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect((await getQueryOptimizationCheckpoint('p', deps))?.runId).toBe('new');
  expect(Object.keys(data)).toEqual(['queryOptimizationCheckpoint']);
  expect(store.getState().queryOptimizationSetup?.checkpoint).toMatchObject({ runId: 'old',
    trials: [{ formula: trial.formula, totalHits: 0, capturedSeedCount: 0 }] });
  expect(saved.trials[0]).toMatchObject({ totalHits: null, capturedSeedCount: null, fingerprint: null });
});

test('保存失敗を呼び出し側へ返す', async () => {
  const { deps, options } = setup();
  deps.write = async () => { throw new Error('容量不足'); };
  await expect(saveQueryOptimizationCheckpoint(options, deps)).rejects.toThrow('容量不足');
});

test('終了状態・理由・未達理由を要約へ保存し、完了済みでも再検証を要求する', async () => {
  const { deps, options } = setup();
  const completion = { status: 'needs_review' as const, stopReason: 'revalidation_failed' as const,
    unmetReasons: ['最大件数 100 件を超えています（実測 120 件）', '未捕捉シード: 11'] };
  const saved = await saveQueryOptimizationCheckpoint({ ...options, now: () => 'finished-at', completion }, deps);
  completion.unmetReasons.push('変更後');
  expect(saved.completion!.unmetReasons).toHaveLength(2);
  expect(await getQueryOptimizationCheckpoint('p', deps)).toEqual({ ...saved,
    status: 'completed', needsRevalidation: true });
  expect(await getQueryOptimizationCheckpoint('other', deps)).toBeNull();
  expect(saved).not.toHaveProperty('measurement');
  expect(saved.trials[0]).not.toHaveProperty('terms');
});

test('新しい実行の途中保存では前回の終了記録を持ち越さない', async () => {
  const { deps, options } = setup();
  await saveQueryOptimizationCheckpoint({ ...options, runId: 'old',
    completion: { status: 'achieved', stopReason: 'conditions_met', unmetReasons: [] } }, deps);
  await saveQueryOptimizationCheckpoint({ ...options, runId: 'new' }, deps);
  expect(await getQueryOptimizationCheckpoint('p', deps)).toMatchObject({ runId: 'new', status: 'interrupted', needsRevalidation: true });
  expect(await getQueryOptimizationCheckpoint('p', deps)).not.toHaveProperty('completion');
});

test('最良候補は最後の採用試行と独立して保存し、残予算を3種類とも差し引く', async () => {
  const { deps, options } = setup();
  options.resume.bestFormula = { blocks: [{ id: '1', expression: 'best[tiab]', isCombination: false }], combinationExpression: null };
  const saved = await saveQueryOptimizationCheckpoint(options, deps);
  expect(saved.resume?.bestFormula?.blocks[0]?.expression).toBe('best[tiab]');
  expect(saved.trials[0]?.formula.blocks[0]?.expression).toBe('a[tiab]');
  expect(getQueryOptimizationResumeAvailability(saved, 'same-input')).toMatchObject({ available: true,
    remaining: { apiCalls: 80, elapsedMs: 300000, evaluatedTrials: 3 } });
  options.resume.consumed.apiCalls = 199;
  expect(saved.resume?.consumed.apiCalls).toBe(120);
});

test.each(['apiCalls', 'elapsedMs', 'evaluatedTrials'] as const)('%s の残予算がゼロ以下なら再開させない', async (key) => {
  const { deps, options } = setup();
  for (const extra of [0, 1]) {
    options.resume.consumed[key] = options.resume.limits[key] + extra;
    const saved = await saveQueryOptimizationCheckpoint(options, deps);
    expect(getQueryOptimizationResumeAvailability(saved, 'same-input')).toEqual({ available: false,
      reason: expect.stringContaining('予算を使い切っている') });
  }
});

test('完了・旧形式・最良候補なし・入力不一致・不正な予算では理由付きで再開を拒否する', async () => {
  const { deps, options } = setup();
  const saved = await saveQueryOptimizationCheckpoint(options, deps);
  const check = getQueryOptimizationResumeAvailability;
  expect(check({ ...saved, completion: { status: 'achieved', stopReason: 'conditions_met', unmetReasons: [] } }, 'same-input'))
    .toMatchObject({ available: false, reason: 'この実行は終了しています。' });
  expect(check({ ...saved, resume: undefined }, 'same-input')).toMatchObject({ available: false, reason: expect.stringContaining('記録がありません') });
  expect(check({ ...saved, resume: { ...options.resume, bestFormula: null } }, 'same-input')).toMatchObject({ available: false });
  expect(check(saved, null)).toMatchObject({ available: false, reason: expect.stringContaining('入力を確認できません') });
  expect(check(saved, 'changed')).toMatchObject({ available: false, reason: expect.stringContaining('変わっている') });
  options.resume.consumed.apiCalls = -1;
  expect(check({ ...saved, resume: options.resume }, 'same-input')).toMatchObject({ available: false, reason: expect.stringContaining('不正') });
});

test('入力指標は改行・外側の空白・シード集合の順序を正規化し、承認内容の変更は区別する', () => {
  const protocol: ProtocolDraft = { frameworkType: 'pico', researchQuestion: 'RQ\nnext', inclusionCriteria: '組入', exclusionCriteria: '除外',
    studyDesign: 'RCT', sourceType: 'manual', sourceFilename: null, rawTextRef: null, rawTextPreview: '', rawTextInline: '' };
  const blocks: BlocksDraft = { blocks: [{ blockLabel: '疾患', description: '説明', note: '', aiGenerated: false }],
    combinationExpression: '#1', selectedFilterIds: ['RCTfilter', 'Other'] };
  const identity = createQueryOptimizationInputIdentity(protocol, blocks, ['22', '11', '11'], 100);
  expect(createQueryOptimizationInputIdentity({ ...protocol, researchQuestion: ' RQ\r\nnext ' },
    { ...blocks, selectedFilterIds: ['Other', 'RCTfilter'] }, ['11', '22'], 100)).toBe(identity);
  for (const field of ['researchQuestion', 'inclusionCriteria', 'exclusionCriteria', 'studyDesign', 'frameworkType'] as const) {
    expect(createQueryOptimizationInputIdentity({ ...protocol, [field]: '変更' }, blocks, ['11', '22'], 100)).not.toBe(identity);
  }
  for (const field of ['blockLabel', 'description', 'note'] as const) {
    expect(createQueryOptimizationInputIdentity(protocol, { ...blocks, blocks: [{ ...blocks.blocks[0]!, [field]: '変更' }] }, ['11', '22'], 100)).not.toBe(identity);
  }
  expect(createQueryOptimizationInputIdentity(protocol, { ...blocks, combinationExpression: '#1 AND #2' }, ['11', '22'], 100)).not.toBe(identity);
  expect(createQueryOptimizationInputIdentity(protocol, { ...blocks, selectedFilterIds: [] }, ['11', '22'], 100)).not.toBe(identity);
  expect(createQueryOptimizationInputIdentity(protocol, blocks, ['11'], 100)).not.toBe(identity);
  expect(createQueryOptimizationInputIdentity(protocol, blocks, ['11', '22'], 101)).not.toBe(identity);
});
