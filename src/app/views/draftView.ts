import { t } from '@/lib/i18n';
import { MODEL_BENCHMARK_URL } from '@/lib/llm/modelRegistry';
import { renderGenerationNotice } from './generationNotice';
import { renderOptimizationReview } from './queryOptimizationReview';
import { createQueryOptimizationInputIdentity, getQueryOptimizationResumeAvailability } from '../services/queryOptimizationCheckpointService';
import { MAX_INFORMATION_TRIALS } from '../services/queryOptimizationService';
import { DEFAULT_QUERY_OPTIMIZATION_SETTINGS, type QueryOptimizationSettings } from '../services/queryOptimizationSettingsService';
import type { DraftBlockHit, DraftProgress } from '@/app/services';
import { HIT_THRESHOLD, type ExcessFilterCandidate } from '@/features/formula/skills';
import { parsePubmedFormulaMd, type PubmedFormula } from '@/lib/search-formula-md';
import { ROUTE_LABELS } from '../router';
import type {
  AppState,
  DraftRunProgressDetail,
  DraftRunState,
  ExcessFilterProposalEntry,
} from '../store';
import { tokenizeExpression } from './formulaDisplay';
import type { RenderView } from './types';
import { createOptimizationHistoryRenderer, optimizationApiLabel } from './queryOptimizationHistory';
import {
  readStoredAnalysis,
  readStoredSummary,
  renderValidationResults,
  summaryStatusText,
  type ValidationResultsCallbacks,
} from './validationResults';

/**
 * 検索式の生成・検証画面（#/draft）。
 *
 * 旧 draft タブと validate タブを統合したもので、主操作は自動調整カードの
 * 「検索式を作成・自動調整する」（.optimization__start）に一本化している。
 * 現式があればそれを初期式に、無ければ AI で生成したうえで、
 *   ① ブロックごとに block-designer → mesh → freeword を実行し、出来上がった瞬間に
 *      そのブロックのヒット数（line_hits）を計測してライブ表示する
 *   ② 全ブロックの組み立て・保存後、捕捉率（final_query）・MeSH・階層の検証を自動実行する
 * を続けて行う。現式があるときだけ、自動調整カードの直後に「検証のみ再実行」
 * （onRevalidate）・「最初から作り直す」（onGenerate。旧「生成して検証する」の
 * 生成→検証 1 アクション連結パイプラインそのもの）の補助操作を出す。
 *
 * - 進捗・エラー・ブロックごとのヒット数は store の state.draftRun から描画する。
 *   LLM コスト集計（cumulativeCostUsd）の setState が走るたびに全ビューが再描画されるため、
 *   ローカル DOM に進捗を書くと最初の LLM 呼び出し完了時点で表示が消えてしまう。
 * - 検証結果は state.validationResult / state.missedAnalysis から復元して表示する。
 * - 実行中は経過時間を 1 秒ごとに更新して「動いている」ことを示す。
 *
 * 実ロジック（generateDraft + runValidation の連結と draftRun の状態遷移）は bootstrap で
 * 差し込み、本 view は UI 描画のみ。
 */

export interface DraftViewCallbacks extends ValidationResultsCallbacks {
  onPrepareOptimization?: (retry?: boolean) => Promise<void>;
  onOptimizationSettingsInput?: (values: { maxHits: string; maxIterations: string }) => void;
  onOptimize?: (settings: QueryOptimizationSettings, resumeRunId?: string) => Promise<void>;
  onStopOptimization?: () => void;
  /** 採用保存を提供しない描画用途では省略する。 */
  onAdoptOptimization?: () => Promise<void>;
  /** 編集導線を提供しない描画用途では省略する。 */
  onEditOptimization?: () => void;
  onBlocksFromOptimization?: () => void;
  onDecideOutsideCandidate?: (pmid: string, decision: 'include' | 'exclude' | 'maybe') => Promise<void>;
  onReadjustOptimization?: () => Promise<void>;
  /** 保留候補（issue #172）の 3 操作。提供しない描画用途では省略する。 */
  onAdoptHeldOptimizationCandidate?: (candidateId: string) => Promise<void>;
  onReadjustHeldOptimizationCandidate?: (candidateId: string) => Promise<void>;
  onRejectHeldOptimizationCandidate?: (candidateId: string) => void;
  onUndoRejectHeldOptimizationCandidate?: (candidateId: string) => void;
  /** 「生成して検証する」ボタンが押されたとき。進捗・エラーは store.draftRun 経由で反映される */
  onGenerate?: () => Promise<void>;
  /**
   * 「検証のみ再実行」ボタン（fix-plan 2-2）。生成済みの式を LLM を呼ばずに再検証する。
   * 検証フェーズの失敗時に、生成からやり直す LLM コスト二重払いを避けるための導線。
   */
  onRevalidate?: () => Promise<void>;
  /** 過大ヒット時のフィルタ候補をユーザーが承認したとき（fix-plan 2-1）。承認済み候補のみ渡す */
  onApplyExcessFilters?: (approved: ExcessFilterCandidate[]) => Promise<void>;
  /** フィルタ候補を見送ったとき（式は変更しない） */
  onDismissExcessFilters?: () => void;
}

export function createDraftView(callbacks: DraftViewCallbacks = {}): RenderView {
  const renderHistory = createOptimizationHistoryRenderer();
  let stopElapsedTimer = (): void => {};
  let advancedOpen = false;
  let discardVisible = false;
  let proposalVersionId: string | null = null;
  let checkedCandidates: number[] = [];
  return (container, ctx) => {
    const advanced = container.querySelector<HTMLDetailsElement>('.optimization__setup details');
    if (advanced) advancedOpen = advanced.open;
    const proposal = readStoredProposal(ctx.state);
    if (proposalVersionId !== proposal?.formulaVersionId) {
      checkedCandidates = [];
      proposalVersionId = proposal?.formulaVersionId ?? null;
    } else if (container.querySelector('.draft__excess')) {
      checkedCandidates = Array.from(container.querySelectorAll<HTMLInputElement>('.draft__excess-check'))
        .filter((input) => input.checked).map((input) => Number(input.dataset.index));
    }
    // 同じビューの再描画では古いタイマーを即時解除し、次の tick まで重ねない。
    stopElapsedTimer();
    stopElapsedTimer = () => {};
    const optimization = ctx.state.queryOptimizationRun;
    const runKey = optimization?.projectId === ctx.state.project?.projectId && optimization
      ? `${optimization.projectId}:${optimization.runId}` : null;
    // 実行中の履歴と通知領域は接続を保ち、開いている詳細や停止ボタンのフォーカスを失わない。
    for (const child of Array.from(container.children)) {
      if (!runKey || (child as HTMLElement).dataset.optimizationRun !== runKey) child.remove();
    }
    const doc = container.ownerDocument;
    const heading = doc.createElement('h2');
    heading.textContent = ROUTE_LABELS.draft;
    container.insertBefore(heading, container.firstChild);

    if (!ctx.state.project) {
      const warn = doc.createElement('p');
      warn.className = 'view__placeholder';
      warn.textContent = t('draft.view.selectAProjectFirst');
      container.appendChild(warn);
      return;
    }
    if (!ctx.state.blocksDraft) {
      const warn = doc.createElement('p');
      warn.className = 'view__placeholder';
      warn.textContent = t('draft.view.completeBlockApprovalFirst');
      container.appendChild(warn);
      return;
    }

    const existing = ctx.state.currentFormulaMarkdown;
    if (existing) {
      const info = doc.createElement('p');
      info.className = 'draft__info';
      info.textContent = t('draft.view.currentVersion', { versionId: ctx.state.currentFormulaVersionId ?? t('draft.view.unsaved') });
      container.appendChild(info);
      container.appendChild(renderFormula(doc, existing));
    }

    const run = ctx.state.draftRun;
    const running = run?.status === 'running';

    // 主操作は自動調整カードの「検索式を作成・自動調整する」（.optimization__start）に
    // 一本化した。現式が無ければ「生成して検証する」（.draft__generate）は
    // 描画しない。現式があるときだけ、自動調整カードの直後に「検証のみ再実行」「最初から
    // 作り直す」の補助操作行を出す。
    let generateBtn: HTMLButtonElement | null = null;
    let discardConfirm: HTMLDivElement | null = null;
    let discardMessage: HTMLParagraphElement | null = null;
    let discardConfirmBtn: HTMLButtonElement | null = null;
    let discardCancelBtn: HTMLButtonElement | null = null;
    let secondaryActions: HTMLDivElement | null = null;

    if (existing) {
      secondaryActions = doc.createElement('div');
      secondaryActions.className = 'draft__actions draft__actions--secondary';
      secondaryActions.dataset.tour = 'draft-secondary-actions';
      const label = doc.createElement('span');
      label.className = 'draft__actions-label';
      label.textContent = t('draft.view.otherActions');
      secondaryActions.appendChild(label);

      // 「検証のみ再実行」(issue #40 症状 A): 検証失敗からのリカバリ導線に限定せず、
      // 保存済みの式があり実行中でなければ実行状態から独立して常に描画する。
      // #/edit の手編集保存後や、生成が正常終了した後の「式は変えず検証だけやり直す」
      // 入口としても使えるようにするため。生成ボタンと同じ補助操作行に置く。
      const canRevalidate =
        ctx.state.currentFormulaVersionId !== null && !running
        && ctx.state.queryOptimizationRun?.status !== 'running';
      if (canRevalidate) {
        const revalidateBtn = doc.createElement('button');
        revalidateBtn.type = 'button';
        revalidateBtn.className = 'draft__revalidate';
        revalidateBtn.textContent = t('draft.view.reRunValidationOnly');
        revalidateBtn.addEventListener('click', () => {
          if (!callbacks.onRevalidate || revalidateBtn.disabled) {
            return;
          }
          revalidateBtn.disabled = true;
          void callbacks.onRevalidate();
        });
        secondaryActions.appendChild(revalidateBtn);
      }

      generateBtn = doc.createElement('button');
      generateBtn.type = 'button';
      generateBtn.className = 'draft__generate';
      generateBtn.textContent = running ? t('draft.view.running') : t('draft.view.rebuildFromScratch');
      generateBtn.disabled = running || ctx.state.queryOptimizationRun?.status === 'running';
      secondaryActions.appendChild(generateBtn);

      // 手を加えた版の破棄確認（issue #40 症状 B）: currentFormulaCreatedBy === 'user_edit' の
      // 版を再生成が無警告で上書きしないよう、生成ボタン押下時にインライン確認を挟む。
      // 'user_edit' になる経路は #/edit の手編集保存だけでなく、過大ヒットフィルタ承認
      // （bootstrap.ts の runApplyExcessFilters が内部で saveEditedFormula を呼ぶ）も含むため、
      // 確認文言・コメントとも経路を特定しない表現にすること（「#/edit で手編集した」と
      // 断定しない）。ai_draft / null（未生成含む）のときは従来どおり即実行する
      // （余計なクリックを増やさない）。
      //
      // 表示中かどうかは closure に保持し、言語変更などの再描画後にも復元する。
      discardConfirm = doc.createElement('div');
      discardConfirm.className = 'draft__discard-confirm';
      discardConfirm.hidden = true;
      discardMessage = doc.createElement('p');
      discardMessage.className = 'draft__discard-message';
      discardMessage.setAttribute('role', 'alert');
      // textContent は初期描画時ではなく、表示する瞬間（showDiscardConfirm）に設定する。
      // role="alert" の live region は「内容の変更」で announce されるため、描画時に先に
      // textContent を入れて hidden を外すだけでは支援技術に読み上げられないことがある。
      discardConfirm.appendChild(discardMessage);

      const discardActions = doc.createElement('div');
      discardActions.className = 'draft__discard-actions';
      discardConfirmBtn = doc.createElement('button');
      discardConfirmBtn.type = 'button';
      discardConfirmBtn.className = 'draft__discard-confirm-btn';
      discardConfirmBtn.textContent = t('draft.view.discardAndRegenerate');
      discardCancelBtn = doc.createElement('button');
      discardCancelBtn.type = 'button';
      discardCancelBtn.className = 'draft__discard-cancel';
      discardCancelBtn.textContent = t('draft.view.cancel');
      discardActions.appendChild(discardConfirmBtn);
      discardActions.appendChild(discardCancelBtn);
      discardConfirm.appendChild(discardActions);
    }

    const renderCurrentHistory = (state: AppState): void => {
      const setup = state.queryOptimizationSetup?.projectId === state.project?.projectId ? state.queryOptimizationSetup : null;
      const checkpoint = setup?.checkpoint;
      const identity = setup?.status === 'ready' && setup.seedPmids && state.protocolDraftPersisted && state.protocolDraft && state.blocksDraft
        ? createQueryOptimizationInputIdentity(state.protocolDraft, state.blocksDraft, setup.seedPmids, Number(setup.maxHits)) : null;
      renderHistory(container,
        state.queryOptimizationRun?.projectId === state.project?.projectId ? state.queryOptimizationRun : null, setup,
        checkpoint ? { availability: getQueryOptimizationResumeAvailability(checkpoint, identity),
          disabled: state.draftRun?.status === 'running',
          start: callbacks.onOptimize ? () => { void callbacks.onOptimize?.({ maxHits: Number(setup!.maxHits),
            maxIterations: checkpoint.resume!.limits.evaluatedTrials }, checkpoint.runId); } : undefined,
        } : undefined);
    };
    // renderQueryOptimization は呼び出し終了時点で必ず section.optimization__setup を
    // container の最後尾に appendChild する。補助操作行・破棄確認パネルはその直後に続けて
    // appendChild することで「自動調整カードの直後」の位置を保証する（renderCurrentHistory /
    // renderOptimizationReview 等、後続の挿入は info/formula より前の位置を対象にしており、
    // setup と補助操作行の間には割り込まない）。
    renderQueryOptimization(container, ctx.state, callbacks, (stop) => { stopElapsedTimer = stop; }, (values) => {
      renderCurrentHistory({ ...ctx.state, queryOptimizationSetup: ctx.state.queryOptimizationSetup
        ? { ...ctx.state.queryOptimizationSetup, ...values } : null });
    });
    container.querySelector<HTMLDetailsElement>('.optimization__setup details')!.open = advancedOpen;
    if (secondaryActions) container.appendChild(secondaryActions);
    if (discardConfirm) container.appendChild(discardConfirm);
    renderCurrentHistory(ctx.state);
    renderOptimizationReview(container,
      ctx.state.queryOptimizationRun?.projectId === ctx.state.project.projectId ? ctx.state.queryOptimizationRun : null,
      { adopt: callbacks.onAdoptOptimization, edit: callbacks.onEditOptimization, blocks: callbacks.onBlocksFromOptimization,
        decide: callbacks.onDecideOutsideCandidate, readjust: callbacks.onReadjustOptimization,
        adoptHeld: callbacks.onAdoptHeldOptimizationCandidate, readjustHeld: callbacks.onReadjustHeldOptimizationCandidate,
        rejectHeld: callbacks.onRejectHeldOptimizationCandidate, undoRejectHeld: callbacks.onUndoRejectHeldOptimizationCandidate });
    if (!ctx.state.queryOptimizationSetup && callbacks.onPrepareOptimization) {
      void Promise.resolve().then(() => callbacks.onPrepareOptimization?.());
    }

    // 全体の進捗トラッカー（プログレスバー + ステップカウンタ + フェーズ・ステッパー）。
    // 「今やっていること」の 1 行（下の status）に対し、こちらは「全体のどこか」を示し、
    // 長い LLM 待ち（特にフリーワード展開）でも残りが見えるようにする。実行中のみ表示。
    const agentProgress = run?.progress?.phase === 'generating' && run.progress.step === 'agent'
      ? run.progress : null;
    if (running && run && !agentProgress) {
      container.appendChild(renderProgressTracker(doc, ctx.state, run));
    }

    const status = doc.createElement('p');
    status.className = 'draft__status';
    status.setAttribute('aria-live', 'polite');
    container.appendChild(status);

    const errorBox = doc.createElement('p');
    errorBox.className = 'draft__error';
    errorBox.setAttribute('role', 'alert');
    container.appendChild(errorBox);

    if (run) {
      if (run.status === 'running') {
        const progressLabel = agentProgress ? formatDraftProgress(agentProgress) : run.progressLabel;
        status.textContent = runningStatusText(run.phase, progressLabel, run.startedAtMs);
        startElapsedTicker(status, run.phase, progressLabel, run.startedAtMs);
      } else if (run.status === 'error') {
        const phaseLabel = run.phase === 'validating' ? t('draft.view.validation') : t('draft.view.generation');
        errorBox.textContent = t('draft.view.failed', { phase: phaseLabel, error: run.error ?? t('draft.view.unknownError') });
        // 「検証のみ再実行」ボタンは実行状態から独立して補助操作行
        // （.draft__actions--secondary）に描画する（issue #40 症状 A）。
        // 現式が無ければ補助操作行ごと出ないため、その場合の再試行は
        // .optimization__start（自動調整）が担う。ここでは失敗文言のみを出す。
      }
    }

    // 過大ヒット時の絞り込みフィルタ承認 UI（fix-plan 2-1）。検証完了後、総ヒット数が
    // 閾値を超えたときだけ store.excessFilterProposal に候補が入る。承認された候補のみ
    // 式へ追記され、見送れば式は変更されない（requirements.md §4.4 の承認ゲート）。
    if (proposal && !running) {
      container.appendChild(renderExcessFilterProposal(doc, proposal, callbacks, checkedCandidates));
    }

    // ブロックごとのライブヒット数。実行中（生成フェーズ）に「出来上がったブロックから順に
    // 件数が出る」様子を見せる。生成済みの blockHits が残っていれば完了後も表示する。
    const blockHits = run?.blockHits ?? [];
    if (!agentProgress && (blockHits.length > 0 || running)) {
      container.appendChild(renderLiveBlockHits(doc, ctx.state, blockHits, running));
    }
    if (!running && run) {
      const notice = renderGenerationNotice(doc, { ...run,
        filterNotice: run.filterNotice ?? null, parenthesizedTerms: run.parenthesizedTerms ?? [] });
      if (notice) container.appendChild(notice);
    }

    // 検証結果（捕捉率 / MeSH / 階層）。生成完了後に自動実行され store に保存される。
    const storedSummary = readStoredSummary(ctx.state);
    if (storedSummary && !running) {
      const summaryStatus = doc.createElement('p');
      summaryStatus.className = 'draft__validate-status';
      summaryStatus.textContent = summaryStatusText(storedSummary);
      container.appendChild(summaryStatus);

      const results = doc.createElement('div');
      results.className = 'validate__results';
      container.appendChild(results);
      renderValidationResults(doc, results, storedSummary, callbacks, readStoredAnalysis(ctx.state));
    }

    // 状態遷移（draftRun の running 設定）は bootstrap 側。setState → 再描画で
    // ボタンが即座に無効化されるため、ここでのローカル無効化は保険のみ
    // generateBtn は現式が無ければそもそも存在しない（主操作は .optimization__start
    // に一本化したため）。
    const runGenerate = (): void => {
      if (!callbacks.onGenerate || !generateBtn || generateBtn.disabled) {
        return;
      }
      generateBtn.disabled = true;
      void callbacks.onGenerate();
    };

    // 確認パネルを表示する。window.confirm と違い、フォーカス移動も読み上げ発火も
    // 自前で用意する必要がある（issue #40 レビュー指摘）。
    // - textContent をここで（表示の瞬間に）設定することで、role="alert" の live region が
    //   「内容の変更」を検知して announce できるようにする
    // - discardConfirmBtn.focus() でキーボード / スクリーンリーダー利用者にも
    //   パネルの出現が伝わるようにする
    const showDiscardConfirm = (focus = true): void => {
      if (!discardConfirm || !discardMessage || !discardConfirmBtn) {
        return;
      }
      discardMessage.textContent = t('draft.view.thisVersionVersionIncludesChanges', { versionId: ctx.state.currentFormulaVersionId ?? t('draft.view.unsaved') });
      discardConfirm.hidden = false;
      discardVisible = true;
      if (focus) discardConfirmBtn.focus();
    };

    const hideDiscardConfirm = (): void => {
      discardVisible = false;
      if (!discardConfirm || !discardMessage) {
        return;
      }
      discardConfirm.hidden = true;
      // 次回表示時に textContent が必ず「変化」として検知されるよう空に戻す
      // （同じバージョンで連続して開いた場合に同一文字列の再設定で announce が
      // 発火しないことを避けるため）。
      discardMessage.textContent = '';
    };

    if (discardVisible) showDiscardConfirm(false);

    generateBtn?.addEventListener('click', () => {
      if (!generateBtn || generateBtn.disabled) {
        return;
      }
      // currentFormulaCreatedBy が 'user_edit'（#/edit の手編集保存、または過大ヒット
      // フィルタ承認 saveEditedFormula 経由）のときだけ確認を挟む（issue #40 症状 B）。
      // ai_draft / null（未生成含む）は従来どおり即実行する。
      if (ctx.state.currentFormulaCreatedBy === 'user_edit') {
        showDiscardConfirm();
        return;
      }
      runGenerate();
    });

    discardConfirmBtn?.addEventListener('click', () => {
      hideDiscardConfirm();
      runGenerate();
    });

    discardCancelBtn?.addEventListener('click', () => {
      hideDiscardConfirm();
      // 開いたきっかけの要素へフォーカスを戻す。何もしないと「やめる」自身が
      // hidden 化した親ごと消え、フォーカスが行き場を失って body に落ちる
      // （キーボード利用者が文書先頭へ飛ばされる）。「破棄して再生成する」側は
      // 直後に runGenerate() → setState で全体再描画されビューごと作り直される
      // ため、どのみちフォーカスは維持できず対応不要（過大ヒットフィルタ承認等の
      // 既存 UI と同じ挙動）。
      generateBtn?.focus();
    });
  };
}

/** state.excessFilterProposal が現在の formula バージョンの提案なら返す（stale は null） */
export function readStoredProposal(state: AppState): ExcessFilterProposalEntry | null {
  if (
    state.excessFilterProposal === null ||
    state.currentFormulaVersionId === null ||
    state.excessFilterProposal.formulaVersionId !== state.currentFormulaVersionId
  ) {
    return null;
  }
  return state.excessFilterProposal;
}

/**
 * 過大ヒット時の絞り込みフィルタ候補（承認待ち）セクション。
 * チェックボックスで候補を選び、「式に追加して再検証」を押したものだけが式へ追記される。
 * 「見送る」は候補を破棄して式を変更しない。
 */
function renderExcessFilterProposal(
  doc: Document,
  proposal: ExcessFilterProposalEntry,
  callbacks: DraftViewCallbacks,
  checkedCandidates: number[]
): HTMLElement {
  const section = doc.createElement('section');
  section.className = 'draft__excess';

  const h3 = doc.createElement('h3');
  h3.textContent = t('draft.view.tooManyHitsHitsHits', { hitCount: proposal.totalHits.toLocaleString(), threshold: HIT_THRESHOLD.toLocaleString() });
  section.appendChild(h3);

  const note = doc.createElement('p');
  note.className = 'draft__excess-note';
  note.textContent =
    t('draft.view.theseFiltersCanNarrowThe');
  section.appendChild(note);

  const statusBox = doc.createElement('p');
  statusBox.className = 'draft__excess-status';
  statusBox.setAttribute('aria-live', 'polite');

  const errorBox = doc.createElement('p');
  errorBox.className = 'draft__excess-error';
  errorBox.setAttribute('role', 'alert');

  if (proposal.error !== null) {
    errorBox.textContent = t('draft.view.couldNotRetrieveCandidates', { error: proposal.error });
  } else if (proposal.candidates.length === 0) {
    const empty = doc.createElement('p');
    empty.className = 'draft__excess-empty';
    empty.textContent = t('draft.view.noCandidatesFoundNarrowThe');
    section.appendChild(empty);
  }

  const checkboxes: Array<{ input: HTMLInputElement; candidate: ExcessFilterCandidate }> = [];
  if (proposal.candidates.length > 0) {
    const list = doc.createElement('ul');
    list.className = 'draft__excess-list';
    proposal.candidates.forEach((candidate, index) => {
      const li = doc.createElement('li');
      li.className = 'draft__excess-item';

      const label = doc.createElement('label');
      const input = doc.createElement('input');
      input.type = 'checkbox';
      input.className = 'draft__excess-check';
      input.dataset['index'] = String(index);
      input.checked = checkedCandidates.includes(index);
      label.appendChild(input);
      const name = doc.createElement('strong');
      name.textContent = ` ${candidate.label}`;
      label.appendChild(name);
      li.appendChild(label);

      const expr = doc.createElement('code');
      expr.className = 'draft__excess-expr';
      expr.textContent = candidate.expression;
      li.appendChild(expr);

      const rationale = doc.createElement('p');
      rationale.className = 'draft__excess-rationale';
      rationale.textContent = candidate.rationale;
      li.appendChild(rationale);

      checkboxes.push({ input, candidate });
      list.appendChild(li);
    });
    section.appendChild(list);
  }

  const actions = doc.createElement('div');
  actions.className = 'draft__excess-actions';

  const applyBtn = doc.createElement('button');
  applyBtn.type = 'button';
  applyBtn.className = 'draft__excess-apply';
  applyBtn.textContent = t('draft.view.addApprovedCandidatesAndRe');
  applyBtn.disabled = true;

  const dismissBtn = doc.createElement('button');
  dismissBtn.type = 'button';
  dismissBtn.className = 'draft__excess-dismiss';
  dismissBtn.textContent = t('draft.view.skipKeepTheFormula');

  if (proposal.candidates.length > 0) {
    actions.appendChild(applyBtn);
  }
  actions.appendChild(dismissBtn);
  section.appendChild(actions);
  section.appendChild(statusBox);
  section.appendChild(errorBox);

  const syncApplyDisabled = (): void => {
    applyBtn.disabled = !checkboxes.some((entry) => entry.input.checked);
  };
  for (const entry of checkboxes) {
    entry.input.addEventListener('change', syncApplyDisabled);
  }
  syncApplyDisabled();

  applyBtn.addEventListener('click', () => {
    const approved = checkboxes
      .filter((entry) => entry.input.checked)
      .map((entry) => entry.candidate);
    if (!callbacks.onApplyExcessFilters || approved.length === 0 || applyBtn.disabled) {
      return;
    }
    applyBtn.disabled = true;
    dismissBtn.disabled = true;
    statusBox.textContent = t('draft.view.updatingTheFormulaAndRe');
    callbacks.onApplyExcessFilters(approved).catch((err: unknown) => {
      statusBox.textContent = '';
      errorBox.textContent = t('draft.view.couldNotUpdateTheFormula', { error: err instanceof Error ? err.message : String(err) });
      applyBtn.disabled = false;
      dismissBtn.disabled = false;
    });
  });

  dismissBtn.addEventListener('click', () => {
    callbacks.onDismissExcessFilters?.();
  });

  return section;
}

/**
 * ブロックごとのヒット数のライブ一覧。
 * blocksDraft のブロック定義を基準に、計測済み（blockHits）があれば件数を、
 * まだなら実行中は「計測中…」、停止後は何も足さずに表示する。
 */
function renderLiveBlockHits(
  doc: Document,
  state: AppState,
  blockHits: DraftBlockHit[],
  running: boolean
): HTMLElement {
  const section = doc.createElement('section');
  section.className = 'draft__block-hits';
  const h3 = doc.createElement('h3');
  h3.textContent = t('draft.view.hitsByBlock');
  section.appendChild(h3);

  const byIndex = new Map<number, DraftBlockHit>();
  for (const hit of blockHits) {
    byIndex.set(hit.blockIndex, hit);
  }

  const labels = state.blocksDraft?.blocks ?? [];
  const ul = doc.createElement('ul');
  labels.forEach((block, index) => {
    const li = doc.createElement('li');
    const hit = byIndex.get(index);
    const label = block.blockLabel || t('draft.view.block', { blockNumber: index + 1 });
    if (hit && hit.error !== null) {
      li.className = 'draft__block-hit draft__block-hit--error';
      li.textContent = t('draft.view.error', { blockNumber: index + 1, label: label, error: hit.error });
    } else if (hit && hit.hitCount !== null) {
      li.className = 'draft__block-hit draft__block-hit--done';
      li.textContent = t('draft.view.hits', { blockNumber: index + 1, label: label, hitCount: hit.hitCount.toLocaleString() });
    } else if (running) {
      li.className = 'draft__block-hit draft__block-hit--pending';
      li.textContent = t('draft.view.measuring', { blockNumber: index + 1, label: label });
    } else {
      li.className = 'draft__block-hit draft__block-hit--pending';
      li.textContent = `#${index + 1} ${label}: —`;
    }
    ul.appendChild(li);
  });
  section.appendChild(ul);
  return section;
}

// --- 進捗トラッカー（プログレスバー + ステップカウンタ + ステッパー）---------------

/** 各ブロックの生成サブステップ（順序固定）。1 ブロックにつきこの 4 つを踏む */
const GEN_SUBSTEPS = ['block-designer', 'mesh-suggester', 'freeword-designer', 'line-hits'] as const;
/** 全ブロック処理後の生成ステップ（順序固定） */
const GEN_TAIL = ['filter-designer', 'assemble', 'save'] as const;
/** 検証フェーズのステップ（順序固定） */
const VAL_STEPS = ['line_hits', 'final_query', 'mesh', 'mesh_hierarchy', 'logging'] as const;

const genSubstepLabels = (): Record<(typeof GEN_SUBSTEPS)[number], string> => ({
  'block-designer': t('draft.view.structure'),
  'mesh-suggester': 'MeSH',
  'freeword-designer': t('draft.view.freeTextTerms'),
  'line-hits': t('draft.view.hits2'),
});
const genTailLabels = (): Record<(typeof GEN_TAIL)[number], string> => ({
  'filter-designer': t('draft.view.chooseFilters'),
  assemble: t('draft.view.assemble'),
  save: t('draft.view.save'),
});
const valStepLabels = (): Record<(typeof VAL_STEPS)[number], string> => ({
  line_hits: t('draft.view.hitsByLine'),
  final_query: t('draft.view.captureRate'),
  mesh: t('draft.view.extractMesh'),
  mesh_hierarchy: t('draft.view.meshHierarchy'),
  logging: t('draft.view.logResults'),
});

type StepState = 'done' | 'active' | 'pending';

/** パイプライン全体のアトミックステップ総数（生成 4×ブロック + 末尾 3 + 検証 5） */
function totalSteps(blockCount: number): number {
  return blockCount * GEN_SUBSTEPS.length + GEN_TAIL.length + VAL_STEPS.length;
}

/**
 * 現在の構造化進捗を、パイプライン全体での 0 始まりインデックスへ変換する。
 * progress 未設定（開始直後）は 0（=最初のステップ）。done は完了位置を返す。
 * テストから検証しやすいよう純関数として export する。
 */
export function currentStepIndex(
  progress: DraftRunProgressDetail | null | undefined,
  blockCount: number
): number {
  const genTailBase = blockCount * GEN_SUBSTEPS.length;
  const valBase = genTailBase + GEN_TAIL.length;
  if (!progress) {
    return 0;
  }
  if (progress.phase === 'generating') {
    if (progress.step === 'agent') return 0;
    const subIdx = (GEN_SUBSTEPS as readonly string[]).indexOf(progress.step);
    if (subIdx >= 0) {
      return (progress.blockIndex ?? 0) * GEN_SUBSTEPS.length + subIdx;
    }
    const tailIdx = (GEN_TAIL as readonly string[]).indexOf(progress.step);
    if (tailIdx >= 0) {
      return genTailBase + tailIdx;
    }
    // 'done' = 生成完了（検証開始直前）
    return valBase;
  }
  const valIdx = (VAL_STEPS as readonly string[]).indexOf(progress.step);
  if (valIdx >= 0) {
    return valBase + valIdx;
  }
  // 'done' = 全工程完了
  return valBase + VAL_STEPS.length;
}

function stepStateFor(stepIndex: number, current: number): StepState {
  if (stepIndex < current) {
    return 'done';
  }
  if (stepIndex === current) {
    return 'active';
  }
  return 'pending';
}

/** 1 ステップを表すチップ（✓ / ⟳ / ○ + ラベル） */
function renderStepChip(doc: Document, label: string, state: StepState): HTMLElement {
  const chip = doc.createElement('span');
  chip.className = `draft__step draft__step--${state}`;
  const icon = doc.createElement('span');
  icon.className = 'draft__step-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = state === 'done' ? '✓' : state === 'active' ? '⟳' : '○';
  chip.appendChild(icon);
  chip.appendChild(doc.createTextNode(label));
  return chip;
}

/**
 * 全体進捗トラッカー。実行中のみ呼ばれる。
 * - 上段: プログレスバー（確定値）+「ステップ N / 総数」カウンタ（案 B）
 * - 下段: 生成 / 検証の 2 フェーズ・ステッパー。生成はブロックごとに 4 サブステップを並べる（案 A）
 * 構造（ブロック数・ステップ並び）は固定で blocksDraft から、現在位置は run.progress から決まる。
 */
function renderProgressTracker(doc: Document, state: AppState, run: DraftRunState): HTMLElement {
  const blocks = state.blocksDraft?.blocks ?? [];
  const blockCount = blocks.length;
  const total = totalSteps(blockCount);
  const current = currentStepIndex(run.progress, blockCount);

  const section = doc.createElement('section');
  section.className = 'draft__tracker';

  // 上段: バー + カウンタ
  const header = doc.createElement('div');
  header.className = 'draft__tracker-header';
  const bar = doc.createElement('progress');
  bar.className = 'draft__progressbar';
  bar.max = total;
  bar.value = Math.min(current, total);
  bar.setAttribute('aria-label', t('draft.view.overallProgress'));
  const counter = doc.createElement('span');
  counter.className = 'draft__step-counter';
  counter.textContent = t('draft.view.step', { step: Math.min(current + 1, total), total: total });
  header.appendChild(bar);
  header.appendChild(counter);
  section.appendChild(header);

  // 下段: 生成フェーズ
  const genGroup = doc.createElement('div');
  genGroup.className = 'draft__phase';
  const genLabel = doc.createElement('span');
  genLabel.className = 'draft__phase-label';
  genLabel.textContent = t('draft.view.generation');
  genGroup.appendChild(genLabel);

  blocks.forEach((block, i) => {
    const startIdx = i * GEN_SUBSTEPS.length;
    const endIdx = startIdx + GEN_SUBSTEPS.length - 1;
    const blockState: StepState =
      current > endIdx ? 'done' : current < startIdx ? 'pending' : 'active';

    const row = doc.createElement('div');
    row.className = `draft__step-block draft__step-block--${blockState}`;
    const name = doc.createElement('span');
    name.className = 'draft__step-block-label';
    name.textContent = `#${i + 1} ${block.blockLabel || t('draft.view.block', { blockNumber: i + 1 })}`;
    row.appendChild(name);

    const subWrap = doc.createElement('div');
    subWrap.className = 'draft__substeps';
    GEN_SUBSTEPS.forEach((sub, j) => {
      subWrap.appendChild(
        renderStepChip(doc, genSubstepLabels()[sub], stepStateFor(startIdx + j, current))
      );
    });
    row.appendChild(subWrap);
    genGroup.appendChild(row);
  });

  const tailWrap = doc.createElement('div');
  tailWrap.className = 'draft__substeps draft__substeps--tail';
  GEN_TAIL.forEach((s, k) => {
    tailWrap.appendChild(
      renderStepChip(doc, genTailLabels()[s], stepStateFor(blockCount * GEN_SUBSTEPS.length + k, current))
    );
  });
  genGroup.appendChild(tailWrap);
  section.appendChild(genGroup);

  // 下段: 検証フェーズ
  const valGroup = doc.createElement('div');
  valGroup.className = 'draft__phase';
  const valLabel = doc.createElement('span');
  valLabel.className = 'draft__phase-label';
  valLabel.textContent = t('draft.view.validation');
  valGroup.appendChild(valLabel);

  const valWrap = doc.createElement('div');
  valWrap.className = 'draft__substeps';
  const valBase = blockCount * GEN_SUBSTEPS.length + GEN_TAIL.length;
  VAL_STEPS.forEach((s, k) => {
    valWrap.appendChild(renderStepChip(doc, valStepLabels()[s], stepStateFor(valBase + k, current)));
  });
  valGroup.appendChild(valWrap);
  section.appendChild(valGroup);

  return section;
}

/**
 * 検索式 markdown をブロック単位で描画する。
 * - 1 行が長いため折り返す（CSS の white-space: pre-wrap / overflow-wrap）
 * - `#N` ごとにカードとして区切り、結合行（`#3 #1 AND #2`）は別スタイル
 * - 語のフィールドタグを見て MeSH / フリーワードを薄く色分けする
 *
 * パースに失敗した場合（PubMed セクション欠落など）は生テキストの <pre> に
 * フォールバックする。
 */
function renderFormula(doc: Document, markdown: string): HTMLElement {
  let formula: PubmedFormula | null = null;
  try {
    formula = parsePubmedFormulaMd(markdown);
  } catch {
    formula = null;
  }

  if (!formula || formula.blocks.length === 0) {
    const pre = doc.createElement('pre');
    pre.className = 'draft__formula draft__formula--raw';
    pre.textContent = markdown;
    return pre;
  }

  const wrap = doc.createElement('div');
  wrap.className = 'draft__formula';

  for (const block of formula.blocks) {
    const row = doc.createElement('div');
    row.className = 'draft__block';
    if (block.isCombination) {
      row.classList.add('draft__block--combination');
    }

    const id = doc.createElement('span');
    id.className = 'draft__block-id';
    id.textContent = `#${block.id}`;
    row.appendChild(id);

    const expr = doc.createElement('div');
    expr.className = 'draft__block-expr';
    for (const segment of tokenizeExpression(block.expression)) {
      if (segment.kind === 'plain') {
        expr.appendChild(doc.createTextNode(segment.text));
      } else {
        const span = doc.createElement('span');
        span.className = `draft__term draft__term--${segment.kind}`;
        span.textContent = segment.text;
        expr.appendChild(span);
      }
    }
    row.appendChild(expr);
    wrap.appendChild(row);
  }

  wrap.appendChild(buildLegend(doc));
  return wrap;
}

/** MeSH / フリーワードの色分け凡例 */
function buildLegend(doc: Document): HTMLElement {
  const legend = doc.createElement('div');
  legend.className = 'draft__legend';
  for (const [kind, label] of [
    ['mesh', 'MeSH'],
    ['freeword', t('draft.view.freeTextTerms')],
  ] as const) {
    const item = doc.createElement('span');
    item.className = `draft__legend-item draft__term--${kind}`;
    item.textContent = label;
    legend.appendChild(item);
  }
  return legend;
}

/**
 * 実行中ステータスの 1 秒ごとの経過時間更新。
 * 再描画されると要素ごと DOM から外れるので、isConnected を見て自動停止する
 * （再描画後は新しい要素に対して新しい ticker が走る）。
 */
function startElapsedTicker(
  status: HTMLElement,
  phase: DraftRunPhase,
  label: string,
  startedAtMs: number
): void {
  const win = status.ownerDocument.defaultView;
  if (!win) {
    return;
  }
  const timer = win.setInterval(() => {
    if (!status.isConnected) {
      win.clearInterval(timer);
      return;
    }
    status.textContent = runningStatusText(phase, label, startedAtMs);
  }, 1000);
}

type DraftRunPhase = 'generating' | 'validating';

function runningStatusText(phase: DraftRunPhase, label: string, startedAtMs: number): string {
  const phaseLabel = phase === 'validating' ? t('draft.view.validation') : t('draft.view.generation');
  return t('draft.view.elapsed', { phase: phaseLabel, label: label, elapsed: formatElapsed(Date.now() - startedAtMs) });
}

function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return min > 0 ? t('draft.view.mS', { minutes: min, seconds: sec }) : t('draft.view.s', { seconds: sec });
}

/** DraftProgress を表示用ラベルへ変換する（bootstrap が draftRun.progressLabel に入れる） */
export function formatDraftProgress(progress: DraftProgress): string {
  if (progress.step === 'agent') {
    const agent = progress.agent;
    const operations = { write_formula: t('draft.view.writeFormula'), check: t('draft.view.checkSyntax'), count: t('draft.view.measureHits'), mesh: t('draft.view.lookUpMesh'), submit: t('draft.view.submit') };
    const label = t('draft.view.aiIsDraftingTheSearch', { measurements: agent?.measurements ?? 0, maxMeasurements: agent?.maxMeasurements ?? 20, submissions: agent?.submissions ?? 0, maxSubmissions: agent?.maxSubmissions ?? 4 });
    return agent?.lastCommand ? t('draft.view.lastAction', { label: label, operation: operations[agent.lastCommand] }) : label;
  }
  const label = {
    'block-designer': t('draft.view.designingBlockStructure'),
    'mesh-suggester': t('draft.view.suggestingMeshTerms'),
    'freeword-designer': t('draft.view.expandingFreeTextTerms'),
    'line-hits': t('draft.view.measuringBlockHits'),
    'filter-designer': t('draft.view.choosingFilters'),
    assemble: t('draft.view.assemblingTheSearchFormula'),
    save: t('draft.view.savingToFormulaversions'),
    done: t('draft.view.done'),
  }[progress.step];
  if (progress.blockIndex !== undefined) {
    return t('draft.view.block2', { label: label, blockNumber: progress.blockIndex + 1, blockCount: progress.blockCount });
  }
  return label;
}

export { formatValidationProgress } from './validationResults';

/** 可変回数の処理なので、全体の割合ではなく現在段階と実測済みの最良値を示す。 */
function renderQueryOptimization(container: HTMLElement, state: AppState, callbacks: DraftViewCallbacks,
  setTimerCleanup: (stop: () => void) => void,
  refreshHistory: (values: { maxHits: string; maxIterations: string }) => void): void {
  const doc = container.ownerDocument;
  const run = state.queryOptimizationRun?.projectId === state.project?.projectId ? state.queryOptimizationRun : null;
  const setup = state.queryOptimizationSetup?.projectId === state.project?.projectId ? state.queryOptimizationSetup : null;
  const running = run?.status === 'running';
  if (run) {
    const status = container.querySelector<HTMLElement>('.optimization__status') ?? doc.createElement('section');
    status.className = 'optimization__status';
    status.dataset.optimizationRun = `${run.projectId}:${run.runId}`;
    for (const child of Array.from(status.children)) {
      if (!child.matches('.optimization__announcement, .optimization__stop')) child.remove();
    }
    status.setAttribute('aria-label', t('draft.optimize.autoTuningProgress'));
    status.setAttribute('aria-live', 'polite');
    status.setAttribute('aria-atomic', 'false');
    status.setAttribute('aria-relevant', 'text');
    const metrics = doc.createElement('div');
    metrics.className = 'optimization__metrics';
    metrics.setAttribute('aria-live', 'off');
    for (const [label, value] of [
      [t('draft.optimize.targetHitCount'), t('draft.optimize.hits3', { count: run.maxHits.toLocaleString() })],
      [t('draft.optimize.currentBestCandidateHitCount'), run.progress.bestTotalHits === null ? t('draft.optimize.notMeasured') : t('draft.optimize.hits3', { count: run.progress.bestTotalHits.toLocaleString() })],
      [t('draft.optimize.knownSeedsCaptured'), `${run.progress.bestCapturedSeedCount ?? t('draft.optimize.notMeasured')} / ${run.seedCount ?? t('draft.optimize.checking')}`],
      [t('draft.optimize.trials'), t('draft.optimize.maximum', { count: run.progress.evaluatedTrials ?? run.trials.filter((trial) => trial.kind === 'proposal').length, limit: run.maxIterations })],
      [t('draft.optimize.contextRequests'), t('draft.optimize.maximumRequests', { count: run.progress.informationTrials ?? run.trials.filter((trial) => trial.kind === 'information').length, limit: MAX_INFORMATION_TRIALS })],
    ]) {
      const item = doc.createElement('span');
      item.textContent = `${label}: ${value}`;
      metrics.appendChild(item);
    }
    const elapsed = doc.createElement('span');
    const updateElapsed = (): void => {
      elapsed.textContent = t('draft.optimize.elapsed2', { elapsed: formatElapsed((run.finishedAtMs ?? Date.now()) - run.startedAtMs) });
    };
    updateElapsed();
    metrics.appendChild(elapsed);
    if (running && doc.defaultView) {
      const win = doc.defaultView;
      const timer = win.setInterval(() => {
        if (!elapsed.isConnected) { win.clearInterval(timer); return; }
        updateElapsed();
      }, 1000);
      setTimerCleanup(() => win.clearInterval(timer));
    }
    status.insertBefore(metrics, status.querySelector('.optimization__announcement'));
    const stages = doc.createElement('ol');
    stages.className = 'optimization__stages';
    stages.setAttribute('aria-live', 'off');
    for (const [step, label] of [
      ['initial_formula', t('draft.optimize.draftInitialFormula')], ['measuring', t('draft.optimize.measure')], ['adjusting', t('draft.optimize.autoTune')],
      ['revalidating', t('draft.optimize.revalidate')], ['outside_check', t('draft.optimize.outsideCheck')], ['review', t('draft.optimize.review')],
    ]) {
      const item = doc.createElement('li');
      item.textContent = label!;
      if (step === run.progress.step) item.setAttribute('aria-current', 'step');
      stages.appendChild(item);
    }
    status.insertBefore(stages, status.querySelector('.optimization__announcement'));
    const message = status.querySelector<HTMLElement>('.optimization__announcement') ?? doc.createElement('p');
    message.className = 'optimization__announcement';
    const messageText = running ? (run.stopRequested ? t('draft.optimize.stopRequestedTheRunWill') : t('draft.optimize.autoTuningIsRunning'))
      : run.status === 'error' ? t('draft.optimize.autoTuningCouldNotContinue')
        : run.result?.status === 'stopped' ? t('draft.optimize.stoppedCandidatesHaveBeenKept')
          : run.result?.status === 'achieved' ? t('draft.optimize.completeMeasurementsMetTheConditions')
            : t('draft.optimize.runEndedCandidatesThatDo');
    const currentStage = stages.querySelector('[aria-current=step]')?.textContent;
    const announcement = t('draft.optimize.currentStageHistoryEntries', { message: messageText, stage: String(currentStage), count: run.trials.length });
    if (message.textContent !== announcement) message.textContent = announcement;
    if (!message.parentElement) status.appendChild(message);
    if (run.progress.task) {
      const task = run.progress.task;
      const detail = doc.createElement('p');
      detail.setAttribute('aria-live', 'off');
      detail.textContent = `${task.kind === 'terms' ? t('draft.optimize.termHits') : t('draft.optimize.seedCheck')} ${task.completed}/${task.total}${task.kind === 'terms' ? t('draft.optimize.terms') : t('draft.optimize.seeds')}`;
      status.insertBefore(detail, status.querySelector('.optimization__stop'));
    }
    if (run.progress.apiWaiting && running) {
      const api = doc.createElement('p');
      api.setAttribute('aria-live', 'off');
      api.textContent = optimizationApiLabel(run.progress.apiWaiting);
      status.insertBefore(api, status.querySelector('.optimization__stop'));
    }
    for (const event of run.progress.apiEvents?.filter((event) => event.status === 'failure') ?? []) {
      const failure = doc.createElement('p');
      failure.setAttribute('aria-live', 'off');
      failure.textContent = optimizationApiLabel(event);
      status.insertBefore(failure, status.querySelector('.optimization__stop'));
    }
    if (run.costUsd !== undefined && Number.isFinite(run.costUsd)) {
      const cost = doc.createElement('p');
      cost.setAttribute('aria-live', 'off');
      cost.textContent = t('draft.optimize.estimatedAiCostForThis', { cost: run.costUsd.toFixed(4) });
      status.insertBefore(cost, status.querySelector('.optimization__stop'));
    }
    if (run.seedCount === 0) {
      const warning = doc.createElement('p');
      warning.setAttribute('aria-live', 'off');
      warning.textContent = t('draft.optimize.thereAreNoSeedsTo');
      status.insertBefore(warning, status.querySelector('.optimization__stop'));
    }
    if (running) {
      const existingStop = status.querySelector<HTMLButtonElement>('.optimization__stop');
      const stop = existingStop ?? doc.createElement('button');
      stop.type = 'button';
      stop.className = 'optimization__stop';
      stop.textContent = t('draft.optimize.stopAndReviewCandidates');
      stop.disabled = run.stopRequested;
      if (!existingStop) {
        stop.addEventListener('click', () => callbacks.onStopOptimization?.());
        status.appendChild(stop);
      }
    } else {
      status.querySelector('.optimization__stop')?.remove();
    }
    if (container.children.item(1) !== status) container.insertBefore(status, container.children.item(1));
  }
  const section = doc.createElement('section');
  section.className = 'optimization__setup';
  section.dataset.tour = 'draft-optimize-settings';
  const heading = doc.createElement('h3');
  heading.textContent = t('draft.optimize.autoTuningTheSearchFormula');
  section.appendChild(heading);
  for (const [label, value] of [
    ['RQ', state.protocolDraft?.researchQuestion || t('draft.optimize.notSet')],
    [t('draft.optimize.inclusionCriteria'), state.protocolDraft?.inclusionCriteria || t('draft.optimize.notSet')],
    [t('draft.optimize.exclusionCriteria'), state.protocolDraft?.exclusionCriteria || t('draft.optimize.notSet')],
    [t('draft.optimize.approvedBlocks'), state.protocolDraftPersisted
      ? state.blocksDraft?.blocks.map((block, index) => `#${index + 1} ${block.blockLabel}`).join(' / ') : t('draft.optimize.notApproved')],
    [t('draft.optimize.seedsToValidate'), setup?.seedCount == null ? t('draft.optimize.checking') : t('draft.optimize.seedCount', { count: setup.seedCount })],
  ]) {
    const line = doc.createElement('p');
    line.textContent = `${label}: ${value}`;
    section.appendChild(line);
  }
  if (setup?.seedCount === 0 && !running) {
    const warning = doc.createElement('p');
    warning.textContent = t('draft.optimize.youCanRunWithoutSeeds');
    section.appendChild(warning);
  }
  const form = doc.createElement('form');
  form.noValidate = true;
  const makeInput = (labelText: string, value: string): HTMLLabelElement => {
    const label = doc.createElement('label');
    label.textContent = labelText;
    const input = doc.createElement('input');
    input.type = 'number';
    input.min = '1';
    input.step = '1';
    input.required = true;
    input.value = value;
    input.disabled = running || setup?.status !== 'ready';
    label.appendChild(input);
    return label;
  };
  const hitsLabel = makeInput(t('draft.optimize.targetHitCount'), setup?.maxHits ?? String(DEFAULT_QUERY_OPTIMIZATION_SETTINGS.maxHits));
  const iterationsLabel = makeInput(t('draft.optimize.iterationLimit'), setup?.maxIterations ?? String(DEFAULT_QUERY_OPTIMIZATION_SETTINGS.maxIterations));
  const hits = hitsLabel.querySelector('input')!;
  const hitsNote = doc.createElement('p');
  hitsNote.id = 'optimization-hits-note';
  hitsNote.className = 'draft__excess-note';
  hitsNote.textContent = t('draft.optimize.aGuideToHowMuch');
  hits.setAttribute('aria-describedby', hitsNote.id);
  const iterations = iterationsLabel.querySelector('input')!;
  const details = doc.createElement('details');
  const summary = doc.createElement('summary');
  summary.textContent = t('draft.optimize.advancedSettings');
  details.append(summary, iterationsLabel);
  const inputChanged = (): void => {
    const values = { maxHits: hits.value, maxIterations: iterations.value };
    callbacks.onOptimizationSettingsInput?.(values);
    refreshHistory(values);
  };
  hits.addEventListener('input', inputChanged);
  iterations.addEventListener('input', inputChanged);
  const start = doc.createElement('button');
  start.type = 'submit';
  start.className = 'optimization__start';
  start.dataset.tour = 'draft-optimize-start';
  start.textContent = t('draft.optimize.createAndAutoTuneThe');
  start.disabled = running || run?.save?.status === 'saving' || setup?.status !== 'ready' || state.draftRun?.status === 'running' || !state.protocolDraftPersisted;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (start.disabled || !callbacks.onOptimize) return;
    start.disabled = true;
    void callbacks.onOptimize({ maxHits: Number(hits.value), maxIterations: Number(iterations.value) });
  });
  const draftNotice = doc.createElement('p');
  draftNotice.className = 'optimization__notice';
  draftNotice.textContent = t('draft.optimize.aiGeneratedSearchFormulasAre');
  const costNotice = doc.createElement('p');
  costNotice.className = 'optimization__cost-notice';
  costNotice.textContent = setup?.model === 'claude-opus-5-5'
    ? t('draft.optimize.guideAboutOrLessPer')
    : t('draft.optimize.costsHaveNotBeenBenchmarked');
  const benchmark = doc.createElement('a');
  benchmark.href = MODEL_BENCHMARK_URL;
  benchmark.textContent = t('draft.optimize.readmeBenchmark');
  benchmark.target = '_blank';
  benchmark.rel = 'noopener noreferrer';
  costNotice.append(' ', benchmark);
  form.append(hitsLabel, hitsNote, details, draftNotice, costNotice, start);
  section.appendChild(form);
  const error = run?.error ?? setup?.error;
  if (error) {
    const alert = doc.createElement('p');
    alert.setAttribute('role', 'alert');
    alert.textContent = error;
    section.appendChild(alert);
  }
  if (setup?.status === 'loading') {
    const loading = doc.createElement('p');
    loading.setAttribute('aria-live', 'polite');
    loading.textContent = t('draft.optimize.loadingSettingsAndSeedsTo');
    section.appendChild(loading);
  }
  if (setup?.status === 'error') {
    const retry = doc.createElement('button');
    retry.type = 'button';
    retry.textContent = t('draft.optimize.reloadStartSettings');
    retry.addEventListener('click', () => { void callbacks.onPrepareOptimization?.(true); });
    section.appendChild(retry);
  }
  container.appendChild(section);
}
