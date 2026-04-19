import type { IngestInput, IngestSummary } from '@/app/services';
import { ROUTE_LABELS } from '../router';
import type { RenderView } from './types';

/**
 * シード論文入力画面（#/seeds）。
 *
 * - PMID 直接入力（改行・カンマ区切り）
 * - NBIB ファイルアップロード
 * - RIS ファイルアップロード
 *
 * 送信後は ingest サマリ（登録 N 件 / 有効 K 件 / 無効 M 件 + 理由別内訳）を表示する。
 * 実ロジック（onIngest）は bootstrap 側で seedService に繋ぐ。
 */

export interface SeedsViewCallbacks {
  onIngest?: (input: IngestInput) => Promise<IngestSummary>;
}

export function createSeedsView(callbacks: SeedsViewCallbacks = {}): RenderView {
  return (container, ctx) => {
    container.innerHTML = '';
    const doc = container.ownerDocument;
    const heading = doc.createElement('h2');
    heading.textContent = ROUTE_LABELS.seeds;
    container.appendChild(heading);

    if (!ctx.state.project) {
      const warn = doc.createElement('p');
      warn.className = 'view__placeholder';
      warn.textContent = '先にプロジェクトを選択してください。';
      container.appendChild(warn);
      return;
    }

    const status = doc.createElement('p');
    status.className = 'seeds__status';
    status.setAttribute('aria-live', 'polite');
    container.appendChild(status);

    const errorBox = doc.createElement('p');
    errorBox.className = 'seeds__error';
    errorBox.setAttribute('aria-live', 'polite');
    container.appendChild(errorBox);

    const summaryBox = doc.createElement('div');
    summaryBox.className = 'seeds__summary';
    container.appendChild(summaryBox);

    container.appendChild(
      buildPmidForm(doc, async (pmids) => run({ mode: 'pmid_direct', pmids }))
    );
    container.appendChild(
      buildFileForm(doc, 'NBIB アップロード', '.nbib,.txt', async (text) =>
        run({ mode: 'nbib', text })
      )
    );
    container.appendChild(
      buildFileForm(doc, 'RIS アップロード', '.ris,.txt', async (text) =>
        run({ mode: 'ris', text })
      )
    );

    async function run(input: IngestInput): Promise<void> {
      if (!callbacks.onIngest) {
        return;
      }
      status.textContent = 'ingest 中…';
      errorBox.textContent = '';
      try {
        const result = await callbacks.onIngest(input);
        status.textContent = `${result.registered} 件登録（有効 ${result.valid} / 無効 ${result.invalid}）`;
        renderSummary(doc, summaryBox, result);
      } catch (err) {
        errorBox.textContent = formatError(err);
        status.textContent = '';
      }
    }
  };
}

function renderSummary(doc: Document, container: HTMLElement, summary: IngestSummary): void {
  container.innerHTML = '';
  if (summary.registered === 0) {
    return;
  }
  const reasons = summary.reasons;
  const parts: string[] = [];
  if (reasons.pmid_not_found > 0) parts.push(`PMID 不在: ${reasons.pmid_not_found}`);
  if (reasons.duplicate_pmid > 0) parts.push(`重複: ${reasons.duplicate_pmid}`);
  if (reasons.no_pmid_resolved > 0) parts.push(`PMID 解決不能: ${reasons.no_pmid_resolved}`);
  if (reasons.other > 0) parts.push(`その他: ${reasons.other}`);
  if (parts.length > 0) {
    const detail = doc.createElement('p');
    detail.className = 'seeds__reasons';
    detail.textContent = `内訳: ${parts.join(' / ')}`;
    container.appendChild(detail);
  }

  if (summary.added.length > 0) {
    const ul = doc.createElement('ul');
    ul.className = 'seeds__added';
    for (const seed of summary.added) {
      const li = doc.createElement('li');
      const label = seed.pmid ? `PMID ${seed.pmid}` : `(PMID 無し) ${seed.title ?? ''}`;
      const status = seed.isValid ? '✅ 有効' : `⚠️ ${seed.exclusionReason ?? '無効'}`;
      li.textContent = `${label} — ${status}`;
      ul.appendChild(li);
    }
    container.appendChild(ul);
  }
}

function buildPmidForm(
  doc: Document,
  onSubmit: (pmids: string[]) => Promise<void>
): HTMLElement {
  const fieldset = doc.createElement('fieldset');
  fieldset.className = 'seeds__section';
  const legend = doc.createElement('legend');
  legend.textContent = 'PMID を直接入力';
  fieldset.appendChild(legend);

  const textarea = doc.createElement('textarea');
  textarea.placeholder = 'PMID を改行またはカンマ区切りで貼り付け';
  textarea.className = 'seeds__pmid-input';
  fieldset.appendChild(textarea);

  const btn = doc.createElement('button');
  btn.type = 'button';
  btn.textContent = '登録';
  fieldset.appendChild(btn);

  btn.addEventListener('click', () => {
    const raw = textarea.value;
    const pmids = raw
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter((s) => s !== '');
    btn.disabled = true;
    void onSubmit(pmids).finally(() => {
      btn.disabled = false;
    });
  });

  return fieldset;
}

function buildFileForm(
  doc: Document,
  legendText: string,
  accept: string,
  onSubmit: (text: string) => Promise<void>
): HTMLElement {
  const fieldset = doc.createElement('fieldset');
  fieldset.className = 'seeds__section';
  const legend = doc.createElement('legend');
  legend.textContent = legendText;
  fieldset.appendChild(legend);

  const fileInput = doc.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = accept;
  fieldset.appendChild(fileInput);

  const btn = doc.createElement('button');
  btn.type = 'button';
  btn.textContent = 'アップロードして登録';
  fieldset.appendChild(btn);

  btn.addEventListener('click', () => {
    const file = fileInput.files?.[0];
    if (!file) {
      return;
    }
    btn.disabled = true;
    void file
      .text()
      .then((text) => onSubmit(text))
      .finally(() => {
        btn.disabled = false;
      });
  });
  return fieldset;
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
