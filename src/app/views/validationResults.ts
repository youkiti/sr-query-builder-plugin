import type {
  AnalyzeMissedSeedsResult,
  ValidationProgress,
  ValidationSummary,
} from '@/app/services';
import type { AppState } from '../store';

/**
 * 検証結果の描画ユーティリティ。
 *
 * 旧 validateView の描画ロジックを切り出したもので、draft タブ（生成・検証の統合画面）が
 * 生成完了後に自動実行した検証結果（line_hits / final_query / mesh / 階層）を表示するのに使う。
 * 「AI で原因を分析する」だけは LLM コストがかかるため、ボタン押下の手動操作のまま残す。
 *
 * 結果は store（state.validationResult / state.missedAnalysis）に保持されるため、
 * 再描画（LLM コスト集計の setState 等）後も state から復元して表示する。
 */

export interface ValidationResultsCallbacks {
  /** 未捕捉 PMID の原因を AI に分析させる（requirements.md §4.6） */
  onAnalyzeMissed?: (missedPmids: string[]) => Promise<AnalyzeMissedSeedsResult>;
}

/** ValidationProgress を表示用ラベルへ変換する（draftView.formatDraftProgress と同型） */
export function formatValidationProgress(progress: ValidationProgress): string {
  const label = {
    line_hits: '行ごとのヒット数を集計中',
    final_query: 'シード捕捉率を確認中',
    mesh: 'Seed の MeSH を抽出中',
    mesh_hierarchy: 'MeSH 階層を取得中',
    logging: '結果を記録中',
    done: '完了',
  }[progress.step];
  if (progress.step === 'line_hits' && progress.blockCount !== undefined) {
    return `${label}（ブロック ${progress.blockIndex ?? 0}/${progress.blockCount}）`;
  }
  return label;
}

/** state.validationResult が現在の formula バージョンの結果なら返す（stale は null） */
export function readStoredSummary(state: AppState): ValidationSummary | null {
  if (
    state.validationResult === null ||
    state.currentFormulaVersionId === null ||
    state.validationResult.formulaVersionId !== state.currentFormulaVersionId
  ) {
    return null;
  }
  return state.validationResult.summary;
}

/** state.missedAnalysis が現在の formula バージョンの結果なら返す（stale は null） */
export function readStoredAnalysis(state: AppState): AnalyzeMissedSeedsResult | null {
  if (
    state.missedAnalysis === null ||
    state.currentFormulaVersionId === null ||
    state.missedAnalysis.formulaVersionId !== state.currentFormulaVersionId
  ) {
    return null;
  }
  return state.missedAnalysis.result;
}

export function summaryStatusText(summary: ValidationSummary): string {
  return `検証完了（有効 seed ${summary.eligibleSeedCount}/${summary.totalSeedCount} 件）`;
}

export function renderValidationResults(
  doc: Document,
  container: HTMLElement,
  summary: ValidationSummary,
  callbacks: ValidationResultsCallbacks,
  initialAnalysis: AnalyzeMissedSeedsResult | null
): void {
  container.appendChild(renderLineHits(doc, summary));
  container.appendChild(renderFinalQuery(doc, summary, callbacks, initialAnalysis));
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

function renderFinalQuery(
  doc: Document,
  summary: ValidationSummary,
  callbacks: ValidationResultsCallbacks,
  initialAnalysis: AnalyzeMissedSeedsResult | null
): HTMLElement {
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
    section.appendChild(
      renderMissedAnalysis(doc, summary.finalQuery.missedPmids, callbacks, initialAnalysis)
    );
  }
  return section;
}

/**
 * 未捕捉 PMID の原因分析セクション（requirements.md §4.6）。
 * 「AI で原因を分析する」ボタンを出し、押下で onAnalyzeMissed を呼んで
 * PMID ごとの原因・改善候補語・関連ブロックを列挙する。自動実行はしない。
 */
function renderMissedAnalysis(
  doc: Document,
  missedPmids: string[],
  callbacks: ValidationResultsCallbacks,
  initialAnalysis: AnalyzeMissedSeedsResult | null
): HTMLElement {
  const wrap = doc.createElement('div');
  wrap.className = 'validate__missed-analysis';

  const btn = doc.createElement('button');
  btn.type = 'button';
  btn.className = 'validate__analyze-missed';
  btn.textContent = 'AI で原因を分析する';
  wrap.appendChild(btn);

  const status = doc.createElement('p');
  status.className = 'validate__analyze-status';
  status.setAttribute('aria-live', 'polite');
  wrap.appendChild(status);

  const errorBox = doc.createElement('p');
  errorBox.className = 'validate__analyze-error';
  errorBox.setAttribute('aria-live', 'polite');
  wrap.appendChild(errorBox);

  const list = doc.createElement('ul');
  list.className = 'validate__analysis-results';
  wrap.appendChild(list);

  const showResult = (result: AnalyzeMissedSeedsResult): void => {
    if (result.analyses.length === 0) {
      status.textContent = '分析結果が得られませんでした。';
      return;
    }
    status.textContent = `${result.analyses.length} 件の原因を分析しました。`;
    for (const analysis of result.analyses) {
      list.appendChild(renderAnalysisItem(doc, analysis));
    }
  };

  // store に保存済みの分析結果があれば復元する
  if (initialAnalysis) {
    showResult(initialAnalysis);
  }

  btn.addEventListener('click', () => {
    if (!callbacks.onAnalyzeMissed) {
      return;
    }
    btn.disabled = true;
    status.textContent = '原因を分析中…';
    errorBox.textContent = '';
    list.innerHTML = '';
    callbacks
      .onAnalyzeMissed(missedPmids)
      .then(showResult)
      .catch((err: unknown) => {
        status.textContent = '';
        errorBox.textContent = formatError(err);
      })
      .finally(() => {
        btn.disabled = false;
      });
  });

  return wrap;
}

function renderAnalysisItem(
  doc: Document,
  analysis: { pmid: string; cause: string; suggestedTerms: string[]; relatedBlock: string | null }
): HTMLElement {
  const li = doc.createElement('li');
  li.className = 'validate__analysis-item';

  const head = doc.createElement('p');
  head.className = 'validate__analysis-pmid';
  const block = analysis.relatedBlock === null ? '不明' : `#${analysis.relatedBlock}`;
  head.textContent = `PMID ${analysis.pmid}（推定ブロック: ${block}）`;
  li.appendChild(head);

  const cause = doc.createElement('p');
  cause.className = 'validate__analysis-cause';
  cause.textContent = analysis.cause;
  li.appendChild(cause);

  if (analysis.suggestedTerms.length > 0) {
    const termsLabel = doc.createElement('p');
    termsLabel.className = 'validate__analysis-terms-label';
    termsLabel.textContent = '改善候補語:';
    li.appendChild(termsLabel);

    const termsList = doc.createElement('ul');
    termsList.className = 'validate__analysis-terms';
    for (const term of analysis.suggestedTerms) {
      const termLi = doc.createElement('li');
      termLi.textContent = term;
      termsList.appendChild(termLi);
    }
    li.appendChild(termsList);
  }

  return li;
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
