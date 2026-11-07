import { t } from '@/lib/i18n';
import type { TargetDatabase } from '@/domain/conversion';
import type { ExportResult } from '@/app/services';
import { suggestFileName, toDownloadUrl } from '@/app/services';
import { expandFormula } from '@/features/validation';
import { buildPubmedSearchUrl } from '@/lib/ncbi';
import { parsePubmedFormulaMd } from '@/lib/search-formula-md';
import { ROUTE_LABELS } from '../router';
import type { AppState } from '../store';
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
  let exportState: {
    key: string;
    result: ExportResult | null;
    pending: boolean;
    error: string;
    openDetails: Map<string, boolean>;
  } | null = null;
  let updateResults = (): void => {};
  return (container, ctx) => {
    const key = JSON.stringify([ctx.state.project?.projectId, ctx.state.currentFormulaVersionId, ctx.state.currentFormulaMarkdown]);
    if (exportState?.key !== key) {
      exportState = { key, result: null, pending: false, error: '', openDetails: new Map() };
    } else {
      for (const details of Array.from(container.querySelectorAll<HTMLDetailsElement>('.export__result'))) {
        exportState.openDetails.set(details.dataset['db']!, details.open);
      }
    }
    const saved = exportState;
    updateResults = (): void => {};
    container.innerHTML = '';
    const doc = container.ownerDocument;
    const heading = doc.createElement('h2');
    heading.textContent = ROUTE_LABELS.export;
    container.appendChild(heading);

    if (!ctx.state.project) {
      const warn = doc.createElement('p');
      warn.className = 'view__placeholder';
      warn.textContent = t('export.noProject');
      container.appendChild(warn);
      return;
    }
    if (!ctx.state.currentFormulaVersionId || !ctx.state.currentFormulaMarkdown) {
      const warn = doc.createElement('p');
      warn.className = 'view__placeholder';
      warn.textContent = t('export.noFormula');
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

    if (ctx.state.currentFormulaCreatedBy === 'ai_draft' || ctx.state.currentFormulaCreatedBy === 'auto_optimize') {
      const notice = doc.createElement('p');
      notice.className = 'export__validation-warning';
      notice.setAttribute('role', 'note');
      notice.append(t('export.unreviewed'));
      const edit = doc.createElement('a');
      edit.href = '#/edit';
      edit.textContent = t('export.editLink');
      notice.append(edit, t('export.reviewPrompt'));
      container.appendChild(notice);
    }

    const actions = doc.createElement('div');
    actions.className = 'export__actions';
    const exportBtn = doc.createElement('button');
    exportBtn.type = 'button';
    exportBtn.textContent = t('export.convert');
    exportBtn.dataset.tour = 'export-run';
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

    container.appendChild(buildMethodsSection(doc, ctx.state.currentFormulaModel, ctx.state.currentFormulaModelsUsed, ctx.state.currentFormulaAppVersion));

    updateResults = () => {
      exportBtn.disabled = saved.pending;
      status.textContent = saved.pending ? t('export.converting') : saved.result ? t('export.converted') : '';
      errorBox.textContent = saved.error;
      results.innerHTML = '';
      delete results.dataset['tour'];
      if (saved.result) {
        renderResults(doc, results, saved.result);
        for (const details of Array.from(results.querySelectorAll<HTMLDetailsElement>('.export__result'))) {
          const open = saved.openDetails.get(details.dataset['db']!);
          if (open !== undefined) {
            details.open = open;
          }
        }
        // ツアーが枠を付ける対象。変換結果があるときだけ付け、空の領域には付けない。
        results.dataset.tour = 'export-results';
      }
    };
    updateResults();

    exportBtn.addEventListener('click', () => {
      if (!callbacks.onExport || saved.pending) {
        return;
      }
      saved.pending = true;
      saved.result = null;
      saved.error = '';
      saved.openDetails.clear();
      updateResults();
      callbacks
        .onExport()
        .then((result) => {
          saved.result = result;
        })
        .catch((err: unknown) => {
          saved.error = formatError(err);
        })
        .finally(() => {
          saved.pending = false;
          if (exportState === saved) {
            updateResults();
          }
        });
    });
  };
}

/**
 * 未検証 / 捕捉率不足の警告文を組み立てる（fix-plan 2-3）。警告不要なら null。
 *
 * - validationResult が無い、または現在のバージョンと不一致（stale） → 「未検証」警告
 * - 検証済みでも final_query が失敗している → 捕捉率未確認の警告
 * - 検証済みで有効 seed があり捕捉率 < 100% → 捕捉率 N% の警告
 * - 検証済みで seed 0 件 → 既知文献で未検証の警告
 * - 検証済みで問題なし（100%） → null（バナー非表示）
 *
 * テストから直接検証できるよう純関数として export する。
 */
export function buildValidationWarning(state: AppState): string | null {
  const entry = state.validationResult;
  if (entry === null || entry.formulaVersionId !== state.currentFormulaVersionId) {
    return t('export.unvalidated');
  }
  const summary = entry.summary;
  if (summary.finalQueryError !== null) {
    return t('export.validationFailed');
  }
  const captured = summary.finalQuery.capturedPmids.length;
  const seedTotal = captured + summary.finalQuery.missedPmids.length;
  if (seedTotal === 0) {
    return t('export.noSeeds');
  }
  if (seedTotal > 0 && summary.finalQuery.captureRate !== null && summary.finalQuery.captureRate < 1) {
    const percent = (summary.finalQuery.captureRate * 100).toFixed(1);
    return t('export.lowCapture', { percent, captured, seedTotal });
  }
  return null;
}

function renderResults(doc: Document, container: HTMLElement, result: ExportResult): void {
  const note = doc.createElement('p');
  note.textContent = t('export.conversionNote');
  container.appendChild(note);
  for (const conversion of result.conversions) {
    const details = doc.createElement('details');
    details.className = 'export__result';
    details.open = conversion.warnings.length > 0;
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
    downloadLink.textContent = t('export.download', { filename: suggestFileName(conversion.targetDb) });
    downloadLink.className = 'export__download';
    details.appendChild(downloadLink);

    container.appendChild(details);
  }
}

/**
 * 論文 Methods 用の定型文セクション。
 * AI 支援の開示文と人による確認方法の記入欄を英/日で表示し、
 * ボタン 1 つでクリップボードへコピーできるようにする。
 */
function buildMethodsSection(doc: Document, model: string | null, modelsUsed?: string | null, appVersion?: string | null): HTMLElement {
  const texts = buildMethodsTexts({ model, modelsUsed, appVersion, version: getExtensionVersion() });
  const section = doc.createElement('section');
  section.className = 'export__methods';

  const heading = doc.createElement('h3');
  heading.textContent = t('export.methodsTitle');
  section.appendChild(heading);

  const note = doc.createElement('p');
  note.className = 'export__methods-note';
  note.textContent =
    model === null
      ? t('export.methodsNoModel')
      : t('export.methodsNote');
  section.appendChild(note);
  const fillIn = doc.createElement('strong');
  fillIn.textContent = t('export.methodsFillIn');
  section.appendChild(fillIn);

  const status = doc.createElement('p');
  status.className = 'export__methods-status';
  status.setAttribute('aria-live', 'polite');

  const variants: Array<{ lang: string; label: string; text: string }> = [
    { lang: 'en', label: t('export.englishVersion'), text: texts.en },
    { lang: 'ja', label: t('export.japaneseVersion'), text: texts.ja },
  ];
  for (const variant of variants) {
    const item = doc.createElement('div');
    item.className = 'export__methods-item';

    const text = doc.createElement('p');
    text.className = 'export__methods-text';
    text.lang = variant.lang;
    const placeholder = variant.lang === 'en'
      ? '[Describe how the authors checked and revised the AI-generated drafts.]'
      : '［著者が AI の下書きをどう確かめ、直したかを記入］';
    const [before, after] = variant.text.split(placeholder);
    const emphasis = doc.createElement('strong');
    emphasis.textContent = placeholder;
    text.append(before ?? '', emphasis, after ?? '');
    item.appendChild(text);

    const copyBtn = doc.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'export__methods-copy';
    copyBtn.textContent = t('export.copyVersion', { label: variant.label });
    copyBtn.addEventListener('click', () => {
      copyToClipboard(variant.text).then(
        () => {
          status.textContent = t('export.copiedVersion', { label: variant.label });
        },
        () => {
          status.textContent =
            t('export.copyFailed');
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
    return Promise.reject(new Error(t('export.clipboardUnavailable')));
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
  label.textContent = t('export.pubmedLink');
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
