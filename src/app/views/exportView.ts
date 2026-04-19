import type { TargetDatabase } from '@/domain/conversion';
import type { ExportResult } from '@/app/services';
import { suggestFileName, toDownloadUrl } from '@/app/services';
import { buildPubmedSearchUrl } from '@/lib/ncbi';
import { ROUTE_LABELS } from '../router';
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
  // PubMed セクションの combination 式（最終行）を抜き出してリンクにする
  const combinationLine = extractCombinationExpression(markdown);
  if (!combinationLine) {
    return null;
  }
  const wrap = doc.createElement('p');
  wrap.className = 'export__pubmed-link';
  const label = doc.createElement('span');
  label.textContent = 'PubMed で直接開く: ';
  const a = doc.createElement('a');
  a.href = buildPubmedSearchUrl(combinationLine);
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = combinationLine;
  wrap.appendChild(label);
  wrap.appendChild(a);
  return wrap;
}

function extractCombinationExpression(markdown: string): string | null {
  // PubMed セクションの最後の #N 行を取り出す簡易実装
  const match = markdown.match(/```[^\n]*\n([\s\S]*?)\n```/);
  if (!match || match[1] === undefined) {
    return null;
  }
  const lines = match[1].split('\n').filter((l) => l.trim().startsWith('#'));
  const last = lines[lines.length - 1] ?? '';
  const parsed = last.match(/^#\S+\s+(.+)$/);
  return parsed?.[1]?.trim() ?? null;
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
