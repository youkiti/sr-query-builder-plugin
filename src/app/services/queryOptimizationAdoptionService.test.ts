import { createStore, INITIAL_STATE, type QueryOptimizationRunState } from '../store';
import { adoptQueryOptimization, editQueryOptimization } from './queryOptimizationAdoptionService';
import { saveEditedFormula } from './editService';
import * as formulaRepository from '@/features/formula/formulaRepository';
import * as validationRepository from '@/features/validation/validationRepository';
import * as googleApi from '@/lib/google';
import { parsePubmedFormulaMd } from '@/lib/search-formula-md';
import { createEditView } from '../views/editView';
import { evaluateGuards } from '../guards';

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
  const upload = jest.spyOn(googleApi, 'uploadTextFile').mockResolvedValue({ id: 'log', webViewLink: 'https://drive.example/log' });
  return { store, google, run, versions, append, validation, upload };
}
afterEach(() => { jest.restoreAllMocks(); document.body.innerHTML = ''; });

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
  await adoptQueryOptimization(f);
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

test.each([true, false])('編集導線は保存せず下書きを表示できる（親版あり=%s）', (hasParent) => {
  const f = setup();
  if (!hasParent) f.store.setState((s) => ({ ...s, currentFormulaVersionId: null, currentFormulaMarkdown: null }));
  expect(editQueryOptimization(f.store)).toBe(true);
  expect(f.store.getState().formulaEditDraft).toEqual({ formulaVersionId: hasParent ? 'parent' : null, markdown: md });
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
  jest.mocked(googleApi.getSheetValues).mockResolvedValue([['validation_id'], ['r']]);
  await adoptQueryOptimization(f);
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
