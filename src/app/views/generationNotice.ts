import type { GenerationNotices } from '../store';

export function renderGenerationNotice(doc: Document, notices: GenerationNotices): HTMLElement | null {
  if (!notices.removedMeshHeadings.length && !notices.replacedMeshHeadings.length
    && !notices.parenthesizedTerms.length && !notices.filterNotice) return null;
  const notice = doc.createElement('div');
  notice.className = 'draft__mesh-notice';
  notice.setAttribute('role', 'status');
  const groups = [
    { message: 'MeSH の同義語を正式な見出しに置き換えました',
      items: notices.replacedMeshHeadings.map((item) => `#${item.blockId} ${item.blockLabel}: ${item.from} → ${item.to.join('、')}`) },
    { message: '⚠ MeSH 辞書に無い見出しを式から外しました（AI が提案した見出しが MeSH に存在しないため）',
      items: notices.removedMeshHeadings.map((item) => `#${item.blockId} ${item.blockLabel}: ${item.descriptor}`) },
    { message: '検索語の中の AND / OR を括弧で囲みました（PubMed は括弧の無い AND / OR を左から順に評価し、意図しない絞り込みになるため）',
      items: (notices.parenthesizedTerms ?? []).map((item) => `#${item.blockId} ${item.blockLabel}: (${item.term})`) },
  ];
  for (const group of groups) {
    if (!group.items.length) continue;
    const message = doc.createElement('p');
    message.textContent = group.message;
    notice.appendChild(message);
    const list = doc.createElement('ul');
    for (const item of group.items) {
      const li = doc.createElement('li');
      li.textContent = item;
      list.appendChild(li);
    }
    notice.appendChild(list);
  }
  if (notices.filterNotice) {
    const message = doc.createElement('p');
    message.textContent = notices.filterNotice;
    notice.appendChild(message);
  }
  return notice;
}
