import type {
  BoundaryCaseView,
  BoundaryCasesResult,
  RecordDecisionInput,
  RecordDecisionResult,
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
 *
 * 実ロジック（onFetch / onDecide）は bootstrap で service をラップして渡す。
 */

export interface ExpandViewCallbacks {
  onFetch?: () => Promise<BoundaryCasesResult>;
  onDecide?: (input: RecordDecisionInput) => Promise<RecordDecisionResult>;
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
      '現在の検索式で PubMed を検索し、判定が迷いやすい候補を数件抽出します。include 判定は SeedPapers に追加され、再検証で捕捉率が更新できます。';
    container.appendChild(lead);

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
    container.appendChild(list);

    fetchBtn.addEventListener('click', () => {
      if (!callbacks.onFetch) {
        return;
      }
      fetchBtn.disabled = true;
      status.textContent = '候補取得中…';
      errorBox.textContent = '';
      list.innerHTML = '';
      callbacks
        .onFetch()
        .then((result) => {
          status.textContent = `${result.candidates.length} 件の境界事例が見つかりました（全ヒット ${result.totalHits} / 評価対象 ${result.evaluatedCount}）`;
          for (const candidate of result.candidates) {
            list.appendChild(buildCandidateItem(doc, candidate, callbacks.onDecide));
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

function buildCandidateItem(
  doc: Document,
  candidate: BoundaryCaseView,
  onDecide: ExpandViewCallbacks['onDecide']
): HTMLElement {
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

  const makeBtn = (label: string, decision: SeedUserDecision): HTMLButtonElement => {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.dataset['decision'] = decision;
    btn.addEventListener('click', () => {
      if (!onDecide) {
        return;
      }
      btn.disabled = true;
      const others = Array.from(
        decisionRow.querySelectorAll<HTMLButtonElement>('button')
      ).filter((b) => b !== btn);
      others.forEach((b) => (b.disabled = true));
      status.textContent = `${label} 判定中…`;
      onDecide({
        pmid: candidate.pmid,
        title: candidate.title,
        year: candidate.year,
        decision,
        reason: candidate.reason,
      })
        .then(() => {
          status.textContent = `${label} として保存しました`;
          li.classList.add('expand__candidate--decided');
        })
        .catch((err: unknown) => {
          status.textContent = `保存失敗: ${formatError(err)}`;
          btn.disabled = false;
          others.forEach((b) => (b.disabled = false));
        });
    });
    return btn;
  };

  decisionRow.appendChild(makeBtn('include', 'include'));
  decisionRow.appendChild(makeBtn('exclude', 'exclude'));
  decisionRow.appendChild(makeBtn('maybe', 'maybe'));
  li.appendChild(decisionRow);
  return li;
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
