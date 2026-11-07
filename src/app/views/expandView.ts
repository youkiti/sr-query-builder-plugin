import { t, type MessageKey } from '@/lib/i18n';
import type {
  BoundaryCaseView,
  BoundaryCasesResult,
  ExpandFetchStep,
  InsideStrategy,
  RecordDecisionInput,
  RecordDecisionResult,
  SpecificQueryFallback,
  SpecificQueryOutcome,
  ValidationSummary,
} from '@/app/services';
import type { SeedUserDecision } from '@/domain/seedPaper';
import type { PickerGrantResult } from '@/background/pickerGrant';
import {
  buildUpdateProposals,
  type IncludedPaper,
  type UpdateProposal,
} from '@/features/formula';
import { ROUTE_LABELS } from '../router';
import type { ApiErrorKind } from '@/lib/api-error';
import type { ExpandApiWait, ExpandRunState } from '../store';
import type { RenderView } from './types';

/**
 * 対話的 seed 拡張画面（#/expand）。
 *
 * - 「境界事例を取得」ボタンで onFetch（bootstrap が fetchBoundaryCandidates をラップ）を実行
 * - 取得の進捗（プロトコル取得 → 拡張語提案 → 外側を検索 → 重複除去 → 候補論文取得 → AI 選定）を
 *   進捗トラッカーで可視化する。draft 画面（生成・検証）と同じく「いま何をやっているか」を
 *   見せるのが狙い。進捗・取得結果は store.expandRun から描画する（理由は後述）
 * - 現検索式を 2 軸（MeSH 一段上 / フリーワード）で緩めた拡張式の **外側**（margin = 拡張式 NOT 現式）
 *   から候補を拾うのが要点。式の中ではなく外側を見るので、include すれば現式が逃した取りこぼしが顕在化する
 * - 取得した候補を一覧表示し、include / exclude / maybe ボタンを提示
 * - 判定が押されたら onDecide（recordDecision）を呼び、対応カードの状態を更新
 * - 1 ラウンド（候補すべて）を判定し終えたら onRoundComplete で
 *   check_final_query 相当の再検証を自動実行し、新しい捕捉率を表示する（requirements.md §4.5）。
 *   あわせて、include した「式の外側」論文をどの拡張語が拾えたかを集計し、検索式の更新提案を出す
 * - 有効 seed が 0 件のとき（inside モード）は「AI に specific（精度優先）な絞り込み式を作らせ、
 *   その relevance 上位から候補を選ぶ」か「現式の上位から選ぶ」かをチェックボックスで選べる
 *   （issue #93。既定は前者）。チェック状態は store.expandInsideStrategy に置き、
 *   onInsideStrategyChange（bootstrap が setStateSilently でラップ）で書き戻す
 *
 * **なぜ進捗・候補を store に持たせるか**:
 * fetchBoundaryCandidates の最後の AI 選定（LLM）完了時に LLM コスト集計
 * （cumulativeCostUsd）の setState が走り、expand ビューも含めた全ビューが再描画される。
 * 進捗・取得結果をローカル DOM に書くとこの再描画で消えてしまうため、store.expandRun に
 * 保持して再描画に耐えるようにする（draftRun / validationResult と同じ理由）。
 * 一方、候補の判定（recordDecision）とラウンド完了の再検証（runValidation）は LLM を
 * 呼ばず setState を起こさない（= 再描画されない）ため、判定 UI と再検証結果はビュー側の
 * クロージャに保持し、再描画時に復元する。
 *
 * **キーボードショートカット**（requirements.md §7、ui-flow.md §6）:
 * - `i` / `e` / `m`: 現在アクティブな候補を include / exclude / maybe で判定。
 *   判定が保存され次第、アクティブ表示は自動で次の未判定候補へ下りていく
 *   （全件判定済みになったらラウンド完了の再検証へ進む）
 * - `↓` / `↑`: アクティブ表示を 1 つ下／上のカードへ移動（判定済みも含めて自由に移動）
 * - `n` / `→`: 次の未判定候補へ移動（判定済みはスキップ。無ければ次のカードへ）
 * - `p` / `←`: 前のカードへ移動
 *
 * アクティブ表示（`.expand__candidate--focused`）は DOM フォーカスではなく
 * `focusIndex` と CSS クラスで管理し、キー入力は document で拾う。
 * 入力欄の操作・修飾キー付きの入力は判定に使わない。
 * マウスで判定ボタンを押した場合は、そのカードへアクティブ表示を同期しつつ list へ
 * フォーカスを戻し、以降もキーボードで操作できるようにする。
 *
 * アブストラクト本文はアクティブなカードにだけ全文を展開する（常時 DOM に置き、
 * 表示/非表示は CSS で切り替えるためフォーカスロジック側の改修は不要）。
 *
 * 実ロジック（onFetch / onDecide / onRoundComplete）は bootstrap で service を
 * ラップして渡す。
 */

export interface ExpandFetchOptions {
  /** inside モード（有効 seed 0 件）で母集団に使う式の選び方。クリック時のチェック状態 */
  insideStrategy: InsideStrategy;
}

export interface ExpandViewCallbacks {
  /** 「境界事例を取得」ボタン。進捗・取得結果は store.expandRun 経由で反映される */
  onFetch?: (options: ExpandFetchOptions) => Promise<void>;
  /** inside モードの母集団チェックボックスが切り替わったとき（store.expandInsideStrategy へ保存） */
  onInsideStrategyChange?: (strategy: InsideStrategy) => void;
  onDecide?: (input: RecordDecisionInput) => Promise<RecordDecisionResult>;
  /** ラウンド完了時の再検証コールバック。check_final_query 相当を期待 */
  onRoundComplete?: () => Promise<ValidationSummary>;
  /** 許可エラーのとき、対象スプレッドシートを新しいタブで開く。 */
  onOpenSpreadsheet?: (spreadsheetId: string) => void;
  onRequestSpreadsheetAccess?: (spreadsheetId: string) => Promise<PickerGrantResult>;
}

interface CandidateItemHandle {
  element: HTMLElement;
  decide: (decision: SeedUserDecision) => void;
  isDecided: () => boolean;
  isPending: () => boolean;
}

const candidateShortcutCleanup = new WeakMap<Document, () => void>();

interface CandidateState {
  decision?: SeedUserDecision;
  pending: boolean;
  decided: boolean;
  error?: string;
  refresh?: () => void;
  onDecided?: (decision: SeedUserDecision) => void;
}

interface CandidateSession {
  result: BoundaryCasesResult;
  focusIndex: number;
  includedPmids: Set<string>;
  candidates: Map<string, CandidateState>;
  roundTriggered: boolean;
  roundPending?: boolean;
  roundSummary?: ValidationSummary;
  roundError?: string;
  refreshRound?: () => void;
}

export function createExpandView(callbacks: ExpandViewCallbacks = {}): RenderView {
  let session: CandidateSession | undefined;
  let strategyDraft: { projectId: string; saved: InsideStrategy; value: InsideStrategy } | undefined;
  return (container, ctx) => {
    const doc = container.ownerDocument;
    candidateShortcutCleanup.get(doc)?.();
    container.innerHTML = '';
    const heading = doc.createElement('h2');
    heading.textContent = ROUTE_LABELS.expand;
    container.appendChild(heading);

    if (!ctx.state.project) {
      const warn = doc.createElement('p');
      warn.className = 'view__placeholder';
      warn.textContent = t('expand.projectRequired');
      container.appendChild(warn);
      return;
    }
    if (!ctx.state.currentFormulaMarkdown) {
      const warn = doc.createElement('p');
      warn.className = 'view__placeholder';
      warn.textContent = t('expand.formulaRequired');
      container.appendChild(warn);
      return;
    }

    const devNote = doc.createElement('p');
    devNote.className = 'expand__dev';
    devNote.setAttribute('role', 'note');
    devNote.textContent = t('expand.devNote');
    container.appendChild(devNote);

    const lead = doc.createElement('p');
    lead.className = 'expand__lead';
    lead.textContent = t('expand.lead');
    container.appendChild(lead);

    const shortcuts = doc.createElement('p');
    shortcuts.className = 'expand__shortcuts';
    shortcuts.textContent = t('expand.shortcuts');
    container.appendChild(shortcuts);

    const run = ctx.state.expandRun;
    if (session?.result !== run?.result) {
      session = undefined;
    }
    const running = run?.status === 'running';

    const actions = doc.createElement('div');
    actions.className = 'expand__actions';
    const fetchBtn = doc.createElement('button');
    fetchBtn.type = 'button';
    fetchBtn.dataset.tour = 'expand-fetch';
    fetchBtn.textContent = running ? t('expand.fetching') : t('expand.fetch');
    fetchBtn.disabled = running;
    actions.appendChild(fetchBtn);
    container.appendChild(actions);

    // inside モード（有効 seed 0 件）の母集団の選び方（issue #93）。margin モードでは無視される
    // ことをラベルで明示する。チェック状態は store.expandInsideStrategy から復元する
    const optionLabel = doc.createElement('label');
    optionLabel.className = 'expand__option';
    const specificToggle = doc.createElement('input');
    specificToggle.type = 'checkbox';
    specificToggle.className = 'expand__inside-specific';
    const savedStrategy = ctx.state.expandInsideStrategy;
    if (strategyDraft?.projectId !== ctx.state.project.projectId || strategyDraft.saved !== savedStrategy) {
      strategyDraft = undefined;
    }
    specificToggle.checked = (strategyDraft?.value ?? savedStrategy) === 'specific';
    specificToggle.disabled = running;
    optionLabel.appendChild(specificToggle);
    optionLabel.appendChild(
      doc.createTextNode(
        t('expand.specificOption')
      )
    );
    specificToggle.addEventListener('change', () => {
      const value = specificToggle.checked ? 'specific' : 'current';
      strategyDraft = { projectId: ctx.state.project!.projectId, saved: savedStrategy, value };
      callbacks.onInsideStrategyChange?.(value);
    });
    container.appendChild(optionLabel);

    // 取得中は「全体のどこか」を示す進捗トラッカーを出す（draft 画面と同じ見た目）。
    // 長い LLM 待ち（AI 選定）でも残りの段階が見えるようにする。
    if (running && run) {
      container.appendChild(renderFetchTracker(doc, run, ctx.state.expandInsideStrategy));
    }

    const status = doc.createElement('p');
    status.className = 'expand__status';
    status.setAttribute('aria-live', 'polite');
    container.appendChild(status);

    // 分類つきの案内（issue #109）。生のメッセージより先に「次に何をすればよいか」を置く。
    const guidance = doc.createElement('div');
    guidance.className = 'expand__guidance';
    container.appendChild(guidance);

    const errorBox = doc.createElement('p');
    errorBox.className = 'expand__error';
    errorBox.setAttribute('aria-live', 'polite');
    container.appendChild(errorBox);

    const list = doc.createElement('ul');
    list.className = 'expand__candidates';
    list.tabIndex = -1;
    container.appendChild(list);

    const round = doc.createElement('section');
    round.className = 'expand__round';
    round.setAttribute('aria-live', 'polite');
    container.appendChild(round);

    const startFetch = (): void => {
      if (!callbacks.onFetch || fetchBtn.disabled) {
        return;
      }
      // 状態遷移（expandRun の running 設定）は bootstrap 側。setState → 再描画で
      // ボタンが即座に無効化されるため、ここでのローカル無効化は保険のみ
      fetchBtn.disabled = true;
      // ctx.state は描画時点のスナップショット（チェック変更は setStateSilently で再描画されない）
      // なので、クリック時点の DOM の値を読む
      void callbacks.onFetch({
        insideStrategy: specificToggle.checked ? 'specific' : 'current',
      });
    };
    fetchBtn.addEventListener('click', startFetch);

    if (running && run) {
      status.textContent = runningStatusText(run.step, run.startedAtMs);
      startElapsedTicker(status, run.step, run.startedAtMs);
      if (run.apiWait) {
        guidance.appendChild(renderApiWait(doc, run.apiWait));
      }
      return;
    }
    if (run?.status === 'error') {
      errorBox.textContent = run.error ?? t('expand.unknownError');
      const panel = renderErrorGuidance(doc, run.errorKind, {
        spreadsheetId: ctx.state.project.spreadsheetId,
        onOpenSpreadsheet: callbacks.onOpenSpreadsheet,
        onRequestSpreadsheetAccess: callbacks.onRequestSpreadsheetAccess,
        onRetry: startFetch,
      });
      if (panel) guidance.appendChild(panel);
      return;
    }
    if (run?.status === 'ready' && run.result) {
      const result = run.result;
      if (result.mode === 'inside') {
        // 「式の外側」を期待しているユーザーに、今回は初期シード作りだと先に伝える。
        container.insertBefore(renderInsideBanner(doc), actions);
        if (result.specific !== null) {
          // AI が設計した specific 式（とフォールバックの有無）を候補の上で確認できるようにする
          container.insertBefore(renderSpecificQuery(doc, result.specific), status);
        }
      }
      if (result.candidates.length === 0) {
        status.textContent = emptyResultText(result);
      } else if (result.mode === 'inside') {
        status.textContent = insideStatusText(result);
      } else {
        status.textContent = t('expand.marginStatus', { count: result.candidates.length, originalHits: result.originalHits, broadenedHits: result.broadenedHits, marginHits: result.marginHits, evaluatedCount: result.evaluatedCount });
      }
      session ??= {
        result,
        focusIndex: 0,
        includedPmids: new Set(),
        candidates: new Map(),
        roundTriggered: false,
      };
      setupCandidates(doc, list, round, result, callbacks, session);
    }
  };
}

/**
 * 取得結果（store 保持）から候補カードを組み立て、判定・キーボード操作・ラウンド完了の
 * ローカルな対話ロジックを配線する。
 *
 * 判定・選択・再検証の状態は、同じ取得結果の間は再描画されても保持する。
 */
function setupCandidates(
  doc: Document,
  list: HTMLElement,
  round: HTMLElement,
  result: BoundaryCasesResult,
  callbacks: ExpandViewCallbacks,
  session: CandidateSession
): void {
  const items: CandidateItemHandle[] = [];
  // include 判定された候補の PMID。ラウンド完了時に更新提案の集計対象にする。
  const includedPmids = session.includedPmids;
  let focusIndex = session.focusIndex;

  const setFocus = (index: number, scroll = true): void => {
    /* istanbul ignore if -- 呼び出し側で items.length > 0 を保証しているための防御 */
    if (items.length === 0) return;
    const next = clampIndex(index, items.length);
    focusIndex = next;
    session.focusIndex = next;
    for (let i = 0; i < items.length; i++) {
      items[i]!.element.classList.toggle('expand__candidate--focused', i === next);
    }
    const target = items[next]!.element;
    // jsdom には scrollIntoView が無いのでガードして無視する
    if (scroll && list.isConnected && typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ block: 'start' });
    }
  };

  const focusNext = (): void => {
    const start = focusIndex;
    for (let step = 1; step <= items.length; step++) {
      const idx = (start + step + items.length) % items.length;
      if (!items[idx]!.isDecided()) {
        setFocus(idx);
        return;
      }
    }
    // 全て判定済みなら単純に隣のカードへ移す
    setFocus(focusIndex + 1);
  };

  const focusPrev = (): void => {
    setFocus(focusIndex - 1);
  };

  const checkRoundComplete = (): void => {
    /* istanbul ignore if -- 1 候補ごとに 1 回しか onDecided が呼ばれないので二重ガード */
    if (session.roundTriggered) {
      return;
    }
    /* istanbul ignore if -- onDecided は items が非空のときにのみ呼ばれる */
    if (items.length === 0) return;
    if (!items.every((it) => it.isDecided())) return;
    session.roundTriggered = true;
    const includedPapers: IncludedPaper[] = result.candidates
      .filter((c) => includedPmids.has(c.pmid))
      .map((c) => ({
        pmid: c.pmid,
        title: c.title,
        abstract: c.abstract,
        meshHeadings: c.meshHeadings,
      }));
    runRoundComplete(
      doc,
      round,
      callbacks.onRoundComplete,
      includedPapers,
      result.additions,
      result.mode,
      session
    );
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (!list.isConnected) {
      cleanup();
      return;
    }
    if (items.length === 0 || event.defaultPrevented || event.isComposing ||
        event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
    const isInput = (target: EventTarget | null): boolean =>
      target instanceof Element &&
      target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') !== null;
    if (isInput(event.target) || isInput(doc.activeElement)) return;
    const handler = KEY_HANDLERS[event.key];
    if (!handler) return;
    event.preventDefault();
    handler({
      focusNext,
      focusPrev,
      // ↓↑ は判定状態を問わない単純な上下移動（端で止まる）
      focusDown: () => setFocus(focusIndex + 1),
      focusUp: () => setFocus(focusIndex - 1),
      decide: (d) => decideFocused(items, focusIndex, d),
    });
  };
  // 再描画では同期的に置き換え、別ルートによる DOM の破棄でも解除する。
  const observer = new MutationObserver(() => {
    if (!list.isConnected) cleanup();
  });
  const cleanup = (): void => {
    doc.removeEventListener('keydown', onKeyDown);
    observer.disconnect();
    if (candidateShortcutCleanup.get(doc) === cleanup) candidateShortcutCleanup.delete(doc);
  };
  candidateShortcutCleanup.set(doc, cleanup);
  doc.addEventListener('keydown', onKeyDown);
  observer.observe(doc, { childList: true, subtree: true });

  result.candidates.forEach((candidate, index) => {
    let candidateState = session.candidates.get(candidate.pmid);
    if (!candidateState) {
      candidateState = { pending: false, decided: false };
      session.candidates.set(candidate.pmid, candidateState);
    }
    const handle = buildCandidateItem(doc, candidate, callbacks.onDecide, candidateState, {
      // 判定が保存され次第、アクティブを次の未判定へ下ろし、全件終了ならラウンド完了へ。
      // 保存確定後に進めることで、連打で隣のカードを誤判定する事故も防ぐ。
      onDecided: (decision) => {
        if (decision === 'include') {
          includedPmids.add(candidate.pmid);
        }
        focusNext();
        checkRoundComplete();
      },
      // マウスで判定ボタンを押したらアクティブ表示をそのカードへ同期し、list に
      // フォーカスを戻して以降もキーボードで操作できるようにする。
      onInteract: () => {
        list.focus({ preventScroll: true });
        setFocus(index, false);
      },
    });
    list.appendChild(handle.element);
    items.push(handle);
  });
  if (items.length > 0) {
    // ツアーが枠を付ける対象。候補があるときだけ付け、空の一覧には付けない。
    list.dataset.tour = 'expand-candidates';
    list.focus({ preventScroll: true });
    setFocus(session.focusIndex);
  }
  if (session.roundTriggered) {
    const includedPapers = result.candidates.filter((c) => includedPmids.has(c.pmid));
    runRoundComplete(doc, round, undefined, includedPapers, result.additions, result.mode, session);
  }
}

// --- 取得の進捗トラッカー（プログレスバー + ステップカウンタ + ステッパー）---------------
// チップ／プログレスバーは draft 画面（生成・検証）と見た目を揃えるため、draft__ の
// 視覚プリミティブ（.draft__step / .draft__progressbar / .draft__substeps）を再利用する。

/**
 * 取得パイプラインのステップ（順序固定）。margin モードはこの 6 段階、inside モードは
 * broaden を踏まない 5 段階を踏む。'esearch' 等の生の名前を margin / inside で共有しない
 * のは、expandService.ts 側で述べたとおり実行中の 1 ステップだけからモードを判定できる
 * ようにするため（inside モードでは broaden チップを一切出してはいけない）。
 */
const MARGIN_FETCH_STEPS = [
  'protocol',
  'broaden',
  'esearch',
  'dedup',
  'efetch',
  'pick-boundary',
] as const;

/** inside モード（有効 seed 0 件の初期シードブートストラップ、現式の上位）のステップ。式を広げないので broaden が無い */
const INSIDE_FETCH_STEPS = [
  'protocol',
  'inside-esearch',
  'inside-dedup',
  'inside-efetch',
  'pick-seed',
] as const;

/** inside モードで AI に specific 式を設計させるとき（既定）のステップ。先頭に設計が 1 段入る */
const INSIDE_SPECIFIC_FETCH_STEPS = [
  'protocol',
  'inside-design',
  'inside-esearch',
  'inside-dedup',
  'inside-efetch',
  'pick-seed',
] as const;

/** inside モード固有のステップ集合（判定用）。'protocol' はモード分岐前の共通ステップなので含めない */
const INSIDE_ONLY_STEPS = new Set<ExpandFetchStep>([
  'inside-design',
  'inside-esearch',
  'inside-dedup',
  'inside-efetch',
  'pick-seed',
]);

/**
 * 現在の step からトラッカーに表示するステップ一覧を選ぶ。
 * 'protocol' はモード分岐前の共通ステップなので margin の 6 段階をデフォルトにする
 * （margin モードが従来からの既定挙動であり、'protocol' の間はまだモードが確定していない）。
 * inside モードは母集団の選び方（チェックボックス。取得中は変更不可）で段数が変わる。
 */
function fetchStepsFor(
  step: ExpandFetchStep,
  insideStrategy: InsideStrategy
): readonly ExpandFetchStep[] {
  if (!INSIDE_ONLY_STEPS.has(step)) return MARGIN_FETCH_STEPS;
  return insideStrategy === 'specific' ? INSIDE_SPECIFIC_FETCH_STEPS : INSIDE_FETCH_STEPS;
}

/** チップに出す短いラベル */
const FETCH_STEP_LABELS: Record<ExpandFetchStep, MessageKey> = {
  protocol: 'expand.stepProtocol',
  broaden: 'expand.stepBroaden',
  esearch: 'expand.stepOutside',
  dedup: 'expand.stepDedup',
  efetch: 'expand.stepPapers',
  'pick-boundary': 'expand.stepPick',
  'inside-design': 'expand.stepDesign',
  'inside-esearch': 'expand.stepInside',
  'inside-dedup': 'expand.stepDedupInside',
  'inside-efetch': 'expand.stepPapersInside',
  'pick-seed': 'expand.stepPickSeed',
};

/**
 * ステータス 1 行表示用の進行中ラベル（〜中）。'done' は取得完了直後の経過表示にだけ使う
 * （通常は実行中＝いずれかの段階なので 'done' は出ない）。
 */
const FETCH_STEP_ACTIVE_LABELS: Record<ExpandFetchStep | 'done', MessageKey> = {
  protocol: 'expand.activeProtocol',
  broaden: 'expand.activeBroaden',
  esearch: 'expand.activeOutside',
  dedup: 'expand.activeDedup',
  efetch: 'expand.activePapers',
  'pick-boundary': 'expand.activePick',
  'inside-design': 'expand.activeDesign',
  'inside-esearch': 'expand.activeInside',
  'inside-dedup': 'expand.activeDedupInside',
  'inside-efetch': 'expand.activePapersInside',
  'pick-seed': 'expand.activePickSeed',
  done: 'expand.activeDone',
};

type StepState = 'done' | 'active' | 'pending';

function stepStateFor(stepIndex: number, current: number): StepState {
  if (stepIndex < current) {
    return 'done';
  }
  if (stepIndex === current) {
    return 'active';
  }
  return 'pending';
}

/** 1 ステップを表すチップ（✓ / ⟳ / ○ + ラベル）。draft__step クラスを共有して見た目を揃える */
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

function renderFetchTracker(
  doc: Document,
  run: ExpandRunState,
  insideStrategy: InsideStrategy
): HTMLElement {
  // renderFetchTracker は running 中にしか呼ばれないので run.step は必ず ExpandFetchStep
  // （'done' ではない）。fetchStepsFor がモード（margin / inside）に応じたステップ一覧を選ぶ。
  const step = run.step as ExpandFetchStep;
  const steps = fetchStepsFor(step, insideStrategy);
  const total = steps.length;
  const current = (steps as readonly string[]).indexOf(step);

  const section = doc.createElement('section');
  section.className = 'expand__tracker';

  // 上段: プログレスバー + ステップカウンタ
  const header = doc.createElement('div');
  header.className = 'draft__tracker-header';
  const bar = doc.createElement('progress');
  bar.className = 'draft__progressbar';
  bar.max = total;
  bar.value = Math.min(current, total);
  bar.setAttribute('aria-label', t('expand.fetchProgress'));
  const counter = doc.createElement('span');
  counter.className = 'draft__step-counter';
  counter.textContent = t('expand.stepCounter', { current: Math.min(current + 1, total), total });
  header.appendChild(bar);
  header.appendChild(counter);
  section.appendChild(header);

  // 下段: ステッパー（margin は 6 段階、inside は 5 段階。specific 式の設計が入ると 6 段階）
  const subWrap = doc.createElement('div');
  subWrap.className = 'draft__substeps';
  steps.forEach((s, i) => {
    subWrap.appendChild(renderStepChip(doc, t(FETCH_STEP_LABELS[s]), stepStateFor(i, current)));
  });
  section.appendChild(subWrap);

  return section;
}

/**
 * 実行中ステータスの 1 秒ごとの経過時間更新。
 * 再描画されると要素ごと DOM から外れるので、isConnected を見て自動停止する
 * （再描画後は新しい要素に対して新しい ticker が走る）。
 */
function startElapsedTicker(
  status: HTMLElement,
  step: ExpandFetchStep | 'done',
  startedAtMs: number
): void {
  const win = status.ownerDocument.defaultView;
  /* istanbul ignore if -- jsdom では defaultView は常に存在する */
  if (!win) {
    return;
  }
  const timer = win.setInterval(() => {
    if (!status.isConnected) {
      win.clearInterval(timer);
      return;
    }
    status.textContent = runningStatusText(step, startedAtMs);
  }, 1000);
}

function runningStatusText(step: ExpandFetchStep | 'done', startedAtMs: number): string {
  return t('expand.runningStatus', { step: t(FETCH_STEP_ACTIVE_LABELS[step]), elapsed: formatElapsed(Date.now() - startedAtMs) });
}

/**
 * 通信待ちの表示（issue #109）。
 *
 * NCBI の 429 は既定で最大 5 回・合計 31 秒待つ。これを出さないと画面は「取得中…」の
 * ままで、待っているのか固まったのかが利用者から区別できない。`role="status"` にして
 * 進捗トラッカーとは別の粒度で読み上げる（試行が進むたびに全体を読み直させない）。
 */
function renderApiWait(doc: Document, wait: ExpandApiWait): HTMLElement {
  const box = doc.createElement('p');
  box.className = 'expand__api-wait';
  box.setAttribute('role', 'status');
  box.textContent = apiWaitText(wait);
  return box;
}

function apiWaitText(wait: ExpandApiWait): string {
  if (wait.kind === 'rate_limit') {
    // 相手が 429 を返したわけではなく、こちらが枠（3 / 10 req/s）を守って待っている状態。
    return t('expand.rateWait', { source: wait.source });
  }
  const after =
    wait.waitMs === null ? t('expand.retryAfter') : t('expand.retrySeconds', { seconds: Math.max(1, Math.round(wait.waitMs / 1000)) });
  const count =
    wait.attempt === null || wait.maxAttempts === null
      ? ''
      : t('expand.retryCount', { attempt: wait.attempt, maxAttempts: wait.maxAttempts });
  return t('expand.retryWait', { source: wait.source, after, count });
}

interface ErrorGuidanceOptions {
  spreadsheetId: string;
  onOpenSpreadsheet?: (spreadsheetId: string) => void;
  onRequestSpreadsheetAccess?: (spreadsheetId: string) => Promise<PickerGrantResult>;
  onRetry: () => void;
}

/**
 * 失敗の分類ごとに「次に何をすればよいか」を出す（issue #109）。
 *
 * `other` は案内を出さない。分類できない失敗に一般論の再試行を勧めると、直らない操作を
 * 繰り返させることになるため、生のメッセージ（`.expand__error`）だけを残す。
 *
 * 配色は使わず、左ボーダーと文頭の記号で種類を示す。この淡い背景に `--color-warning` を
 * 文字色として載せると 3.02:1 で AA を割る実測が CLAUDE.md にあるため、文字色は既定の
 * `--color-text` に委ねている。
 */
function renderErrorGuidance(
  doc: Document,
  kind: ApiErrorKind | null,
  options: ErrorGuidanceOptions
): HTMLElement | null {
  if (kind === null || kind === 'other') return null;
  const panel = doc.createElement('section');
  panel.className = `expand__error-panel expand__error-panel--${kind}`;
  panel.setAttribute('role', 'alert');

  const title = doc.createElement('h3');
  title.className = 'expand__error-title';
  const body = doc.createElement('p');
  body.className = 'expand__error-body';
  panel.appendChild(title);
  panel.appendChild(body);

  if (kind === 'permission') {
    title.textContent = t('expand.permissionTitle');
    // 403 / 404 は「Picker 未選択」「共有されていない」「削除済み」「ID 誤り」のいずれでも
    // 返るため断定しない（popup の許可導線と同じ作法）。
    body.textContent = t('expand.permissionBody');
    const status = doc.createElement('p');
    status.className = 'expand__error-grant-status';
    status.setAttribute('role', 'status');
    const grant = doc.createElement('button');
    grant.type = 'button';
    grant.className = 'expand__error-action expand__error-action--grant';
    grant.textContent = t('expand.authorize');
    const writeOutcome = (message: string, retry: boolean): void => {
      // 許可待ちの間に再描画された場合は、現在のパネルへ結果を書く。
      const currentStatus = status.isConnected
        ? status
        : doc.querySelector('.expand__error-grant-status');
      if (currentStatus) currentStatus.textContent = message;
      if (retry) {
        // 許可待ちの間に許可エラー以外の画面（取得済みの候補一覧など）へ変わっていたら、
        // 自動の再取得でその画面を上書きしない。
        if (currentStatus) options.onRetry();
      } else {
        grant.disabled = false;
        const currentGrant = doc.querySelector<HTMLButtonElement>('.expand__error-action--grant');
        if (currentGrant) currentGrant.disabled = false;
      }
    };
    grant.addEventListener('click', async () => {
      if (!options.onRequestSpreadsheetAccess) return;
      grant.disabled = true;
      status.textContent = t('expand.grantOpening');
      try {
        const result = await options.onRequestSpreadsheetAccess(options.spreadsheetId);
        switch (result.status) {
          case 'granted':
            writeOutcome(t('expand.grantSuccess'), true);
            break;
          case 'cancelled':
            writeOutcome(t('expand.grantCancelled'), false);
            break;
          case 'busy':
            writeOutcome(t('expand.grantBusy'), false);
            break;
          case 'failed':
            writeOutcome(t('expand.grantFailed', { error: result.message }), false);
        }
      } catch (err) {
        writeOutcome(t('expand.grantException', { error: err instanceof Error ? err.message : String(err) }), false);
      }
    });
    panel.appendChild(grant);
    const open = doc.createElement('button');
    open.type = 'button';
    open.className = 'expand__error-action expand__error-action--open';
    open.textContent = t('expand.openSpreadsheet');
    open.addEventListener('click', () => options.onOpenSpreadsheet?.(options.spreadsheetId));
    panel.appendChild(open);
    panel.appendChild(status);
    return panel;
  }

  if (kind === 'rate_limit') {
    title.textContent = t('expand.rateTitle');
    body.textContent = t('expand.rateBody');
  } else {
    title.textContent = t('expand.temporaryTitle');
    body.textContent = t('expand.temporaryBody');
  }
  const retry = doc.createElement('button');
  retry.type = 'button';
  retry.className = 'expand__error-action';
  retry.textContent = t('expand.retry');
  retry.addEventListener('click', options.onRetry);
  panel.appendChild(retry);
  return panel;
}

function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return min > 0 ? t('expand.elapsedMinutes', { minutes: min, seconds: sec }) : t('expand.elapsedSeconds', { seconds: sec });
}

type ShortcutAction = (ctx: {
  focusNext: () => void;
  focusPrev: () => void;
  focusDown: () => void;
  focusUp: () => void;
  decide: (decision: SeedUserDecision) => void;
}) => void;

const KEY_HANDLERS: Record<string, ShortcutAction> = {
  i: ({ decide }) => decide('include'),
  e: ({ decide }) => decide('exclude'),
  m: ({ decide }) => decide('maybe'),
  n: ({ focusNext }) => focusNext(),
  ArrowRight: ({ focusNext }) => focusNext(),
  ArrowDown: ({ focusDown }) => focusDown(),
  p: ({ focusPrev }) => focusPrev(),
  ArrowLeft: ({ focusPrev }) => focusPrev(),
  ArrowUp: ({ focusUp }) => focusUp(),
};

function decideFocused(
  items: CandidateItemHandle[],
  focusIndex: number,
  decision: SeedUserDecision
): void {
  /* istanbul ignore if -- フェッチ完了後は setFocus(0) でインデックスが必ず有効化される */
  if (focusIndex < 0 || focusIndex >= items.length) return;
  const item = items[focusIndex]!;
  if (item.isDecided() || item.isPending()) return;
  item.decide(decision);
}

function clampIndex(index: number, length: number): number {
  /* istanbul ignore if -- setFocus 側で items 非空を保証しているため呼ばれない */
  if (length === 0) return -1;
  // 端で止める（循環しない）。0 未満は 0、length 以上は length - 1
  if (index < 0) return 0;
  if (index >= length) return length - 1;
  return index;
}

interface CandidateItemHooks {
  /** 判定が保存され確定した直後に呼ぶ（アクティブ移動・ラウンド完了判定・include 集計） */
  onDecided: (decision: SeedUserDecision) => void;
  /** ユーザーがこのカードの判定ボタンをマウスで押したときに呼ぶ（アクティブ同期） */
  onInteract: () => void;
}

function buildCandidateItem(
  doc: Document,
  candidate: BoundaryCaseView,
  onDecide: ExpandViewCallbacks['onDecide'],
  state: CandidateState,
  hooks: CandidateItemHooks
): CandidateItemHandle {
  const li = doc.createElement('li');
  li.className = 'expand__candidate';
  li.dataset['pmid'] = candidate.pmid;

  const head = doc.createElement('p');
  head.className = 'expand__candidate-head';
  const idSpan = doc.createElement('strong');
  idSpan.textContent = `PMID ${candidate.pmid}`;
  head.appendChild(idSpan);
  const meta = doc.createElement('span');
  meta.className = 'expand__candidate-meta';
  const year = candidate.year === null ? '-' : String(candidate.year);
  meta.textContent = ` (${year}) ${candidate.title ?? t('expand.noTitle')}`;
  head.appendChild(meta);
  li.appendChild(head);

  const reason = doc.createElement('p');
  reason.className = 'expand__candidate-reason';
  reason.textContent = t('expand.candidateReason', { reason: candidate.reason === '' ? t('expand.noReason') : candidate.reason });
  li.appendChild(reason);

  // アブストラクト本文。常時 DOM に置き、表示はフォーカス中カードのみ（CSS で制御）。
  const abstractWrap = doc.createElement('div');
  abstractWrap.className = 'expand__candidate-abstract';
  const abstractLabel = doc.createElement('div');
  abstractLabel.className = 'expand__candidate-abstract-label';
  abstractLabel.textContent = t('expand.abstract');
  abstractWrap.appendChild(abstractLabel);
  const abstractBody = doc.createElement('p');
  if (candidate.abstract === null || candidate.abstract === '') {
    abstractBody.className = 'expand__candidate-abstract-body expand__candidate-abstract-body--empty';
    abstractBody.textContent = t('expand.noAbstract');
  } else {
    abstractBody.className = 'expand__candidate-abstract-body';
    // textContent で代入（XSS 回避）。構造化抄録の改行は white-space: pre-wrap で保持。
    abstractBody.textContent = candidate.abstract;
  }
  abstractWrap.appendChild(abstractBody);
  li.appendChild(abstractWrap);

  const decisionRow = doc.createElement('div');
  decisionRow.className = 'expand__candidate-actions';
  const status = doc.createElement('span');
  status.className = 'expand__candidate-status';
  decisionRow.appendChild(status);

  const buttons: Record<SeedUserDecision, HTMLButtonElement> = {
    include: makeBtn(doc, t('expand.include'), 'include'),
    exclude: makeBtn(doc, t('expand.exclude'), 'exclude'),
    maybe: makeBtn(doc, t('expand.maybe'), 'maybe'),
  };

  state.onDecided = hooks.onDecided;
  state.refresh = () => {
    li.classList.toggle('expand__candidate--decided', state.decided);
    for (const button of Object.values(buttons)) {
      button.disabled = state.pending || state.decided;
    }
    if (state.error !== undefined) {
      status.textContent = t('expand.saveFailed', { error: state.error });
    } else if (state.decision !== undefined) {
      status.textContent = t(state.pending ? 'expand.deciding' : 'expand.decisionSaved', { decision: state.decision });
    }
  };
  state.refresh();
  const triggerDecision = (decision: SeedUserDecision): void => {
    if (!onDecide) {
      return;
    }
    if (state.decided || state.pending) {
      return;
    }
    state.pending = true;
    state.decision = decision;
    state.error = undefined;
    state.refresh?.();
    onDecide({
      pmid: candidate.pmid,
      title: candidate.title,
      year: candidate.year,
      decision,
      reason: candidate.reason,
    })
      .then(() => {
        state.pending = false;
        state.decided = true;
        state.refresh?.();
        state.onDecided?.(decision);
      })
      .catch((err: unknown) => {
        state.pending = false;
        state.error = formatError(err);
        state.refresh?.();
      });
  };

  for (const decision of ['include', 'exclude', 'maybe'] as const) {
    const btn = buttons[decision];
    btn.addEventListener('click', () => {
      // クリックしたカードへアクティブ表示を寄せてから判定する。判定後の自動前進
      // （onDecided → focusNext）が正しい起点（このカード）から走るようにする。
      hooks.onInteract();
      triggerDecision(decision);
    });
    decisionRow.appendChild(btn);
  }
  li.appendChild(decisionRow);
  return {
    element: li,
    decide: triggerDecision,
    isDecided: () => state.decided,
    isPending: () => state.pending,
  };
}

function makeBtn(doc: Document, label: string, decision: SeedUserDecision): HTMLButtonElement {
  const btn = doc.createElement('button');
  btn.type = 'button';
  btn.textContent = label;
  btn.dataset['decision'] = decision;
  return btn;
}

function runRoundComplete(
  doc: Document,
  round: HTMLElement,
  onRoundComplete: ExpandViewCallbacks['onRoundComplete'],
  includedPapers: IncludedPaper[],
  additions: BoundaryCasesResult['additions'],
  mode: BoundaryCasesResult['mode'],
  session: CandidateSession
): void {
  const proposals = buildUpdateProposals(includedPapers, additions);
  session.refreshRound = () => {
    round.innerHTML = '';
    if (session.roundError !== undefined) {
      const error = doc.createElement('p');
      error.className = 'expand__round-error';
      error.textContent = t('expand.roundFailed', { error: session.roundError });
      round.appendChild(error);
      return;
    }
    if (session.roundSummary) {
      round.appendChild(buildRoundSummary(doc, session.roundSummary));
    } else {
      const status = doc.createElement('p');
      status.className = callbacksEnabled ? 'expand__round-status' : 'expand__round-note';
      status.setAttribute('aria-live', 'polite');
      status.textContent = t(callbacksEnabled ? 'expand.roundRunning' : 'expand.roundManual');
      round.appendChild(status);
      if (callbacksEnabled) {
        return;
      }
    }
    if (mode === 'inside') {
      round.appendChild(buildInsideRoundNote(doc, includedPapers.length));
    }
    if (proposals.length > 0) {
      round.appendChild(buildProposals(doc, proposals));
    }
  };
  const callbacksEnabled = session.roundPending || onRoundComplete !== undefined;
  session.refreshRound();
  if (!onRoundComplete) {
    return;
  }
  session.roundPending = true;
  onRoundComplete()
    .then((summary) => {
      session.roundSummary = summary;
      session.roundPending = false;
      session.refreshRound?.();
    })
    .catch((err: unknown) => {
      session.roundError = formatError(err);
      session.roundPending = false;
      session.refreshRound?.();
    });
}

/**
 * 検索式更新提案の描画。include したのに現式が逃した論文を、どの拡張語が拾えたかで
 * ブロック単位に集計したもの（buildUpdateProposals の出力）。採用はユーザーが /draft で
 * 行う前提で、ここでは「ブロック #N にこの語を足すと M 件回収」を提示する（推定）。
 */
function buildProposals(doc: Document, proposals: UpdateProposal[]): HTMLElement {
  const wrap = doc.createElement('section');
  wrap.className = 'expand__proposals';
  wrap.dataset.tour = 'expand-proposals';
  const title = doc.createElement('h3');
  title.textContent = t('expand.proposalsTitle');
  wrap.appendChild(title);

  const note = doc.createElement('p');
  note.className = 'expand__proposals-note';
  note.textContent = t('expand.proposalsNote');
  wrap.appendChild(note);

  for (const proposal of proposals) {
    const block = doc.createElement('div');
    block.className = 'expand__proposal';
    const head = doc.createElement('p');
    head.className = 'expand__proposal-head';
    head.textContent = t('expand.proposalBlock', { blockId: proposal.blockId, count: proposal.recoveredPmids.length });
    block.appendChild(head);

    const ul = doc.createElement('ul');
    ul.className = 'expand__proposal-terms';
    for (const term of proposal.terms) {
      const li = doc.createElement('li');
      const axis = term.axis === 'mesh' ? 'MeSH' : 'freeword';
      const code = doc.createElement('code');
      code.textContent = term.term;
      li.appendChild(code);
      const meta = doc.createElement('span');
      meta.className = 'expand__proposal-term-meta';
      meta.textContent = t('expand.proposalTerm', { axis, count: term.recoveredPmids.length, rationale: term.rationale });
      li.appendChild(meta);
      ul.appendChild(li);
    }
    block.appendChild(ul);
    wrap.appendChild(block);
  }
  return wrap;
}

/**
 * inside モード（有効 seed 0 件）であることを冒頭で知らせるバナー。
 * 「式の外側探索」を期待しているユーザーに、今回は初期シード作りだと伝える。
 */
function renderInsideBanner(doc: Document): HTMLElement {
  const banner = doc.createElement('p');
  banner.className = 'expand__inside-banner';
  banner.setAttribute('role', 'note');
  banner.textContent = t('expand.insideBanner');
  return banner;
}

/** inside モードのラウンド完了時に添える補足（捕捉率 100% は想定どおりであること）。 */
function buildInsideRoundNote(doc: Document, includedCount: number): HTMLElement {
  const note = doc.createElement('p');
  note.className = 'expand__round-note';
  note.textContent =
    includedCount > 0
      ? t('expand.insideRoundAdded', { count: includedCount })
      : t('expand.insideRoundEmpty');
  return note;
}

/** inside モードで候補が 1 件以上あるときのステータス文。母集団（specific 式 / 現式）を明示する。 */
function insideStatusText(result: BoundaryCasesResult): string {
  const specific = result.specific;
  if (specific !== null && specific.fallback === null) {
    return t('expand.insideSpecificStatus', { count: result.candidates.length, hits: specific.hits, evaluatedCount: result.evaluatedCount, originalHits: result.originalHits });
  }
  return t('expand.insideStatus', { count: result.candidates.length, originalHits: result.originalHits, evaluatedCount: result.evaluatedCount });
}

/** specific 式にフォールバックが起きたときの案内文。 */
const SPECIFIC_FALLBACK_TEXT: Record<SpecificQueryFallback, MessageKey> = {
  design_failed:
    'expand.fallbackDesign',
  zero_hits:
    'expand.fallbackZero',
  search_failed:
    'expand.fallbackSearch',
};

/**
 * AI が設計した specific 式（inside モード・issue #93）を候補一覧の上に表示する。
 * 「どの式の上位から候補を選んだか」をユーザーが確認できるようにするのが目的で、
 * フォールバックしたときはその理由も添える。
 */
function renderSpecificQuery(doc: Document, specific: SpecificQueryOutcome): HTMLElement {
  const wrap = doc.createElement('section');
  wrap.className = 'expand__specific';
  const title = doc.createElement('h3');
  title.className = 'expand__specific-title';
  title.textContent = t('expand.specificTitle');
  wrap.appendChild(title);

  if (specific.query !== null) {
    const pre = doc.createElement('pre');
    pre.className = 'expand__specific-query';
    const code = doc.createElement('code');
    code.textContent = specific.query;
    pre.appendChild(code);
    wrap.appendChild(pre);
    const meta = doc.createElement('p');
    meta.className = 'expand__specific-meta';
    const rationale = specific.rationale ? t('expand.specificRationale', { rationale: specific.rationale }) : '';
    meta.textContent = t('expand.specificHits', { rationale, hits: specific.hits });
    wrap.appendChild(meta);
  }
  if (specific.fallback !== null) {
    const note = doc.createElement('p');
    note.className = 'expand__specific-fallback';
    note.setAttribute('role', 'note');
    note.textContent = `⚠ ${t(SPECIFIC_FALLBACK_TEXT[specific.fallback])}`;
    wrap.appendChild(note);
  }
  return wrap;
}

/** 候補 0 件のときのステータス文（理由・モードを分けて伝える）。 */
function emptyResultText(result: BoundaryCasesResult): string {
  if (result.mode === 'inside') {
    const specific = result.specific;
    if (specific !== null && specific.fallback === null) {
      return t('expand.emptySpecific', { hits: specific.hits, originalHits: result.originalHits });
    }
    if (result.originalHits === 0) {
      return t('expand.emptyInsideZero');
    }
    return t('expand.emptyInside', { hits: result.originalHits });
  }
  if (result.additions.length === 0) {
    return t('expand.emptyAdditions');
  }
  if (result.marginHits === 0) {
    return t('expand.emptyMarginZero', { hits: result.originalHits });
  }
  return t('expand.emptyMargin', { marginHits: result.marginHits, originalHits: result.originalHits });
}

function buildRoundSummary(doc: Document, summary: ValidationSummary): HTMLElement {
  const wrap = doc.createElement('div');
  wrap.className = 'expand__round-summary';
  const title = doc.createElement('h3');
  title.textContent = t('expand.roundTitle');
  wrap.appendChild(title);

  const seedsLine = doc.createElement('p');
  seedsLine.textContent = t('expand.validSeeds', { eligible: summary.eligibleSeedCount, total: summary.totalSeedCount });
  wrap.appendChild(seedsLine);

  const rate = doc.createElement('p');
  if (summary.finalQueryError !== null) {
    rate.textContent = t('expand.finalQueryFailed', { error: summary.finalQueryError });
    rate.className = 'expand__round-error';
  } else {
    const captured = summary.finalQuery.capturedPmids.length;
    const total = captured + summary.finalQuery.missedPmids.length;
    if (summary.finalQuery.captureRate === null) {
      rate.textContent = t('expand.captureUnmeasured');
    } else {
      const percent = (summary.finalQuery.captureRate * 100).toFixed(1);
      rate.textContent = t('expand.captureRate', { percent, captured, total });
    }
  }
  wrap.appendChild(rate);
  return wrap;
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
