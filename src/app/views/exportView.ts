import type { TargetDatabase } from '@/domain/conversion';
import type { ExportResult } from '@/app/services';
import { suggestFileName, toDownloadUrl } from '@/app/services';
import { expandFormula } from '@/features/validation';
import { buildPubmedSearchUrl } from '@/lib/ncbi';
import { parsePubmedFormulaMd } from '@/lib/search-formula-md';
import { ROUTE_LABELS } from '../router';
import { buildMethodsTexts, getExtensionVersion } from './methodsText';
import type { RenderView } from './types';

/**
 * エクスポート画面（#/export）。
 *
 * - 「変換して保存」ボタンで 4 DB 変換 + Conversions タブ追記を起動
 * - 各 DB の変換結果を `<details>` で開閉でき、ダウンロードリンクと
 *   PubMed 検索 URL を表示
 * - warnings は箇条書きで併記
 * - 論文 Methods 用の定型文（生成 AI 支援の開示。英/日）をコピーできる
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

    container.appendChild(buildMethodsSection(doc, ctx.state.currentFormulaModel));

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

/**
 * 論文 Methods 用の定型文セクション。
 * 「AI 支援で下書き → 著者がレビューして確定」の開示文を英/日で表示し、
 * ボタン 1 つでクリップボードへコピーできるようにする。
 */
function buildMethodsSection(doc: Document, model: string | null): HTMLElement {
  const texts = buildMethodsTexts({ model, version: getExtensionVersion() });
  const section = doc.createElement('section');
  section.className = 'export__methods';

  const heading = doc.createElement('h3');
  heading.textContent = '論文 Methods 用の文案';
  section.appendChild(heading);

  const note = doc.createElement('p');
  note.className = 'export__methods-note';
  note.textContent =
    model === null
      ? '検索式の下書きに生成 AI を使ったことを論文の方法（Methods）に記載するための定型文です。この検索式にはモデル情報が記録されていないため、{ } の部分は使用したモデル名に置き換えてください。'
      : '検索式の下書きに生成 AI を使ったことを論文の方法（Methods）に記載するための定型文です。必要に応じて調整して使ってください。';
  section.appendChild(note);

  const status = doc.createElement('p');
  status.className = 'export__methods-status';
  status.setAttribute('aria-live', 'polite');

  const variants: Array<{ lang: string; label: string; text: string }> = [
    { lang: 'en', label: '英語版', text: texts.en },
    { lang: 'ja', label: '日本語版', text: texts.ja },
  ];
  for (const variant of variants) {
    const item = doc.createElement('div');
    item.className = 'export__methods-item';

    const text = doc.createElement('p');
    text.className = 'export__methods-text';
    text.lang = variant.lang;
    text.textContent = variant.text;
    item.appendChild(text);

    const copyBtn = doc.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'export__methods-copy';
    copyBtn.textContent = `${variant.label}をコピー`;
    copyBtn.addEventListener('click', () => {
      copyToClipboard(variant.text).then(
        () => {
          status.textContent = `${variant.label}の文案をコピーしました。`;
        },
        () => {
          status.textContent =
            'コピーに失敗しました。テキストを選択して手動でコピーしてください。';
        }
      );
    });
    item.appendChild(copyBtn);

    section.appendChild(item);
  }

  section.appendChild(status);
  return section;
}

function copyToClipboard(text: string): Promise<void> {
  const clipboard = globalThis.navigator?.clipboard;
  if (!clipboard) {
    return Promise.reject(new Error('クリップボード API が利用できません'));
  }
  return clipboard.writeText(text);
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
