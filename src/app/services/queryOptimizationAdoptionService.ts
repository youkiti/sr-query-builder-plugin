import { appendFormulaVersion, getFormulaVersionById } from '@/features/formula';
import { appendValidationLog } from '@/features/validation';
import { ensureChildFolder, findChildFile, getSheetValues, uploadTextFile } from '@/lib/google';
import { serializePubmedFormulaMd, type PubmedFormula } from '@/lib/search-formula-md';
import { nowIso } from '@/utils/iso8601';
import { resolveProtocolContext, type EditServiceDeps } from './editService';
import { buildOptimizationReviewSections, countLostSampleAnnotations, evaluateHeldCandidateAdoptionGate } from './queryOptimizationReviewSections';
import type { AppStore, FormulaSaveState, OptimizationSaveTarget } from '../store';

/** 「採用して保存」1 回分の保存内容。最良候補・保留候補のどちらから来たかで note・監査記録だけが変わる。 */
interface AdoptionSelection {
  target: OptimizationSaveTarget;
  formula: PubmedFormula;
  /** ValidationLog へ書く実測値。best 側は最終再検証（無ければ最良候補の実測）、held 側はその候補自身の実測。 */
  validationLog: {
    totalHits: number | null; capturedPmids: string[] | null; missedPmids: string[] | null;
    executedAt: string; seedCount: number;
  } | null;
  /** 実行ログの note に追記する文（保留候補採用時だけ内容を持つ）。 */
  noteSuffix: string;
  /** Drive の実行ログ（<versionId>.json）へ残す、保留候補採用時の削除影響の監査記録。 */
  heldAudit: {
    annotation?: { status: 'success' | 'failure'; counts: ReturnType<typeof countLostSampleAnnotations> };
    candidateId: string; lostHits: number; judgedCount: number; unconfirmedCount: number;
    sampleMethod: 'all' | 'retrieved_subset' | null;
  } | null;
}

/**
 * 採用保存の本体。最良候補・保留候補ごとに実行ログ（`<versionId>.json`）と
 * 採用対象ごとに固定した ID の FormulaVersions 行へ保存する。
 * target.kind==='best' のときは既存の保存内容と完全に同じ形（save に target キーを含めない）を保つ。
 */
async function performOptimizationAdoption(deps: EditServiceDeps, selection: AdoptionSelection): Promise<void> {
  const state = deps.store.getState();
  const run = state.queryOptimizationRun!;
  const project = state.project!;
  // runId は実行開始時の UUID。応答喪失後も同じ ID で既存行を照会できる。
  const versionId = selection.target.kind === 'held'
    ? `${run.runId}-held-${encodeURIComponent(selection.target.candidateId)}` : run.runId;
  const previousSave = run.save?.status === 'error' && run.save.formulaVersionId
    && run.save.formulaVersionId !== versionId ? run.save : undefined;
  // 前回の照会が失敗した場合も、その版 ID を次回の確認対象として保持する。
  let saveVersionId = previousSave?.formulaVersionId ?? versionId;
  let saveTarget = previousSave ? previousSave.target ?? { kind: 'best' as const } : selection.target;
  const owns = (): boolean => {
    const current = deps.store.getState();
    return current.project?.projectId === project.projectId && current.queryOptimizationRun?.runId === run.runId;
  };
  // 最良候補の保存は従来どおり target キーを持たない形（既存テストの厳密一致を壊さないため）。
  const withTarget = (save: FormulaSaveState): FormulaSaveState & { target?: OptimizationSaveTarget } =>
    saveTarget.kind === 'held' ? { ...save, target: saveTarget } : save;
  const setSave = (save: FormulaSaveState): void => {
    if (owns()) deps.store.setState((s) => ({ ...s, queryOptimizationRun: { ...s.queryOptimizationRun!, save: withTarget(save) } }));
  };
  setSave({ formulaVersionId: saveVersionId, status: 'saving', error: null });
  try {
    let version = previousSave
      ? await getFormulaVersionById(project.spreadsheetId, saveVersionId, deps.google) : null;
    if (!version) {
      saveVersionId = versionId;
      saveTarget = selection.target;
      setSave({ formulaVersionId: saveVersionId, status: 'saving', error: null });
      version = await getFormulaVersionById(project.spreadsheetId, versionId, deps.google);
    }
    if (!version) {
      const protocol = await resolveProtocolContext(deps, state);
      const createdAt = (deps.now ?? nowIso)();
      const logs = await ensureChildFolder('logs', project.driveFolderId, deps.google);
      const folder = await ensureChildFolder('validation', logs.id, deps.google);
      // Drive は同名ファイルを上書きせず別 ID で増やすため、先に照会して再アップロードを避ける。
      // 照会失敗は保存失敗として扱い、アップロードへフォールバックしない。
      // 照会とアップロードは一括確定できず、その間に別タブが同名ファイルを作る競合は防げない。
      const existing = await findChildFile(`${versionId}.json`, folder.id, deps.google);
      const file = existing ?? await uploadTextFile({
        name: `${versionId}.json`, parentId: folder.id, mimeType: 'application/json',
        content: JSON.stringify({ runId: run.runId, versionId, parentVersionId: state.currentFormulaVersionId,
          maxHits: run.maxHits, maxIterations: run.maxIterations, input: run.inputSnapshot ?? null,
          result: run.result, meshContext: run.meshContext, reviewSections: buildOptimizationReviewSections(run).sections,
          outsideCheck: run.outsideCheck ?? null, generationNotices: run.generationNotices ?? null,
          // 保留候補の採用だけ、失う集合の確認状況（未確認件数を含む）をここへ残す（issue #172）。
          heldAdoption: selection.heldAudit }, null, 2),
      }, deps.google);
      const detailRef = file.webViewLink ?? `https://drive.google.com/file/d/${file.id}/view`;
      // 検証ログも同じ ID で照会し、版保存だけ失敗した後の再試行で重複させない。
      const rows = await getSheetValues(project.spreadsheetId, 'ValidationLog', deps.google);
      if (!rows.slice(1).some((row) => row[0] === versionId) && selection.validationLog) {
        const log = selection.validationLog;
        const captureRate = log.capturedPmids === null || log.seedCount === 0
          ? null : log.capturedPmids.length / log.seedCount;
        await appendValidationLog(project.spreadsheetId, {
          validationId: versionId, versionId, checkType: 'final_query', totalHits: log.totalHits,
          captureRate, capturedPmids: log.capturedPmids?.join(',') ?? null,
          missedPmids: log.missedPmids?.join(',') ?? null, detailRef, executedAt: log.executedAt,
        }, deps.google);
      }
      version = {
        versionId, parentVersionId: state.currentFormulaVersionId, ...protocol,
        formulaMd: serializePubmedFormulaMd(selection.formula), createdBy: 'auto_optimize', createdAt,
        note: `自動調整 run: ${run.runId}${selection.noteSuffix}\n実行ログ・最終検証: ${detailRef}`,
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
      queryOptimizationRun: { ...s.queryOptimizationRun!, save: withTarget({ formulaVersionId: saved.versionId, status: 'saved', error: null }) },
    }));
  } catch (err) {
    setSave({ formulaVersionId: saveVersionId, status: 'error', error: err instanceof Error ? err.message : String(err) });
  }
}

/** 採用の意思表示はこの入口だけで受け、途中の候補を正式版にしない。 */
export async function adoptQueryOptimization(deps: EditServiceDeps): Promise<void> {
  const state = deps.store.getState();
  const run = state.queryOptimizationRun;
  const project = state.project;
  const result = run?.result;
  const best = result?.best;
  if (!project || !run || run.projectId !== project.projectId || run.status === 'running' || !best
    || run.save?.status === 'saving' || run.save?.status === 'saved') return;
  // 最終再検証で崩れた場合も、以前の成功値で検証ログを上書きしない。
  const finalTrial = [...result.trials].reverse().find((trial) => trial.kind === 'final');
  const final = finalTrial?.after ?? best.evaluation.finalQuery;
  await performOptimizationAdoption(deps, {
    target: { kind: 'best' }, formula: best.formula, noteSuffix: '', heldAudit: null,
    validationLog: { totalHits: final.totalHits, capturedPmids: final.capturedPmids, missedPmids: final.missedPmids,
      executedAt: finalTrial?.after?.measuredAt ?? best.evaluation.measuredAt, seedCount: best.evaluation.seedPmids.length },
  });
}

/**
 * 保留候補（issue #172）をそのまま採用して保存する。次の 3 つのいずれかで何もしない:
 * 対象候補が無い・保留でない、除外済み（除外を取り消せば再度押せる）、
 * ゲート未達（失う集合の確認・判定が足りない）。ゲート・除外の判定は呼び出し側の
 * ボタン無効化と同じ関数（evaluateHeldCandidateAdoptionGate）を使い、二重に定義しない。
 */
export async function adoptHeldOptimizationCandidate(deps: EditServiceDeps, candidateId: string): Promise<void> {
  const state = deps.store.getState();
  const run = state.queryOptimizationRun;
  const project = state.project;
  const trial = run?.trials.find((item) => item.candidateId === candidateId && item.held);
  if (!project || !run || run.projectId !== project.projectId || run.status === 'running' || !run.result || !trial
    || run.save?.status === 'saving' || run.save?.status === 'saved' || run.heldRejections?.[candidateId]) return;
  const gate = evaluateHeldCandidateAdoptionGate(trial, run.outsideCheck?.decisions, {
    bestCapturedPmids: run.result?.best?.measurement.capturedPmids,
    unjudgedSeedPmids: run.outsideCheck?.unjudgedSeedPmids,
  });
  if (!gate.allowed) return;
  const impact = trial.impact!;
  const lostHits = impact.lostHits ?? 0;
  const unconfirmedCount = lostHits - gate.judgedCount;
  const annotation = impact.annotation ? { status: impact.annotation.status, counts: countLostSampleAnnotations(impact.annotation) } : undefined;
  const annotationNote = annotation ? `\nAI の参考注釈（採否には不使用）: 標本 ${new Set(impact.annotation!.requestedPmids).size} 件中 適格らしい ${annotation.counts.likelyEligible} 件・判断不能 ${annotation.counts.unclear} 件・非適格らしい ${annotation.counts.likelyIneligible} 件`
    + (annotation.counts.unannotated ? `・未注釈 ${annotation.counts.unannotated} 件` : '') : '';
  await performOptimizationAdoption(deps, {
    target: { kind: 'held', candidateId }, formula: trial.formula,
    validationLog: trial.after ? { totalHits: trial.after.totalHits, capturedPmids: trial.after.capturedPmids,
      missedPmids: trial.after.missedPmids, executedAt: trial.after.measuredAt,
      seedCount: run.result.best?.evaluation.seedPmids.length ?? 0 } : null,
    // 「N 件見たから安全」とは書かない（#164: 失う 10,800 件中 9 件が無作為 20 件に入る確率は約 1.7%）。
    // 標本に含まれなかった候補の適格性は確認できていない、という事実だけを残す。
    noteSuffix: `（保留候補 ${candidateId} を採用。失う ${lostHits} 件のうち判定済み ${gate.judgedCount} 件・未確認 ${unconfirmedCount} 件。` +
      `標本に含まれなかった候補の適格性は確認できていません。抽出方法: ${impact.sample?.method ?? '不明'}）` + annotationNote,
    heldAudit: { candidateId, lostHits, judgedCount: gate.judgedCount, unconfirmedCount,
      sampleMethod: impact.sample?.method ?? null, ...(annotation ? { annotation } : {}) },
  });
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
