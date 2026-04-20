import type { ValidationSummary } from '@/app/services';
import { ROUTE_LABELS } from '../router';
import type { RenderView } from './types';

/**
 * 検証画面（#/validate）。
 *
 * - 「検証を実行する」ボタンで 3 検証（line_hits / final_query / mesh）を順に実行
 * - 行ごとのヒット数 / 捕捉率 / MeSH 出現頻度をそれぞれセクションで表示
 * - ValidationLog への追記は service 側が担当
 */

export interface ValidateViewCallbacks {
  onRun?: () => Promise<ValidationSummary>;
}

export function createValidateView(callbacks: ValidateViewCallbacks = {}): RenderView {
  return (container, ctx) => {
    container.innerHTML = '';
    const doc = container.ownerDocument;
    const heading = doc.createElement('h2');
    heading.textContent = ROUTE_LABELS.validate;
    container.appendChild(heading);

    if (!ctx.state.project) {
      const warn = doc.createElement('p');
      warn.className = 'view__placeholder';
      warn.textContent = '先にプロジェクトを選択してください。';
      container.appendChild(warn);
      return;
    }
    if (!ctx.state.currentFormulaVersionId || !ctx.state.currentFormulaMarkdown) {
      const warn = doc.createElement('p');
      warn.className = 'view__placeholder';
      warn.textContent = '先に /draft で検索式を生成してください。';
      container.appendChild(warn);
      return;
    }

    const actions = doc.createElement('div');
    actions.className = 'validate__actions';
    const runBtn = doc.createElement('button');
    runBtn.type = 'button';
    runBtn.textContent = '検証を実行する';
    actions.appendChild(runBtn);
    container.appendChild(actions);

    const status = doc.createElement('p');
    status.className = 'validate__status';
    status.setAttribute('aria-live', 'polite');
    container.appendChild(status);

    const errorBox = doc.createElement('p');
    errorBox.className = 'validate__error';
    errorBox.setAttribute('aria-live', 'polite');
    container.appendChild(errorBox);

    const results = doc.createElement('div');
    results.className = 'validate__results';
    container.appendChild(results);

    runBtn.addEventListener('click', () => {
      if (!callbacks.onRun) {
        return;
      }
      runBtn.disabled = true;
      status.textContent = '検証中…';
      errorBox.textContent = '';
      results.innerHTML = '';
      callbacks
        .onRun()
        .then((summary) => {
          status.textContent = `検証完了（有効 seed ${summary.eligibleSeedCount}/${summary.totalSeedCount} 件）`;
          renderResults(doc, results, summary);
        })
        .catch((err: unknown) => {
          errorBox.textContent = formatError(err);
          status.textContent = '';
        })
        .finally(() => {
          runBtn.disabled = false;
        });
    });
  };
}

function renderResults(doc: Document, container: HTMLElement, summary: ValidationSummary): void {
  container.appendChild(renderLineHits(doc, summary));
  container.appendChild(renderFinalQuery(doc, summary));
  container.appendChild(renderMesh(doc, summary));
}

function renderLineHits(doc: Document, summary: ValidationSummary): HTMLElement {
  const section = doc.createElement('section');
  section.className = 'validate__line-hits';
  const h3 = doc.createElement('h3');
  h3.textContent = '行ごとのヒット数';
  section.appendChild(h3);

  const ul = doc.createElement('ul');
  for (const line of summary.lineHits) {
    const li = doc.createElement('li');
    if (line.error !== null) {
      li.textContent = `#${line.blockId}: エラー — ${line.error}`;
      li.className = 'validate__line-error';
    } else {
      li.textContent = `#${line.blockId}: ${line.hitCount} 件`;
    }
    ul.appendChild(li);
  }
  section.appendChild(ul);
  return section;
}

function renderFinalQuery(doc: Document, summary: ValidationSummary): HTMLElement {
  const section = doc.createElement('section');
  section.className = 'validate__final';
  const h3 = doc.createElement('h3');
  h3.textContent = '最終検索式とシード捕捉率';
  section.appendChild(h3);

  if (summary.finalQueryError !== null) {
    const error = doc.createElement('p');
    error.className = 'validate__final-error';
    error.textContent = `final_query の取得に失敗しました: ${summary.finalQueryError}`;
    section.appendChild(error);
    return section;
  }

  const total = doc.createElement('p');
  total.textContent = `全体ヒット数: ${summary.finalQuery.totalHits}`;
  section.appendChild(total);

  const rate = doc.createElement('p');
  const captured = summary.finalQuery.capturedPmids.length;
  const seedTotal = captured + summary.finalQuery.missedPmids.length;
  const ratePercent = (summary.finalQuery.captureRate * 100).toFixed(1);
  rate.textContent =
    seedTotal === 0
      ? '捕捉率: （有効 seed 0 件のため計算不能）'
      : `捕捉率: ${ratePercent}% (${captured}/${seedTotal})`;
  section.appendChild(rate);

  if (summary.finalQuery.missedPmids.length > 0) {
    const missedList = doc.createElement('ul');
    missedList.className = 'validate__missed';
    const lead = doc.createElement('li');
    lead.textContent = '未捕捉 PMID:';
    missedList.appendChild(lead);
    for (const pmid of summary.finalQuery.missedPmids) {
      const li = doc.createElement('li');
      li.textContent = pmid;
      missedList.appendChild(li);
    }
    section.appendChild(missedList);
  }
  return section;
}

function renderMesh(doc: Document, summary: ValidationSummary): HTMLElement {
  const section = doc.createElement('section');
  section.className = 'validate__mesh';
  const h3 = doc.createElement('h3');
  h3.textContent = 'Seed の MeSH（頻度順）';
  section.appendChild(h3);
  if (summary.meshError !== null) {
    const error = doc.createElement('p');
    error.className = 'validate__mesh-error';
    error.textContent = `MeSH の取得に失敗しました: ${summary.meshError}`;
    section.appendChild(error);
    return section;
  }
  if (summary.meshFrequency.length === 0) {
    const empty = doc.createElement('p');
    empty.textContent = 'Seed が無いため MeSH 頻度を集計できません。';
    section.appendChild(empty);
    return section;
  }
  const ul = doc.createElement('ul');
  for (const entry of summary.meshFrequency) {
    const li = doc.createElement('li');
    li.textContent = `${entry.descriptor} (×${entry.count})`;
    ul.appendChild(li);
  }
  section.appendChild(ul);

  section.appendChild(renderMeshHierarchy(doc, summary));
  return section;
}

/**
 * MeSH tree number 由来の階層を Mermaid flowchart として表示するサブセクション。
 * 階層取得に失敗した場合はエラー文を出し、frequency セクションは活かしたままにする。
 */
function renderMeshHierarchy(doc: Document, summary: ValidationSummary): HTMLElement {
  const wrap = doc.createElement('div');
  wrap.className = 'validate__mesh-hierarchy';
  const h4 = doc.createElement('h4');
  h4.textContent = 'MeSH 階層（Mermaid）';
  wrap.appendChild(h4);

  if (summary.meshHierarchyError !== null) {
    const err = doc.createElement('p');
    err.className = 'validate__mesh-hierarchy-error';
    err.textContent = `MeSH 階層の取得に失敗しました: ${summary.meshHierarchyError}`;
    wrap.appendChild(err);
    return wrap;
  }

  if (summary.meshHierarchy.length === 0) {
    const empty = doc.createElement('p');
    empty.textContent = '階層情報が取得できませんでした（該当する tree number 無し）。';
    wrap.appendChild(empty);
    return wrap;
  }

  const note = doc.createElement('p');
  note.className = 'validate__mesh-hierarchy-note';
  note.textContent =
    '下の Mermaid ソースを https://mermaid.live に貼ると SVG として描画できます。';
  wrap.appendChild(note);

  const pre = doc.createElement('pre');
  pre.className = 'validate__mesh-mermaid mermaid';
  pre.textContent = summary.meshMermaid;
  wrap.appendChild(pre);
  return wrap;
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
