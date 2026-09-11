import { serializePubmedFormulaMd } from '@/lib/search-formula-md';
import type { QueryOptimizationRunState } from '../store';

export interface OptimizationReviewActions {
  adopt: (() => Promise<void>) | undefined;
  edit: (() => void) | undefined;
}

/** 最終候補と初期式を直接比較する。却下案や途中で戻した変更は最終差分へ混ぜない。 */
export function renderOptimizationReview(
  container: HTMLElement, run: QueryOptimizationRunState | null, actions: OptimizationReviewActions
): void {
  if (!run || run.status === 'running') return;
  const doc = container.ownerDocument;
  const section = doc.createElement('section');
  section.className = 'optimization__review';
  section.setAttribute('aria-label', '自動調整の最終レビュー');
  const result = run.result;
  const best = result?.best;
  const heading = doc.createElement('h3');
  const labels = { achieved: '条件達成', needs_review: '要確認', stopped: '停止', error: 'エラー' };
  heading.textContent = `最終レビュー：${labels[result?.status ?? 'error']}`;
  section.appendChild(heading);
  const paragraph = (text: string): void => {
    const p = doc.createElement('p');
    p.textContent = text;
    section.appendChild(p);
  };
  const subheading = (text: string): void => {
    const h = doc.createElement('h4');
    h.textContent = text;
    section.appendChild(h);
  };
  subheading('最終式');
  if (best) {
    const formula = doc.createElement('pre');
    formula.className = 'optimization__final-formula';
    formula.textContent = serializePubmedFormulaMd(best.formula);
    section.appendChild(formula);
  } else paragraph('実測済みの候補がありません。');
  const measured = best?.evaluation.finalQuery;
  const total = measured?.totalHits;
  paragraph(`最大件数 ${run.maxHits.toLocaleString()} 件に対して実測 ${total == null ? '未測定' : `${total.toLocaleString()} 件`}（${total == null ? '上限到達は未確認' : total <= run.maxHits ? '上限以下' : '上限超過'}）`);
  const seeds = best?.evaluation.seedPmids.length ?? run.seedCount;
  paragraph(measured?.capturedPmids && seeds !== null
    ? `既知シード ${measured.capturedPmids.length}/${seeds} 件捕捉`
    : `既知シード捕捉は未測定（対象 ${seeds ?? '不明'} 件）`);
  paragraph('既知シードの捕捉は、未知の適格研究の網羅性を保証するものではありません。');
  if (seeds === 0) paragraph('検証対象シードがないため、捕捉の確認はできていません。');

  subheading('変更一覧（初期式 → 最終式）');
  const initial = run.trials.find((trial) => trial.kind === 'initial')?.formula;
  if (!initial || !best) paragraph('比較できる初期式または最終式がありません。');
  else {
    const list = doc.createElement('ul');
    const ids = new Set([...initial.blocks, ...best.formula.blocks].map((block) => block.id));
    for (const id of ids) {
      const before = initial.blocks.find((block) => block.id === id)?.expression;
      const after = best.formula.blocks.find((block) => block.id === id)?.expression;
      if (before === after) continue;
      const item = doc.createElement('li');
      item.textContent = `#${id}: ${before ?? 'なし'} → ${after ?? 'なし'}`;
      list.appendChild(item);
    }
    if (initial.combinationExpression !== best.formula.combinationExpression) {
      const item = doc.createElement('li');
      item.textContent = `結合式: ${initial.combinationExpression ?? 'なし'} → ${best.formula.combinationExpression ?? 'なし'}`;
      list.appendChild(item);
    }
    if (!list.children.length) paragraph('初期式からの変更はありません。');
    else section.appendChild(list);
  }
  subheading('残った懸念');
  const reasons = result?.unmetReasons ?? (run.error ? [run.error] : []);
  if (!reasons.length) paragraph('記録された未達理由はありません。研究基準との整合性を最後に確認してください。');
  else {
    const list = doc.createElement('ul');
    for (const reason of reasons) {
      const item = doc.createElement('li');
      item.textContent = reason;
      list.appendChild(item);
    }
    section.appendChild(list);
  }
  const buttons = doc.createElement('div');
  buttons.className = 'optimization__review-actions';
  const adopt = doc.createElement('button');
  adopt.type = 'button';
  adopt.textContent = '採用して保存';
  adopt.disabled = !best || !actions.adopt || run.save?.status === 'saving' || run.save?.status === 'saved';
  adopt.addEventListener('click', () => {
    if (adopt.disabled) return;
    adopt.disabled = true;
    void actions.adopt?.();
  });
  const edit = doc.createElement('button');
  edit.type = 'button';
  edit.textContent = '編集して確認';
  edit.disabled = !best || !actions.edit || run.save?.status === 'saving';
  edit.addEventListener('click', () => actions.edit?.());
  buttons.append(adopt, edit);
  section.appendChild(buttons);
  const status = doc.createElement('p');
  status.className = 'optimization__save-status';
  status.setAttribute('aria-live', 'polite');
  status.textContent = run.save?.status === 'saving' ? '保存中…'
    : run.save?.status === 'saved' ? `保存しました（version_id: ${run.save.formulaVersionId}）` : '';
  const error = doc.createElement('p');
  error.className = 'optimization__save-error';
  error.setAttribute('aria-live', 'polite');
  error.textContent = run.save?.error ?? '';
  section.append(status, error);
  container.appendChild(section);
}
