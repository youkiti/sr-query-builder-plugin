import { appendFormulaVersion, getFormulaVersionById } from '@/features/formula';
import { appendValidationLog } from '@/features/validation';
import { ensureChildFolder, findChildFile, getSheetValues, uploadTextFile } from '@/lib/google';
import { serializePubmedFormulaMd } from '@/lib/search-formula-md';
import { nowIso } from '@/utils/iso8601';
import { resolveProtocolContext, type EditServiceDeps } from './editService';
import type { AppStore, FormulaSaveState } from '../store';

/** 採用の意思表示はこの入口だけで受け、途中の候補を正式版にしない。 */
export async function adoptQueryOptimization(deps: EditServiceDeps): Promise<void> {
  const state = deps.store.getState();
  const run = state.queryOptimizationRun;
  const project = state.project;
  const result = run?.result;
  const best = result?.best;
  if (!project || !run || run.projectId !== project.projectId || run.status === 'running' || !best
    || run.save?.status === 'saving' || run.save?.status === 'saved') return;
  // runId は実行開始時の UUID。応答喪失後も同じ ID で既存行を照会できる。
  const versionId = run.runId;
  const owns = (): boolean => {
    const current = deps.store.getState();
    return current.project?.projectId === project.projectId && current.queryOptimizationRun?.runId === run.runId;
  };
  const setSave = (save: FormulaSaveState): void => {
    if (owns()) deps.store.setState((s) => ({ ...s, queryOptimizationRun: { ...s.queryOptimizationRun!, save } }));
  };
  setSave({ formulaVersionId: versionId, status: 'saving', error: null });
  try {
    let version = await getFormulaVersionById(project.spreadsheetId, versionId, deps.google);
    if (!version) {
      const protocol = await resolveProtocolContext(deps, state);
      const createdAt = (deps.now ?? nowIso)();
      const logs = await ensureChildFolder('logs', project.driveFolderId, deps.google);
      const folder = await ensureChildFolder('validation', logs.id, deps.google);
      // Drive は同名ファイルを上書きせず別 ID で増やすため、先に照会して再アップロードを避ける。
      // 照会失敗は保存失敗として扱い、アップロードへフォールバックしない。
      // 照会とアップロードは一括確定できず、その間に別タブが同名ファイルを作る競合は防げない。
      const existing = await findChildFile(`${run.runId}.json`, folder.id, deps.google);
      const file = existing ?? await uploadTextFile({
        name: `${run.runId}.json`, parentId: folder.id, mimeType: 'application/json',
        content: JSON.stringify({ runId: run.runId, versionId, parentVersionId: state.currentFormulaVersionId,
          maxHits: run.maxHits, maxIterations: run.maxIterations, input: run.inputSnapshot ?? null,
          result, meshContext: run.meshContext }, null, 2),
      }, deps.google);
      const detailRef = file.webViewLink ?? `https://drive.google.com/file/d/${file.id}/view`;
      // 検証ログも同じ ID で照会し、版保存だけ失敗した後の再試行で重複させない。
      const rows = await getSheetValues(project.spreadsheetId, 'ValidationLog', deps.google);
      if (!rows.slice(1).some((row) => row[0] === versionId)) {
        // 最終再検証で崩れた場合も、以前の成功値で検証ログを上書きしない。
        const finalTrial = [...result.trials].reverse().find((trial) => trial.kind === 'final');
        const final = finalTrial?.after ?? best.evaluation.finalQuery;
        const captureRate = final.capturedPmids === null || best.evaluation.seedPmids.length === 0
          ? null : final.capturedPmids.length / best.evaluation.seedPmids.length;
        await appendValidationLog(project.spreadsheetId, {
          validationId: versionId, versionId, checkType: 'final_query', totalHits: final.totalHits,
          captureRate, capturedPmids: final.capturedPmids?.join(',') ?? null,
          missedPmids: final.missedPmids?.join(',') ?? null, detailRef,
          executedAt: finalTrial?.after?.measuredAt ?? best.evaluation.measuredAt,
        }, deps.google);
      }
      version = {
        versionId, parentVersionId: state.currentFormulaVersionId, ...protocol,
        formulaMd: serializePubmedFormulaMd(best.formula), createdBy: 'auto_optimize', createdAt,
        note: `自動調整 run: ${run.runId}\n実行ログ・最終検証: ${detailRef}`,
        model: run.inputSnapshot?.model ?? state.currentFormulaModel,
      };
      await appendFormulaVersion(project.spreadsheetId, version, deps.google);
    }
    if (!owns()) return;
    const saved = version;
    deps.store.setState((s) => ({ ...s,
      // 保存中に別の版へ移った場合は、その選択を上書きしない。
      ...(s.currentFormulaVersionId === state.currentFormulaVersionId ? {
        currentFormulaVersionId: saved.versionId, currentFormulaMarkdown: saved.formulaMd,
        currentFormulaCreatedBy: saved.createdBy, currentFormulaModel: saved.model,
      } : {}),
      queryOptimizationRun: { ...s.queryOptimizationRun!, save: { formulaVersionId: versionId, status: 'saved', error: null } },
    }));
  } catch (err) {
    setSave({ formulaVersionId: versionId, status: 'error', error: err instanceof Error ? err.message : String(err) });
  }
}

/** 版は作らず、最終候補を既存の編集下書きへ渡す。 */
export function editQueryOptimization(store: AppStore): boolean {
  const state = store.getState();
  const run = state.queryOptimizationRun;
  const best = run?.result?.best;
  if (!best || run?.projectId !== state.project?.projectId || run.status === 'running' || run.save?.status === 'saving') return false;
  store.setState((s) => ({ ...s,
    formulaEditDraft: { formulaVersionId: s.currentFormulaVersionId, markdown: serializePubmedFormulaMd(best.formula),
      optimizationOrigin: { projectId: run.projectId, runId: run.runId, model: run.inputSnapshot?.model ?? s.currentFormulaModel },
    },
    formulaSave: null, blockImprovement: null,
  }));
  return true;
}
