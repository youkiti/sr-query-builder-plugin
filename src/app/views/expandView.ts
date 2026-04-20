import type {
  BoundaryCaseView,
  BoundaryCasesResult,
  RecordDecisionInput,
  RecordDecisionResult,
  ValidationSummary,
} from '@/app/services';
import type { SeedUserDecision } from '@/domain/seedPaper';
import { ROUTE_LABELS } from '../router';
import type { RenderView } from './types';

/**
 * 対話的 seed 拡張画面（#/expand）。
 *
 * - 「境界事例を取得」ボタンで expandService.fetchBoundaryCandidates を実行
 * - 取得した候補を一覧表示し、include / exclude / maybe ボタンを提示
 * - 判定が押されたら expandService.recordDecision を呼び、対応カードの状態を更新
 * - 1 ラウンド（候補すべて）を判定し終えたら onRoundComplete で
 *   check_final_query 相当の再検証を自動実行し、新しい捕捉率を表示する
 *   （requirements.md §4.5）
 *
 * **キーボードショートカット**（requirements.md §7、ui-flow.md §6）:
 * - `i` / `e` / `m`: 現在フォーカス中の候補を include / exclude / maybe で判定
 * - `n` / `→`: 次の未判定候補へフォーカス移動（無ければ次のカードへ）
 * - `p` / `←`: 前のカードへフォーカス移動
 *
 * 実ロジック（onFetch / onDecide / onRoundComplete）は bootstrap で
 * service をラップして渡す。
 */

export interface ExpandViewCallbacks {
  onFetch?: () => Promise<BoundaryCasesResult>;
  onDecide?: (input: RecordDecisionInput) => Promise<RecordDecisionResult>;
  /** ラウンド完了時の再検証コールバック。check_final_query 相当を期待 */
  onRoundComplete?: () => Promise<ValidationSummary>;
}

interface CandidateItemHandle {
  element: HTMLElement;
  decide: (decision: SeedUserDecision) => void;
  isDecided: () => boolean;
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

    const actions = doc.createElement('div');
    actions.className = 'expand__actions';
    const fetchBtn = doc.createElement('button');
    fetchBtn.type = 'button';
    fetchBtn.textContent = '境界事例を取得';
    actions.appendChild(fetchBtn);
    container.appendChild(actions);

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

    fetchBtn.addEventListener('click', () => {
      if (!callbacks.onFetch) {
        return;
      }
      fetchBtn.disabled = true;
      status.textContent = '候補取得中…';
      errorBox.textContent = '';
      list.innerHTML = '';
      round.innerHTML = '';
      items.length = 0;
      focusIndex = -1;
      roundTriggered = false;
      callbacks
        .onFetch()
        .then((result) => {
          status.textContent = `${result.candidates.length} 件の境界事例が見つかりました（全ヒット ${result.totalHits} / 評価対象 ${result.evaluatedCount}）`;
          for (const candidate of result.candidates) {
            const handle = buildCandidateItem(
              doc,
              candidate,
              callbacks.onDecide,
              checkRoundComplete
            );
            list.appendChild(handle.element);
            items.push(handle);
          }
          if (items.length > 0) {
            setFocus(0);
            list.focus();
          }
        })
        .catch((err: unknown) => {
          errorBox.textContent = formatError(err);
          status.textContent = '';
        })
        .finally(() => {
          fetchBtn.disabled = false;
        });
    });
  };
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
  if (item.isDecided()) return;
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
  const triggerDecision = (decision: SeedUserDecision): void => {
    if (!onDecide) return;
    /* istanbul ignore if -- decideFocused 側で isDecided() ガード済み + button.disabled でも防がれる */
    if (decided) return;
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
        decided = true;
        onDecided();
      })
      .catch((err: unknown) => {
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
