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

const EXTERNAL_LINKS: Array<{ label: string; url: string; note: string }> = [
  {
    label: 'Cochrane CENTRAL で開く',
    url: 'https://www.cochranelibrary.com/central/',
    note: 'Advanced search → 変換後の検索式を貼り付け',
  },
  {
    label: 'Embase (Dialog) で開く',
    url: 'https://dialog.proquest.com/',
    note: '契約機関のアカウントでログイン → Advanced Search に変換後の検索式（S1〜）を 1 行ずつ入力',
  },
  {
    label: 'ClinicalTrials.gov で開く',
    url: 'https://clinicaltrials.gov/search',
    note: 'Condition / Intervention / Other Terms に変換後のキーワードを分けて入力',
  },
  {
    label: 'ICTRP で開く',
    url: 'https://trialsearch.who.int/',
    note: 'Basic search に変換後のキーワードを貼り付け（自由語のみ対応）',
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
  lead.className = 'done__lead';
  lead.textContent =
    '検索式の開発が完了しました。各データベースで検索を実行して、結果を nbib / RIS 形式でダウンロードしてください。';
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
    'PubMed は「Send to → Citation manager → PubMed format (NBIB)」、CT.gov / ICTRP は各画面の XML / CSV から書き出せます。';
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
  label.textContent = 'PubMed で直接開く: ';
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
  entry: { label: string; url: string; note: string }
): HTMLElement {
  const li = doc.createElement('li');
  const a = doc.createElement('a');
  a.href = entry.url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = entry.label;
  const note = doc.createElement('span');
  note.className = 'done__link-note';
  note.textContent = ` — ${entry.note}`;
  li.appendChild(a);
  li.appendChild(note);
  return li;
}
