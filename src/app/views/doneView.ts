import { t, type MessageKey } from '@/lib/i18n';
import { expandFormula } from '@/features/validation';
import { buildPubmedSearchUrl } from '@/lib/ncbi';
import { parsePubmedFormulaMd } from '@/lib/search-formula-md';
import { ROUTE_LABELS } from '../router';
import type { RenderView } from './types';

/**
 * 完了画面（#/done）。
 *
 * - PubMed で検索式を直接開くリンク
 * - CENTRAL / Embase (Dialog) / ClinicalTrials.gov / ICTRP の検索ページへの誘導（実 DL はユーザー操作）
 * - 「検索 → nbib ダウンロード」の手順を簡単に案内
 *
 * Embase (Dialog) は契約制でディープリンクできないため、トップページへ誘導し
 * Advanced Search への手入力手順を案内する。
 */

const EXTERNAL_LINKS: Array<{ label: MessageKey; url: string; note: MessageKey }> = [
  {
    label: 'done.centralLink',
    url: 'https://www.cochranelibrary.com/central/',
    note: 'done.centralNote',
  },
  {
    label: 'done.dialogLink',
    url: 'https://dialog.proquest.com/',
    note: 'done.dialogNote',
  },
  {
    label: 'done.clinicaltrialsLink',
    url: 'https://clinicaltrials.gov/search',
    note: 'done.clinicaltrialsNote',
  },
  {
    label: 'done.ictrpLink',
    url: 'https://trialsearch.who.int/',
    note: 'done.ictrpNote',
  },
];

export const renderDoneView: RenderView = (container, ctx) => {
  container.innerHTML = '';
  const doc = container.ownerDocument;
  const heading = doc.createElement('h2');
  heading.textContent = ROUTE_LABELS.done;
  container.appendChild(heading);

  if (!ctx.state.project) {
    const warn = doc.createElement('p');
    warn.className = 'view__placeholder';
    warn.textContent = t('done.noProject');
    container.appendChild(warn);
    return;
  }
  if (!ctx.state.currentFormulaMarkdown) {
    const warn = doc.createElement('p');
    warn.className = 'view__placeholder';
    warn.textContent = t('done.noFormula');
    container.appendChild(warn);
    return;
  }

  const lead = doc.createElement('p');
  lead.className = 'done__lead';
  lead.textContent =
    t('done.lead');
  container.appendChild(lead);

  const pubmedLink = buildPubmedLink(doc, ctx.state.currentFormulaMarkdown);
  if (pubmedLink) {
    container.appendChild(pubmedLink);
  }

  const list = doc.createElement('ul');
  list.className = 'done__links';
  for (const entry of EXTERNAL_LINKS) {
    list.appendChild(buildExternalLink(doc, entry));
  }
  container.appendChild(list);

  const note = doc.createElement('p');
  note.className = 'done__note';
  note.textContent =
    t('done.downloadNote');
  container.appendChild(note);
};

function buildPubmedLink(doc: Document, markdown: string): HTMLElement | null {
  let expanded = '';
  try {
    expanded = expandFormula(parsePubmedFormulaMd(markdown)).trim();
  } catch {
    return null;
  }
  if (expanded === '') {
    return null;
  }
  const wrap = doc.createElement('p');
  wrap.className = 'done__pubmed-link';
  const label = doc.createElement('span');
  label.textContent = t('done.pubmedLink');
  const a = doc.createElement('a');
  a.href = buildPubmedSearchUrl(expanded);
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = expanded;
  wrap.appendChild(label);
  wrap.appendChild(a);
  return wrap;
}

function buildExternalLink(
  doc: Document,
  entry: { label: MessageKey; url: string; note: MessageKey }
): HTMLElement {
  const li = doc.createElement('li');
  const a = doc.createElement('a');
  a.href = entry.url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = t(entry.label);
  const note = doc.createElement('span');
  note.className = 'done__link-note';
  note.textContent = ` — ${t(entry.note)}`;
  li.appendChild(a);
  li.appendChild(note);
  return li;
}
