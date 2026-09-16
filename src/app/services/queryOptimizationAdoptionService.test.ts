import { createStore, INITIAL_STATE, type QueryOptimizationRunState } from '../store';
import { adoptHeldOptimizationCandidate, adoptQueryOptimization, editQueryOptimization } from './queryOptimizationAdoptionService';
import { saveEditedFormula } from './editService';
import * as formulaRepository from '@/features/formula/formulaRepository';
import * as validationRepository from '@/features/validation/validationRepository';
import * as googleApi from '@/lib/google';
import { parsePubmedFormulaMd } from '@/lib/search-formula-md';
import { createEditView } from '../views/editView';
import { evaluateGuards } from '../guards';
import { buildOptimizationReviewSections } from './queryOptimizationReviewSections';
import { renderOptimizationReview } from '../views/queryOptimizationReview';

const md = '## PubMed/MEDLINE\n\n```\n#1 asthma[tiab]\n```\n';
function setup() {
  const formula = parsePubmedFormulaMd(md);
  const measurement = { id: 'r:final', fingerprint: 'fp', measuredAt: '2026-09-11T00:00:00Z',
    totalHits: 10, capturedPmids: ['1'], missedPmids: [], blocks: [] };
  const run: QueryOptimizationRunState = {
    runId: 'r', projectId: 'p', status: 'ready', maxHits: 20, maxIterations: 2, seedCount: 1,
    startedAtMs: 0, finishedAtMs: 1, stopRequested: false, error: null, meshContext: [],
    progress: { step: 'review', iterations: 1, bestTotalHits: 10, bestCapturedSeedCount: 1, trial: null },
    trials: [{ kind: 'initial', candidateId: 'initial', formula, accepted: true, reason: '初期', rationale: '',
      before: null, after: measurement, apiEvents: [] }],
    result: { status: 'achieved', stopReason: 'conditions_met', unmetReasons: [], iterations: 1, apiCalls: 2, elapsedMs: 1,
      trials: [], best: { formula, measurement, evaluation: { fingerprint: 'fp', measuredAt: measurement.measuredAt,
        status: 'success', seedPmids: ['1'], lineHits: [], finalQuery: { status: 'success', error: null,
          finalQuery: 'asthma[tiab]', totalHits: 10, captureRate: 1, capturedPmids: ['1'], missedPmids: [] } } } },
  };
  const store = createStore({ ...INITIAL_STATE, project: { projectId: 'p', spreadsheetId: 's', driveFolderId: 'd', title: '研究' },
    currentFormulaVersionId: 'parent', currentFormulaMarkdown: md, currentFormulaModel: 'model', queryOptimizationRun: run,
    protocolDraft: { frameworkType: 'pico', researchQuestion: 'RQ', inclusionCriteria: '組入', exclusionCriteria: '除外',
      studyDesign: '', sourceType: 'manual', sourceFilename: null, rawTextRef: null, rawTextInline: '本文', rawTextPreview: '' },
  });
  const google = { fetch: jest.fn(() => { throw new Error('外部通信は禁止'); }), getAccessToken: async () => 'fake' };
  const versions = new Map<string, formulaRepository.FormulaVersionRow>();
  versions.set('parent', { versionId: 'parent', parentVersionId: null, protocolVersion: 3, protocolSnapshotRef: 'snapshot',
    formulaMd: md, createdBy: 'ai_draft', createdAt: '', note: null, model: 'model' });
  jest.spyOn(formulaRepository, 'getFormulaVersionById').mockImplementation(async (_sheet, id) => versions.get(id) ?? null);
  const append = jest.spyOn(formulaRepository, 'appendFormulaVersion').mockImplementation(async (_sheet, row) => { versions.set(row.versionId, row); });
  const validation = jest.spyOn(validationRepository, 'appendValidationLog').mockResolvedValue();
  jest.spyOn(googleApi, 'getSheetValues').mockResolvedValue([]);
  jest.spyOn(googleApi, 'ensureChildFolder').mockResolvedValue({ id: 'folder', webViewLink: 'https://drive.example/folder' });
  const find = jest.spyOn(googleApi, 'findChildFile').mockResolvedValue(null);
  const upload = jest.spyOn(googleApi, 'uploadTextFile').mockResolvedValue({ id: 'log', webViewLink: 'https://drive.example/log' });
  return { store, google, run, versions, append, validation, find, upload };
}
afterEach(() => { jest.restoreAllMocks(); document.body.innerHTML = ''; });

test.each([true, false])('採用ログは現在の4区分と外側の確認（存在=%s）を保存する', async (present) => {
  const f = setup();
  if (present) f.run.outsideCheck = { status: 'ready', reason: null, originalHits: 10, marginHits: 0,
    evaluatedCount: 0, candidates: [], decisions: {} };
  await adoptQueryOptimization(f);
  const log = JSON.parse(f.upload.mock.calls[0]![0].content);
  expect(log.reviewSections).toEqual(buildOptimizationReviewSections(f.run).sections);
  expect(log.outsideCheck).toEqual(f.run.outsideCheck ?? null);
});

test('採用保存は親版・プロトコル・最終検証・実行ログを関連づけ、履歴を保持する', async () => {
  const f = setup();
  await adoptQueryOptimization(f);
  expect(f.append).toHaveBeenCalledWith('s', expect.objectContaining({ versionId: 'r', parentVersionId: 'parent',
    createdBy: 'auto_optimize', protocolVersion: 3, protocolSnapshotRef: 'snapshot', formulaMd: md,
    note: expect.stringContaining('https://drive.example/log') }), f.google);
  expect(f.validation).toHaveBeenCalledWith('s', expect.objectContaining({ versionId: 'r', validationId: 'r',
    captureRate: 1, totalHits: 10, capturedPmids: '1', detailRef: 'https://drive.example/log' }), f.google);
  const log = JSON.parse(f.upload.mock.calls[0]![0].content);
  expect(log.result.best.evaluation.fingerprint).toBe('fp');
  expect(f.store.getState().queryOptimizationRun?.trials).toBe(f.run.trials);
  expect(f.store.getState().queryOptimizationRun?.result).toBe(f.run.result);
  expect(f.store.getState().queryOptimizationRun?.save?.status).toBe('saved');
  expect(f.store.getState().currentFormulaCreatedBy).toBe('auto_optimize');
});

test('保存中の二重呼出しと保存済み run の再保存を防ぐ', async () => {
  const f = setup();
  const pending = adoptQueryOptimization(f);
  expect(f.store.getState().queryOptimizationRun?.save?.status).toBe('saving');
  await adoptQueryOptimization(f);
  await pending;
  await adoptQueryOptimization(f);
  expect(f.append).toHaveBeenCalledTimes(1);
  expect(f.validation).toHaveBeenCalledTimes(1);
});

test('版追記の応答喪失後も同じ run の版を照会して再追記しない', async () => {
  const f = setup();
  f.append.mockImplementationOnce(async (_sheet, row) => { f.versions.set(row.versionId, row); throw new Error('応答喪失'); });
  await adoptQueryOptimization(f);
  expect(f.store.getState().queryOptimizationRun?.save?.error).toBe('応答喪失');
  jest.mocked(formulaRepository.getFormulaVersionById).mockClear();
  await adoptQueryOptimization(f);
  expect(formulaRepository.getFormulaVersionById).toHaveBeenCalledTimes(1);
  expect(f.append).toHaveBeenCalledTimes(1);
  expect(f.store.getState().queryOptimizationRun?.save?.status).toBe('saved');
});

test('ログ保存失敗では版を追加せず、エラーを表示して再試行できる', async () => {
  const f = setup();
  f.upload.mockRejectedValueOnce(new Error('ログ保存失敗'));
  await adoptQueryOptimization(f);
  expect(f.append).not.toHaveBeenCalled();
  expect(f.store.getState().queryOptimizationRun?.save?.error).toBe('ログ保存失敗');
  await adoptQueryOptimization(f);
  expect(f.append).toHaveBeenCalledTimes(1);
});

test('保存中にプロジェクトを切り替えても遅い結果を適用しない', async () => {
  const f = setup();
  f.append.mockImplementationOnce(async () => { f.store.setState((s) => ({ ...s, project: null, queryOptimizationRun: null })); });
  await adoptQueryOptimization(f);
  expect(f.store.getState().queryOptimizationRun).toBeNull();
  expect(f.store.getState().currentFormulaVersionId).toBe('parent');
});

test('検証ログ追記の失敗後は既存の実行ログを再利用して採用保存する', async () => {
  const f = setup();
  f.validation.mockRejectedValueOnce(new Error('検証ログ保存失敗'));
  await adoptQueryOptimization(f);
  expect(f.store.getState().queryOptimizationRun?.save?.status).toBe('error');
  expect(f.upload).toHaveBeenCalledTimes(1);
  expect(f.append).not.toHaveBeenCalled();
  f.find.mockResolvedValue({ id: 'log', webViewLink: 'https://drive.example/log' });
  await adoptQueryOptimization(f);
  expect(f.find).toHaveBeenLastCalledWith('r.json', 'folder', f.google);
  expect(f.upload).toHaveBeenCalledTimes(1);
  expect(f.validation).toHaveBeenLastCalledWith('s', expect.objectContaining({ versionId: 'r',
    detailRef: 'https://drive.example/log' }), f.google);
  expect(f.append).toHaveBeenCalledWith('s', expect.objectContaining({ versionId: 'r',
    note: expect.stringContaining('https://drive.example/log') }), f.google);
  expect(f.store.getState().queryOptimizationRun?.save?.status).toBe('saved');
});

test('実行ログの照会失敗ではアップロードせず保存エラーにする', async () => {
  const f = setup();
  f.find.mockRejectedValueOnce(new Error('ログ照会失敗'));
  await adoptQueryOptimization(f);
  expect(f.upload).not.toHaveBeenCalled();
  expect(f.validation).not.toHaveBeenCalled();
  expect(f.append).not.toHaveBeenCalled();
  expect(f.store.getState().queryOptimizationRun?.save).toEqual({
    formulaVersionId: 'r', status: 'error', error: 'ログ照会失敗',
  });
  await adoptQueryOptimization(f);
  expect(f.upload).toHaveBeenCalledTimes(1);
  expect(f.store.getState().queryOptimizationRun?.save?.status).toBe('saved');
});

test.each([true, false])('編集導線は保存せず下書きを表示できる（親版あり=%s）', (hasParent) => {
  const f = setup();
  if (!hasParent) f.store.setState((s) => ({ ...s, currentFormulaVersionId: null, currentFormulaMarkdown: null }));
  expect(editQueryOptimization(f.store)).toBe(true);
  expect(f.store.getState().formulaEditDraft).toEqual({ formulaVersionId: hasParent ? 'parent' : null, markdown: md,
    optimizationOrigin: { projectId: 'p', runId: 'r', model: 'model' },
  });
  expect(evaluateGuards(f.store.getState()).edit.enabled).toBe(true);
  const container = document.createElement('div');
  createEditView()(container, { state: f.store.getState(), navigate: jest.fn() });
  expect(container.querySelector('.edit__block-current')?.textContent).toContain('asthma');
  expect(f.append).not.toHaveBeenCalled();
  expect(f.upload).not.toHaveBeenCalled();
  expect(f.store.getState().queryOptimizationRun).toBe(f.run);
});

test('従来の手編集保存は user_edit のまま', async () => {
  const f = setup();
  await saveEditedFormula({ formulaMd: md, note: '' }, { ...f, newUuid: () => 'edited' });
  expect(f.append).toHaveBeenCalledWith('s', expect.objectContaining({ createdBy: 'user_edit', parentVersionId: 'parent' }), f.google);
  expect(f.store.getState().currentFormulaCreatedBy).toBe('user_edit');
});

test('最終再検証の失敗は保持した候補の過去の成功値で隠さず保存する', async () => {
  const f = setup();
  const result = f.run.result!;
  const best = result.best!;
  result.status = 'error';
  result.trials = [{ kind: 'final', candidateId: 'final-1', formula: best.formula, accepted: false,
    reason: '最終再検証の取得失敗', rationale: '', before: best.measurement,
    after: { ...best.measurement, measuredAt: '2026-09-11T01:00:00Z', totalHits: null, capturedPmids: null, missedPmids: null }, apiEvents: [] }];
  await adoptQueryOptimization(f);
  expect(f.validation).toHaveBeenCalledWith('s', expect.objectContaining({ totalHits: null, captureRate: null,
    capturedPmids: null, executedAt: '2026-09-11T01:00:00Z' }), f.google);
});

test('版追記だけの失敗後は検証ログを再追記しない', async () => {
  const f = setup();
  f.append.mockRejectedValueOnce(new Error('版保存失敗'));
  await adoptQueryOptimization(f);
  expect(f.store.getState().queryOptimizationRun?.save?.status).toBe('error');
  f.find.mockResolvedValue({ id: 'log', webViewLink: 'https://drive.example/log' });
  jest.mocked(googleApi.getSheetValues).mockResolvedValue([['validation_id'], ['r']]);
  await adoptQueryOptimization(f);
  expect(f.upload).toHaveBeenCalledTimes(1);
  expect(f.append).toHaveBeenLastCalledWith('s', expect.objectContaining({
    note: expect.stringContaining('https://drive.example/log') }), f.google);
  expect(f.validation).toHaveBeenCalledTimes(1);
  expect(f.store.getState().queryOptimizationRun?.save?.status).toBe('saved');
});

test('親版のない下書きも手編集保存は user_edit として初回版を作る', async () => {
  const f = setup();
  f.store.setState((s) => ({ ...s, currentFormulaVersionId: null, currentFormulaMarkdown: null }));
  editQueryOptimization(f.store);
  await saveEditedFormula({ formulaMd: f.store.getState().formulaEditDraft!.markdown, note: '' }, { ...f, newUuid: () => 'first' });
  expect(f.append).toHaveBeenCalledWith('s', expect.objectContaining({ parentVersionId: null, createdBy: 'user_edit', protocolSnapshotRef: '本文' }), f.google);
});


test.each([null, 'parent'])('編集保存は自動調整のモデルとrunを引き継ぎ、user_editのままにする（親版=%s）', async (parent) => {
  const f = setup();
  f.run.inputSnapshot = { researchQuestion: 'RQ', inclusionCriteria: '', exclusionCriteria: '',
    blocks: { blocks: [], combinationExpression: '' }, seedPmids: ['1'], model: 'optimization-model' };
  f.store.setState((s) => ({ ...s, currentFormulaVersionId: parent, currentFormulaMarkdown: parent ? md : null,
    currentFormulaModel: parent ? 'older-model' : null }));
  editQueryOptimization(f.store);
  expect(f.append).not.toHaveBeenCalled();
  expect(f.upload).not.toHaveBeenCalled();
  await saveEditedFormula({ formulaMd: md, note: '人による変更' }, { ...f, newUuid: () => 'edited' });
  expect(f.append).toHaveBeenCalledWith('s', expect.objectContaining({ createdBy: 'user_edit', parentVersionId: parent,
    model: 'optimization-model', note: '人による変更\n自動調整 run: r から編集' }), f.google);
  expect(f.store.getState().currentFormulaModel).toBe('optimization-model');
});

test.each(['project', 'version'])('対応しない編集下書きの由来を保存へ混入しない: %s', async (mismatch) => {
  const f = setup();
  f.store.setState((s) => ({ ...s, formulaEditDraft: {
    formulaVersionId: mismatch === 'version' ? 'other' : 'parent', markdown: md,
    optimizationOrigin: { projectId: mismatch === 'project' ? 'other' : 'p', runId: 'other-run', model: 'other-model' },
  } }));
  await saveEditedFormula({ formulaMd: md, note: '' }, { ...f, newUuid: () => 'edited' });
  expect(f.append).toHaveBeenCalledWith('s', expect.objectContaining({ model: 'model', note: null }), f.google);
});

test.each([true, false])('採用ログは初期生成の通知を保存し、無ければ null にする（存在=%s）', async (present) => {
  const f = setup();
  if (present) f.run.generationNotices = {
    filterNotice: '研究デザインに RCT 以外を含むため RCT フィルタを付けませんでした',
    parenthesizedTerms: [{ blockIndex: 0, blockId: '1', blockLabel: '疾患', term: 'a AND b' }],
    removedMeshHeadings: [{ blockIndex: 0, blockId: '1', blockLabel: '疾患', descriptor: 'Unknown' }],
    replacedMeshHeadings: [{ blockIndex: 0, blockId: '1', blockLabel: '疾患', from: '旧見出し', to: ['正式見出し'] }],
  };
  await adoptQueryOptimization(f);
  const log = JSON.parse(f.upload.mock.calls[0]![0].content);
  expect(log.generationNotices).toEqual(f.run.generationNotices ?? null);
});

// --- 保留候補の採用（issue #172）------------------------------------------------------------
function heldTrial(overrides: Partial<NonNullable<QueryOptimizationRunState['trials']>[number]> = {}) {
  const heldFormula = parsePubmedFormulaMd('## PubMed/MEDLINE\n\n```\n#1 asthma[tiab] OR wheeze[tiab]\n```\n');
  return {
    kind: 'proposal' as const, candidateId: 'candidate-1', formula: heldFormula, accepted: false, held: true,
    reason: '失う集合のためレビュー候補に留めました', rationale: '同義語で広げる', apiEvents: [],
    before: null,
    after: { id: 'candidate-1:after', fingerprint: 'held-fp', measuredAt: '2026-09-12T00:00:00Z',
      totalHits: 12, capturedPmids: ['1'], missedPmids: [], blocks: [] },
    impact: { lostHits: 2, gainedHits: 3, error: null,
      inspected: [{ pmid: '2', title: '研究2', year: 2001 }, { pmid: '3', title: '研究3', year: 2002 }],
      sample: { method: 'all' as const, seed: 1, populationCount: 2, retrievedCount: 2,
        pmids: ['2', '3'], sampledAt: '2026-09-12T00:00:00Z' } },
    ...overrides,
  };
}
function lostCandidates(pmids: readonly string[], decision: 'exclude' | 'maybe' = 'exclude') {
  return {
    candidates: pmids.map((pmid) => ({ pmid, title: null, year: null, abstract: null,
      source: 'lost' as const, heldCandidateId: 'candidate-1', reason: '' })),
    decisions: Object.fromEntries(pmids.map((pmid) => [pmid, { decision, status: 'saved' as const, error: null }])),
  };
}

test('ゲートを満たす保留候補は auto_optimize として保存され、未確認件数が監査記録に残る', async () => {
  const f = setup();
  f.run.trials.push(heldTrial());
  f.run.outsideCheck = { status: 'ready', reason: null, originalHits: 10, marginHits: 0, evaluatedCount: 0,
    ...lostCandidates(['2', '3']) };
  await adoptHeldOptimizationCandidate(f, 'candidate-1');
  expect(f.append).toHaveBeenCalledWith('s', expect.objectContaining({ versionId: 'r-held-candidate-1', createdBy: 'auto_optimize',
    formulaMd: expect.stringContaining('wheeze'), note: expect.stringContaining('保留候補 candidate-1') }), f.google);
  const log = JSON.parse(f.upload.mock.calls[0]![0].content);
  expect(log.heldAdoption).toEqual({ candidateId: 'candidate-1', lostHits: 2, judgedCount: 2, unconfirmedCount: 0, sampleMethod: 'all' });
  expect(f.store.getState().queryOptimizationRun?.save).toMatchObject({ status: 'saved',
    target: { kind: 'held', candidateId: 'candidate-1' } });
  expect(f.store.getState().currentFormulaVersionId).toBe('r-held-candidate-1');
  expect(f.store.getState().currentFormulaCreatedBy).toBe('auto_optimize');
});

test('未確認件数が残る監査記録も「見たから安全」とは書かない', async () => {
  const f = setup();
  f.run.trials.push(heldTrial({ impact: { lostHits: 200, gainedHits: 1, error: null,
    inspected: [{ pmid: '2', title: null, year: null }, { pmid: '3', title: null, year: null }],
    sample: { method: 'retrieved_subset', seed: 1, populationCount: 200, retrievedCount: 20,
      pmids: ['2', '3'], sampledAt: 't' } } }));
  f.run.outsideCheck = { status: 'ready', reason: null, originalHits: 10, marginHits: 0, evaluatedCount: 0,
    ...lostCandidates(['2', '3']) };
  await adoptHeldOptimizationCandidate(f, 'candidate-1');
  expect(f.append).toHaveBeenCalledTimes(1);
  const note = f.append.mock.calls[0]![1].note as string;
  expect(note).toContain('未確認 198 件');
  expect(note).not.toContain('安全');
  const log = JSON.parse(f.upload.mock.calls[0]![0].content);
  expect(log.heldAdoption).toEqual({ candidateId: 'candidate-1', lostHits: 200, judgedCount: 2, unconfirmedCount: 198, sampleMethod: 'retrieved_subset' });
});

test('ゲート未達の保留候補（失う集合を全件確認していない）は保存しない', async () => {
  const f = setup();
  f.run.trials.push(heldTrial({ impact: { lostHits: 50, gainedHits: 1, error: null,
    inspected: [{ pmid: '2', title: null, year: null }] } }));
  await adoptHeldOptimizationCandidate(f, 'candidate-1');
  expect(f.upload).not.toHaveBeenCalled();
  expect(f.append).not.toHaveBeenCalled();
  expect(f.store.getState().queryOptimizationRun?.save).toBeUndefined();
});

test('未判定の既知シードが失う集合にあれば採用保存も監査ファイル作成も行わない', async () => {
  const f = setup();
  f.run.trials.push(heldTrial());
  f.run.outsideCheck = { status: 'ready', reason: null, originalHits: 10, marginHits: 0, evaluatedCount: 0,
    ...lostCandidates(['2', '3']), unjudgedSeedPmids: ['2'] };
  delete f.run.outsideCheck.decisions['2'];
  await adoptHeldOptimizationCandidate(f, 'candidate-1');
  expect(f.upload).not.toHaveBeenCalled();
  expect(f.append).not.toHaveBeenCalled();
  expect(f.store.getState().queryOptimizationRun?.save).toBeUndefined();
});

test('最良候補が回収したシードを失う保留候補は保存しない', async () => {
  const f = setup();
  f.run.trials.push(heldTrial());
  f.run.result!.best!.measurement.capturedPmids!.push('999');
  f.run.outsideCheck = { status: 'ready', reason: null, originalHits: 10, marginHits: 0, evaluatedCount: 0,
    ...lostCandidates(['2', '3']) };
  await adoptHeldOptimizationCandidate(f, 'candidate-1');
  expect(f.upload).not.toHaveBeenCalled();
  expect(f.append).not.toHaveBeenCalled();
});

test.each(['best', 'held'] as const)('回帰2: %s の保存応答喪失後に対象を切り替えても前回の採用を確定する', async (first) => {
  const f = setup();
  f.run.trials.push(heldTrial());
  f.run.outsideCheck = { status: 'ready', reason: null, originalHits: 10, marginHits: 0, evaluatedCount: 0,
    ...lostCandidates(['2', '3']) };
  f.append.mockImplementationOnce(async (_sheet, row) => { f.versions.set(row.versionId, row); throw new Error('応答喪失'); });
  if (first === 'best') await adoptQueryOptimization(f);
  else await adoptHeldOptimizationCandidate(f, 'candidate-1');
  expect(f.store.getState().queryOptimizationRun?.save?.status).toBe('error');
  jest.mocked(formulaRepository.getFormulaVersionById).mockClear();
  if (first === 'best') await adoptHeldOptimizationCandidate(f, 'candidate-1');
  else await adoptQueryOptimization(f);
  const versionId = first === 'best' ? 'r' : 'r-held-candidate-1';
  expect(formulaRepository.getFormulaVersionById).toHaveBeenCalledTimes(1);
  expect(formulaRepository.getFormulaVersionById).toHaveBeenCalledWith('s', versionId, f.google);
  expect(f.append).toHaveBeenCalledTimes(1);
  expect(f.upload).toHaveBeenCalledTimes(1);
  expect(f.validation).toHaveBeenCalledTimes(1);
  const savedRun = f.store.getState().queryOptimizationRun!;
  expect(savedRun.save).toMatchObject({ status: 'saved', formulaVersionId: versionId });
  expect(f.store.getState().currentFormulaVersionId).toBe(versionId);
  const container = document.createElement('div');
  renderOptimizationReview(container, savedRun, { adopt: undefined, edit: undefined, blocks: undefined });
  expect(container.textContent).toContain(`${first === 'best' ? '最良候補' : '保留候補 candidate-1 の式'}を採用して保存しました`);
});

test('対象切替時の前回版照会が失敗しても前回 ID を保持し、再試行で二重保存しない', async () => {
  const f = setup();
  f.run.trials.push(heldTrial());
  f.run.outsideCheck = { status: 'ready', reason: null, originalHits: 10, marginHits: 0, evaluatedCount: 0,
    ...lostCandidates(['2', '3']) };
  f.append.mockImplementationOnce(async (_sheet, row) => { f.versions.set(row.versionId, row); throw new Error('応答喪失'); });
  await adoptQueryOptimization(f);
  jest.mocked(formulaRepository.getFormulaVersionById).mockRejectedValueOnce(new Error('照会失敗'));
  await adoptHeldOptimizationCandidate(f, 'candidate-1');
  expect(f.store.getState().queryOptimizationRun?.save).toMatchObject({ status: 'error', formulaVersionId: 'r' });
  await adoptHeldOptimizationCandidate(f, 'candidate-1');
  expect(f.append).toHaveBeenCalledTimes(1);
  expect(f.store.getState().queryOptimizationRun?.save).toMatchObject({ status: 'saved', formulaVersionId: 'r' });
});

test('除外済みの保留候補は、除外を取り消すまで採用できない', async () => {
  const f = setup();
  f.run.trials.push(heldTrial());
  f.run.outsideCheck = { status: 'ready', reason: null, originalHits: 10, marginHits: 0, evaluatedCount: 0,
    ...lostCandidates(['2', '3']) };
  f.run.heldRejections = { 'candidate-1': { rejectedAt: '2026-09-12T00:00:00Z' } };
  await adoptHeldOptimizationCandidate(f, 'candidate-1');
  expect(f.upload).not.toHaveBeenCalled();
  delete f.run.heldRejections['candidate-1'];
  await adoptHeldOptimizationCandidate(f, 'candidate-1');
  expect(f.upload).toHaveBeenCalledTimes(1);
});

test('最良候補と保留候補の採用は run につき 1 回で排他になる', async () => {
  const f = setup();
  f.run.trials.push(heldTrial());
  f.run.outsideCheck = { status: 'ready', reason: null, originalHits: 10, marginHits: 0, evaluatedCount: 0,
    candidates: [], decisions: {} };
  await adoptQueryOptimization(f);
  expect(f.store.getState().queryOptimizationRun?.save?.status).toBe('saved');
  expect(f.store.getState().queryOptimizationRun?.save).not.toHaveProperty('target');
  await adoptHeldOptimizationCandidate(f, 'candidate-1');
  expect(f.upload).toHaveBeenCalledTimes(1);
  expect(f.store.getState().currentFormulaCreatedBy).toBe('auto_optimize');
  expect(f.store.getState().currentFormulaMarkdown).toBe(md);
});


test.each(['best', 'held'] as const)('版保存失敗後に %s から別の保留候補へ切り替えると監査と実測値も切り替わる', async (first) => {
  const f = setup();
  f.run.trials.push(heldTrial(), heldTrial({ candidateId: 'candidate-2' }));
  f.run.outsideCheck = { status: 'ready', reason: null, originalHits: 10, marginHits: 0, evaluatedCount: 0,
    ...lostCandidates(['2', '3']) };
  const files = new Map<string, { id: string; webViewLink: string }>();
  f.find.mockImplementation(async (name) => files.get(name) ?? null);
  f.upload.mockImplementation(async (file) => { const saved = { id: file.name, webViewLink: `https://drive.example/${file.name}` }; files.set(file.name, saved); return saved; });
  const rows: string[][] = [['validation_id']];
  jest.mocked(googleApi.getSheetValues).mockImplementation(async () => rows);
  f.validation.mockImplementation(async (_sheet, row) => { rows.push([row.validationId]); });
  f.append.mockRejectedValueOnce(new Error('版保存失敗')).mockRejectedValueOnce(new Error('版保存失敗'));
  if (first === 'best') await adoptQueryOptimization(f);
  else await adoptHeldOptimizationCandidate(f, 'candidate-1');
  await adoptHeldOptimizationCandidate(f, 'candidate-2');
  await adoptHeldOptimizationCandidate(f, 'candidate-2');
  expect(f.upload).toHaveBeenCalledTimes(2);
  expect(f.validation).toHaveBeenCalledTimes(2);
  expect(files.size).toBe(2);
  expect(JSON.parse(f.upload.mock.calls[1]![0].content).heldAdoption.candidateId).toBe('candidate-2');
  expect(f.validation.mock.calls[1]![1]).toMatchObject({ versionId: 'r-held-candidate-2', totalHits: 12 });
  expect(f.store.getState().currentFormulaVersionId).toBe('r-held-candidate-2');
});
