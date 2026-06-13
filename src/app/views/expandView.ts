import type {
  BoundaryCaseView,
  BoundaryCasesResult,
  ExpandFetchStep,
  RecordDecisionInput,
  RecordDecisionResult,
  ValidationSummary,
} from '@/app/services';
import type { SeedUserDecision } from '@/domain/seedPaper';
import { ROUTE_LABELS } from '../router';
import type { ExpandRunState } from '../store';
import type { RenderView } from './types';

/**
 * 対話的 seed 拡張画面（#/expand）。
 *
 * - 「境界事例を取得」ボタンで onFetch（bootstrap が fetchBoundaryCandidates をラップ）を実行
 * - 取得の進捗（プロトコル取得 → PubMed 検索 → 重複除去 → 候補論文取得 → AI 選定）を
 *   進捗トラッカーで可視化する。draft 画面（生成・検証）と同じく「いま何をやっているか」を
 *   見せるのが狙い。進捗・取得結果は store.expandRun から描画する（理由は後述）
 * - 取得した候補を一覧表示し、include / exclude / maybe ボタンを提示
 * - 判定が押されたら onDecide（recordDecision）を呼び、対応カードの状態を更新
 * - 1 ラウンド（候補すべて）を判定し終えたら onRoundComplete で
 *   check_final_query 相当の再検証を自動実行し、新しい捕捉率を表示する
 *   （requirements.md §4.5）
 *
 * **なぜ進捗・候補を store に持たせるか**:
 * fetchBoundaryCandidates の最後の AI 選定（LLM）完了時に LLM コスト集計
 * （cumulativeCostUsd）の setState が走り、expand ビューも含めた全ビューが再描画される。
 * 進捗・取得結果をローカル DOM に書くとこの再描画で消えてしまうため、store.expandRun に
 * 保持して再描画に耐えるようにする（draftRun / validationResult と同じ理由）。
 * 一方、候補の判定（recordDecision）とラウンド完了の再検証（runValidation）は LLM を
 * 呼ばず setState を起こさない（= 再描画されない）ため、判定 UI と再検証結果はビュー側の
 * ローカル DOM で扱う。
 *
 * **キーボードショートカット**（requirements.md §7、ui-flow.md §6）:
 * - `i` / `e` / `m`: 現在フォーカス中の候補を include / exclude / maybe で判定
 * - `n` / `→`: 次の未判定候補へフォーカス移動（無ければ次のカードへ）
 * - `p` / `←`: 前のカードへフォーカス移動
 *
 * 実ロジック（onFetch / onDecide / onRoundComplete）は bootstrap で service を
 * ラップして渡す。
 */

export interface ExpandViewCallbacks {
  /** 「境界事例を取得」ボタン。進捗・取得結果は store.expandRun 経由で反映される */
  onFetch?: () => Promise<void>;
  onDecide?: (input: RecordDecisionInput) => Promise<RecordDecisionResult>;
  /** ラウンド完了時の再検証コールバック。check_final_query 相当を期待 */
  onRoundComplete?: () => Promise<ValidationSummary>;
}

interface CandidateItemHandle {
  element: HTMLElement;
  decide: (decision: SeedUserDecision) => void;
  isDecided: () => boolean;
  isPending: () => boolean;
}

export function createExpandView(callbacks: ExpandViewCallbacks = {}): RenderView {
  return (container, ctx) => {
    container.innerHTML = '';
    const doc = container.ownerDocument;
    const heading = doc.createElement('h2');
    heading.textContent = ROUTE_LABELS.expand;
    container.appendChild(heading);

    if (!ctx.state.project) {
      const warn = doc.createElement('p');
      warn.className = 'view__placeholder';
      warn.textContent = '先にプロジェクトを選択してください。';
      container.appendChild(warn);
      return;
    }
    if (!ctx.state.currentFormulaMarkdown) {
      const warn = doc.createElement('p');
      warn.className = 'view__placeholder';
      warn.textContent = '先に /draft で検索式を生成してください。';
      container.appendChild(warn);
      return;
    }

    const lead = doc.createElement('p');
    lead.className = 'expand__lead';
    lead.textContent =
      '現在の検索式で PubMed を検索し、判定が迷いやすい候補を数件抽出します。include 判定は SeedPapers に追加され、ラウンド終了時に自動で再検証して新しい捕捉率を表示します。';
    container.appendChild(lead);

    const shortcuts = doc.createElement('p');
    shortcuts.className = 'expand__shortcuts';
    shortcuts.textContent =
      'ショートカット: i = include / e = exclude / m = maybe / n または → = 次へ / p または ← = 前へ';
    container.appendChild(shortcuts);

    const run = ctx.state.expandRun;
    const running = run?.status === 'running';

    const actions = doc.createElement('div');
    actions.className = 'expand__actions';
    const fetchBtn = doc.createElement('button');
    fetchBtn.type = 'button';
    fetchBtn.textContent = running ? '取得中…' : '境界事例を取得';
    fetchBtn.disabled = running;
    actions.appendChild(fetchBtn);
    container.appendChild(actions);

    // 取得中は「全体のどこか」を示す進捗トラッカーを出す（draft 画面と同じ見た目）。
    // 長い LLM 待ち（AI 選定）でも残りの段階が見えるようにする。
    if (running && run) {
      container.appendChild(renderFetchTracker(doc, run));
    }

    const status = doc.createElement('p');
    status.className = 'expand__status';
    status.setAttribute('aria-live', 'polite');
    container.appendChild(status);

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

    fetchBtn.addEventListener('click', () => {
      if (!callbacks.onFetch || fetchBtn.disabled) {
        return;
      }
      // 状態遷移（expandRun の running 設定）は bootstrap 側。setState → 再描画で
      // ボタンが即座に無効化されるため、ここでのローカル無効化は保険のみ
      fetchBtn.disabled = true;
      void callbacks.onFetch();
    });

    if (running && run) {
      status.textContent = runningStatusText(run.step, run.startedAtMs);
      startElapsedTicker(status, run.step, run.startedAtMs);
      return;
    }
    if (run?.status === 'error') {
      errorBox.textContent = run.error ?? '不明なエラー';
      return;
    }
    if (run?.status === 'ready' && run.result) {
      const result = run.result;
      status.textContent = `${result.candidates.length} 件の境界事例が見つかりました（全ヒット ${result.totalHits} / 評価対象 ${result.evaluatedCount}）`;
      setupCandidates(doc, list, round, result, callbacks);
    }
  };
}

/**
 * 取得結果（store 保持）から候補カードを組み立て、判定・キーボード操作・ラウンド完了の
 * ローカルな対話ロジックを配線する。
 *
 * 取得完了（status='ready'）後は recordDecision / runValidation とも setState を
 * 起こさない（再描画されない）ため、items / focusIndex / roundTriggered といった対話状態は
 * この描画 1 回ぶんのクロージャに閉じてよい。
 */
function setupCandidates(
  doc: Document,
  list: HTMLElement,
  round: HTMLElement,
  result: BoundaryCasesResult,
  callbacks: ExpandViewCallbacks
): void {
  const items: CandidateItemHandle[] = [];
  let focusIndex = -1;
  let roundTriggered = false;

  const setFocus = (index: number): void => {
    /* istanbul ignore if -- 呼び出し側で items.length > 0 を保証しているための防御 */
    if (items.length === 0) return;
    const next = clampIndex(index, items.length);
    focusIndex = next;
    for (let i = 0; i < items.length; i++) {
      items[i]!.element.classList.toggle('expand__candidate--focused', i === next);
    }
    const target = items[next]!.element;
    // jsdom には scrollIntoView が無いのでガードして無視する
    if (typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ block: 'nearest' });
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
    if (roundTriggered) return;
    /* istanbul ignore if -- onDecided は items が非空のときにのみ呼ばれる */
    if (items.length === 0) return;
    if (!items.every((it) => it.isDecided())) return;
    roundTriggered = true;
    runRoundComplete(doc, round, callbacks.onRoundComplete);
  };

  list.addEventListener('keydown', (event) => {
    if (items.length === 0) return;
    const handler = KEY_HANDLERS[event.key];
    if (!handler) return;
    event.preventDefault();
    handler({ focusNext, focusPrev, decide: (d) => decideFocused(items, focusIndex, d) });
  });

  for (const candidate of result.candidates) {
    const handle = buildCandidateItem(doc, candidate, callbacks.onDecide, checkRoundComplete);
    list.appendChild(handle.element);
    items.push(handle);
  }
  if (items.length > 0) {
    setFocus(0);
    list.focus();
  }
}

// --- 取得の進捗トラッカー（プログレスバー + ステップカウンタ + ステッパー）---------------
// チップ／プログレスバーは draft 画面（生成・検証）と見た目を揃えるため、draft__ の
// 視覚プリミティブ（.draft__step / .draft__progressbar / .draft__substeps）を再利用する。

/** 取得パイプラインのステップ（順序固定）。1 回の取得でこの 5 段階を踏む */
const FETCH_STEPS = ['protocol', 'esearch', 'dedup', 'efetch', 'pick-boundary'] as const;

/** チップに出す短いラベル */
const FETCH_STEP_LABELS: Record<ExpandFetchStep, string> = {
  protocol: 'プロトコル取得',
  esearch: 'PubMed 検索',
  dedup: '重複除去',
  efetch: '候補論文の取得',
  'pick-boundary': 'AI 選定',
};

/**
 * ステータス 1 行表示用の進行中ラベル（〜中）。'done' は取得完了直後の経過表示にだけ使う
 * （通常は実行中＝5 段階のいずれかなので 'done' は出ない）。
 */
const FETCH_STEP_ACTIVE_LABELS: Record<ExpandFetchStep | 'done', string> = {
  protocol: 'プロトコルを取得中',
  esearch: '検索式で PubMed を検索中',
  dedup: '既存 seed と重複を除去中',
  efetch: '候補論文のメタデータを取得中',
  'pick-boundary': 'AI が境界事例を選定中',
  done: '完了',
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

function renderFetchTracker(doc: Document, run: ExpandRunState): HTMLElement {
  const total = FETCH_STEPS.length;
  // 実行中の step は必ず 5 段階のいずれかなので indexOf は 0..4。'done' は実行中には来ない。
  const current = (FETCH_STEPS as readonly string[]).indexOf(run.step);

  const section = doc.createElement('section');
  section.className = 'expand__tracker';

  // 上段: プログレスバー + ステップカウンタ
  const header = doc.createElement('div');
  header.className = 'draft__tracker-header';
  const bar = doc.createElement('progress');
  bar.className = 'draft__progressbar';
  bar.max = total;
  bar.value = Math.min(current, total);
  bar.setAttribute('aria-label', '取得の進捗');
  const counter = doc.createElement('span');
  counter.className = 'draft__step-counter';
  counter.textContent = `ステップ ${Math.min(current + 1, total)} / ${total}`;
  header.appendChild(bar);
  header.appendChild(counter);
  section.appendChild(header);

  // 下段: 5 段階のステッパー
  const subWrap = doc.createElement('div');
  subWrap.className = 'draft__substeps';
  FETCH_STEPS.forEach((step, i) => {
    subWrap.appendChild(renderStepChip(doc, FETCH_STEP_LABELS[step], stepStateFor(i, current)));
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
  return `[取得] ${FETCH_STEP_ACTIVE_LABELS[step]}（経過 ${formatElapsed(Date.now() - startedAtMs)}）`;
}

function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return min > 0 ? `${min}分${sec}秒` : `${sec}秒`;
}

type ShortcutAction = (ctx: {
  focusNext: () => void;
  focusPrev: () => void;
  decide: (decision: SeedUserDecision) => void;
}) => void;

const KEY_HANDLERS: Record<string, ShortcutAction> = {
  i: ({ decide }) => decide('include'),
  e: ({ decide }) => decide('exclude'),
  m: ({ decide }) => decide('maybe'),
  n: ({ focusNext }) => focusNext(),
  ArrowRight: ({ focusNext }) => focusNext(),
  p: ({ focusPrev }) => focusPrev(),
  ArrowLeft: ({ focusPrev }) => focusPrev(),
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

function buildCandidateItem(
  doc: Document,
  candidate: BoundaryCaseView,
  onDecide: ExpandViewCallbacks['onDecide'],
  onDecided: () => void
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
  meta.textContent = ` (${year}) ${candidate.title ?? '(no title)'}`;
  head.appendChild(meta);
  li.appendChild(head);

  const reason = doc.createElement('p');
  reason.className = 'expand__candidate-reason';
  reason.textContent = `迷う理由: ${candidate.reason === '' ? '(無し)' : candidate.reason}`;
  li.appendChild(reason);

  const decisionRow = doc.createElement('div');
  decisionRow.className = 'expand__candidate-actions';
  const status = doc.createElement('span');
  status.className = 'expand__candidate-status';
  decisionRow.appendChild(status);

  const buttons: Record<SeedUserDecision, HTMLButtonElement> = {
    include: makeBtn(doc, 'include', 'include'),
    exclude: makeBtn(doc, 'exclude', 'exclude'),
    maybe: makeBtn(doc, 'maybe', 'maybe'),
  };

  let decided = false;
  let pending = false;
  const triggerDecision = (decision: SeedUserDecision): void => {
    if (!onDecide) return;
    /* istanbul ignore if -- decideFocused 側で isDecided() ガード済み + button.disabled でも防がれる */
    if (decided || pending) return;
    pending = true;
    const btn = buttons[decision];
    btn.disabled = true;
    const others = (Object.keys(buttons) as SeedUserDecision[])
      .filter((k) => k !== decision)
      .map((k) => buttons[k]);
    others.forEach((b) => (b.disabled = true));
    status.textContent = `${decision} 判定中…`;
    onDecide({
      pmid: candidate.pmid,
      title: candidate.title,
      year: candidate.year,
      decision,
      reason: candidate.reason,
    })
      .then(() => {
        status.textContent = `${decision} として保存しました`;
        li.classList.add('expand__candidate--decided');
        pending = false;
        decided = true;
        onDecided();
      })
      .catch((err: unknown) => {
        pending = false;
        status.textContent = `保存失敗: ${formatError(err)}`;
        btn.disabled = false;
        others.forEach((b) => (b.disabled = false));
      });
  };

  for (const decision of ['include', 'exclude', 'maybe'] as const) {
    const btn = buttons[decision];
    btn.addEventListener('click', () => triggerDecision(decision));
    decisionRow.appendChild(btn);
  }
  li.appendChild(decisionRow);
  return {
    element: li,
    decide: triggerDecision,
    isDecided: () => decided,
    isPending: () => pending,
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
  onRoundComplete: ExpandViewCallbacks['onRoundComplete']
): void {
  round.innerHTML = '';
  if (!onRoundComplete) {
    const note = doc.createElement('p');
    note.className = 'expand__round-note';
    note.textContent =
      'ラウンド完了。/validate を開いて捕捉率を再確認してください（自動再検証は無効）。';
    round.appendChild(note);
    return;
  }
  const status = doc.createElement('p');
  status.className = 'expand__round-status';
  status.setAttribute('aria-live', 'polite');
  status.textContent = 'ラウンド完了。再検証を実行中…';
  round.appendChild(status);
  onRoundComplete()
    .then((summary) => {
      round.innerHTML = '';
      round.appendChild(buildRoundSummary(doc, summary));
    })
    .catch((err: unknown) => {
      round.innerHTML = '';
      const error = doc.createElement('p');
      error.className = 'expand__round-error';
      error.textContent = `再検証に失敗しました: ${formatError(err)}`;
      round.appendChild(error);
    });
}

function buildRoundSummary(doc: Document, summary: ValidationSummary): HTMLElement {
  const wrap = doc.createElement('div');
  wrap.className = 'expand__round-summary';
  const title = doc.createElement('h3');
  title.textContent = '再検証結果（ラウンド完了）';
  wrap.appendChild(title);

  const seedsLine = doc.createElement('p');
  seedsLine.textContent = `有効 seed: ${summary.eligibleSeedCount} / ${summary.totalSeedCount} 件`;
  wrap.appendChild(seedsLine);

  const rate = doc.createElement('p');
  if (summary.finalQueryError !== null) {
    rate.textContent = `final_query 取得に失敗: ${summary.finalQueryError}`;
    rate.className = 'expand__round-error';
  } else {
    const captured = summary.finalQuery.capturedPmids.length;
    const total = captured + summary.finalQuery.missedPmids.length;
    if (total === 0) {
      rate.textContent = '捕捉率: （有効 seed 0 件のため計算不能）';
    } else {
      const percent = (summary.finalQuery.captureRate * 100).toFixed(1);
      rate.textContent = `捕捉率: ${percent}% (${captured}/${total})`;
    }
  }
  wrap.appendChild(rate);
  return wrap;
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
