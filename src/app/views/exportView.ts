import type { TargetDatabase } from '@/domain/conversion';
import type { ExportResult } from '@/app/services';
import { suggestFileName, toDownloadUrl } from '@/app/services';
import { expandFormula } from '@/features/validation';
import { buildPubmedSearchUrl } from '@/lib/ncbi';
import { parsePubmedFormulaMd } from '@/lib/search-formula-md';
import { ROUTE_LABELS } from '../router';
import type { AppState } from '../store';
import type { RenderView } from './types';

/**
 * エクスポート画面（#/export）。
 *
 * - 「変換して保存」ボタンで 4 DB 変換 + Conversions タブ追記を起動
 * - 各 DB の変換結果を `<details>` で開閉でき、ダウンロードリンクと
 *   PubMed 検索 URL を表示
 * - warnings は箇条書きで併記
 *
 * 実ロジック（onExport）は bootstrap で exportService をラップして渡す。
 */

export interface ExportViewCallbacks {
  onExport?: () => Promise<ExportResult>;
}

export function createExportView(callbacks: ExportViewCallbacks = {}): RenderView {
  return (container, ctx) => {
    container.innerHTML = '';
    const doc = container.ownerDocument;
    const heading = doc.createElement('h2');
    heading.textContent = ROUTE_LABELS.export;
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

    // 未検証 / 捕捉率不足の警告（fix-plan 2-3）。guards.ts の近似方針どおりハードブロックは
    // せず、エクスポート自体は許可したまま注意だけ促す。
    const warning = buildValidationWarning(ctx.state);
    if (warning !== null) {
      const banner = doc.createElement('p');
      banner.className = 'export__validation-warning';
      banner.setAttribute('role', 'note');
      banner.textContent = warning;
      container.appendChild(banner);
    }

    const actions = doc.createElement('div');
    actions.className = 'export__actions';
    const exportBtn = doc.createElement('button');
    exportBtn.type = 'button';
    exportBtn.textContent = '4 DB へ変換して保存';
    actions.appendChild(exportBtn);
    container.appendChild(actions);

    const pubmedLink = buildPubmedLink(doc, ctx.state.currentFormulaMarkdown);
    if (pubmedLink) {
      container.appendChild(pubmedLink);
    }

    const status = doc.createElement('p');
    status.className = 'export__status';
    status.setAttribute('aria-live', 'polite');
    container.appendChild(status);

    const errorBox = doc.createElement('p');
    errorBox.className = 'export__error';
    errorBox.setAttribute('aria-live', 'polite');
    container.appendChild(errorBox);

    const results = doc.createElement('div');
    results.className = 'export__results';
    container.appendChild(results);

    exportBtn.addEventListener('click', () => {
      if (!callbacks.onExport) {
        return;
      }
      exportBtn.disabled = true;
      status.textContent = '変換中…';
      errorBox.textContent = '';
      results.innerHTML = '';
      callbacks
        .onExport()
        .then((result) => {
          status.textContent = '変換が完了しました。';
          renderResults(doc, results, result);
        })
        .catch((err: unknown) => {
          errorBox.textContent = formatError(err);
          status.textContent = '';
        })
        .finally(() => {
          exportBtn.disabled = false;
        });
    });
  };
}

/**
 * 未検証 / 捕捉率不足の警告文を組み立てる（fix-plan 2-3）。警告不要なら null。
 *
 * - validationResult が無い、または現在のバージョンと不一致 → 「未検証」警告
 * - 検証済みでも final_query が失敗している → 捕捉率未確認の警告
 * - 検証済みで有効 seed があり捕捉率 < 100% → 捕捉率 N% の警告
 * - 検証済みで問題なし → null（バナー非表示）
 *
 * テストから直接検証できるよう純関数として export する。
 */
export function buildValidationWarning(state: AppState): string | null {
  const entry = state.validationResult;
  if (entry === null || entry.formulaVersionId !== state.currentFormulaVersionId) {
    return '⚠ この検索式はまだ検証されていません。#/draft の「生成して検証する」でシード捕捉率を確認してからのエクスポートを推奨します。';
  }
  const summary = entry.summary;
  if (summary.finalQueryError !== null) {
    return '⚠ 検証でシード捕捉率を確認できていません（final_query の実行に失敗）。#/draft で再検証してからのエクスポートを推奨します。';
  }
  const captured = summary.finalQuery.capturedPmids.length;
  const seedTotal = captured + summary.finalQuery.missedPmids.length;
  if (seedTotal > 0 && summary.finalQuery.captureRate < 1) {
    const percent = (summary.finalQuery.captureRate * 100).toFixed(1);
    return `⚠ シード捕捉率が ${percent}%（${captured}/${seedTotal} 件）です。未捕捉シードの原因を #/draft で確認してからのエクスポートを推奨します。`;
  }
  return null;
}

function renderResults(doc: Document, container: HTMLElement, result: ExportResult): void {
  for (const conversion of result.conversions) {
    const details = doc.createElement('details');
    details.className = 'export__result';
    details.dataset['db'] = conversion.targetDb;
    const summary = doc.createElement('summary');
    summary.textContent = dbLabel(conversion.targetDb);
    details.appendChild(summary);

    if (conversion.warnings.length > 0) {
      const ul = doc.createElement('ul');
      ul.className = 'export__warnings';
      for (const w of conversion.warnings) {
        const li = doc.createElement('li');
        li.textContent = w;
        ul.appendChild(li);
      }
      details.appendChild(ul);
    }

    const pre = doc.createElement('pre');
    pre.className = 'export__formula';
    pre.textContent = conversion.convertedFormula;
    details.appendChild(pre);

    const downloadLink = doc.createElement('a');
    downloadLink.href = toDownloadUrl(conversion);
    downloadLink.download = suggestFileName(conversion.targetDb);
    downloadLink.textContent = `${suggestFileName(conversion.targetDb)} をダウンロード`;
    downloadLink.className = 'export__download';
    details.appendChild(downloadLink);

    container.appendChild(details);
  }
}

function buildPubmedLink(doc: Document, markdown: string): HTMLElement | null {
  let expandedQuery = '';
  try {
    expandedQuery = expandFormula(parsePubmedFormulaMd(markdown)).trim();
  } catch {
    return null;
  }
  if (expandedQuery === '') {
    return null;
  }
  const wrap = doc.createElement('p');
  wrap.className = 'export__pubmed-link';
  const label = doc.createElement('span');
  label.textContent = 'PubMed で直接開く: ';
  const a = doc.createElement('a');
  a.href = buildPubmedSearchUrl(expandedQuery);
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = expandedQuery;
  wrap.appendChild(label);
  wrap.appendChild(a);
  return wrap;
}

function dbLabel(db: TargetDatabase): string {
  return {
    central: 'Cochrane CENTRAL',
    dialog: 'Embase (Dialog)',
    clinicaltrials: 'ClinicalTrials.gov',
    ictrp: 'ICTRP',
  }[db];
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
