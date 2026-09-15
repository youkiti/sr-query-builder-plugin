import type { ProjectStoreDeps } from '@/features/project';
import { updateQueryOptimizationReviewSections } from './queryOptimizationCheckpointService';
import type { OptimizationReviewSection } from './queryOptimizationReviewSections';
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

test.each(['matching', 'run', 'project', 'incomplete', 'missing', 'ownership'] as const)('確認状況の差し替え: %s', async (kind) => {
  const { deps, options, data } = setup();
  if (kind !== 'missing') await saveQueryOptimizationCheckpoint({ ...options,
    ...(kind === 'incomplete' ? {} : { completion: { status: 'achieved' as const, stopReason: 'conditions_met' as const, unmetReasons: [] } }),
  }, deps);
  const before = data.queryOptimizationCheckpoint;
  const write = jest.spyOn(deps, 'write');
  const sections: OptimizationReviewSection[] = [{ key: 'outside_check', label: '外側の確認', state: 'decided', maybeCount: 1,
    lines: ['maybe で保存した候補 1 件は未確認として残ります'] }];
  await updateQueryOptimizationReviewSections(kind === 'project' ? 'other' : 'p', kind === 'run' ? 'other' : 'run', sections,
    deps, () => kind !== 'ownership');
  if (kind === 'matching') {
    expect(write).toHaveBeenCalledTimes(1);
    expect((await getQueryOptimizationCheckpoint('p', deps))?.completion?.reviewSections).toEqual(sections);
    expect(data.queryOptimizationCheckpoint).toMatchObject({ runId: 'run', completion: { status: 'achieved', stopReason: 'conditions_met' } });
  } else {
    expect(write).not.toHaveBeenCalled();
    expect(data.queryOptimizationCheckpoint).toBe(before);
  }
});

test('終了記録の区分にある maybeCount を保存して復元する', async () => {
  const { deps, options } = setup();
  const sections: OptimizationReviewSection[] = [{ key: 'outside_check', label: '外側の確認', state: 'decided', maybeCount: 1,
    lines: ['maybe で保存した候補 1 件は未確認として残ります'] }];
  await saveQueryOptimizationCheckpoint({ ...options,
    completion: { status: 'achieved', stopReason: 'conditions_met', unmetReasons: [], reviewSections: sections } }, deps);
  expect((await getQueryOptimizationCheckpoint('p', deps))?.completion?.reviewSections).toEqual(sections);
  sections[0]!.maybeCount = 2;
  expect((await getQueryOptimizationCheckpoint('p', deps))?.completion?.reviewSections?.[0]?.maybeCount).toBe(1);
});

test('保留と差集合件数だけを射影し、書誌は保存せず旧形式も復元する', async () => {
  const { data, deps, trial, options } = setup();
  const held = { ...trial, candidateId: 'candidate-1', accepted: false, held: true,
    impact: { lostHits: 150, gainedHits: 0, inspected: [{ pmid: '901', title: '研究', year: 2024 }], error: null } };
  const saved = await saveQueryOptimizationCheckpoint({ ...options, trials: [trial, held] }, deps);
  expect(saved.trials[0]).toMatchObject({ held: false, lostHits: null, gainedHits: null });
  expect(saved.trials[1]).toMatchObject({ held: true, lostHits: 150, gainedHits: 0 });
  expect(JSON.stringify(saved)).not.toContain('inspected');
  data['queryOptimizationCheckpoint'] = { ...saved, trials: saved.trials.map(({ held: _held, lostHits: _lost, gainedHits: _gained, ...old }) => old) };
  expect((await getQueryOptimizationCheckpoint('p', deps))?.trials[1]).not.toHaveProperty('lostHits');
});

test('単一キーに要約だけを保存し、復元は中断・要再検証を返す', async () => {
  const { data, deps, trial, options } = setup();
  const saved = await saveQueryOptimizationCheckpoint({ ...options, now: () => 'fixed-time' }, deps);
  expect(Object.keys(data)).toEqual(['queryOptimizationCheckpoint']);
  expect(saved.trials).toEqual([{ candidateId: 'initial', formula: trial.formula, totalHits: 0,
    capturedSeedCount: 0, accepted: true, held: false, lostHits: null, gainedHits: null, reason: '初期式', fingerprint: 'hash' }]);
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
    unmetReasons: ['目安件数 100 件を超えています（実測 120 件）', '未捕捉シード: 11'] };
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


test('抽出情報と実差分・重複 ID を複製して要約へ保存する', async () => {
  const { deps, trial, options } = setup();
  trial.impact = { lostHits: 1, gainedHits: 0, inspected: [], error: null,
    sample: { method: 'all', seed: 123, populationCount: 1, retrievedCount: 1,
      pmids: ['901'], sampledAt: '2026-09-15T00:00:00Z' } };
  trial.formulaDiff = [{ blockId: '1', added: ['b[tiab]'], removed: ['a[tiab]'] }];
  trial.duplicateOf = 'candidate-1';
  const saved = await saveQueryOptimizationCheckpoint(options, deps);
  expect(saved.trials[0]).toMatchObject({ sample: trial.impact.sample,
    formulaDiff: trial.formulaDiff, duplicateOf: 'candidate-1' });
  trial.impact.sample!.pmids.push('902');
  trial.formulaDiff[0]!.added.push('c[tiab]');
  expect(saved.trials[0]!.sample!.pmids).toEqual(['901']);
  expect(saved.trials[0]!.formulaDiff![0]!.added).toEqual(['b[tiab]']);
});
