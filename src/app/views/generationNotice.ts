import { t } from '@/lib/i18n';
import type { GenerationNotices } from '../store';

export function renderGenerationNotice(doc: Document, notices: GenerationNotices): HTMLElement | null {
  if (!notices.removedMeshHeadings.length && !notices.replacedMeshHeadings.length
    && !notices.parenthesizedTerms.length && !notices.filterNotice) return null;
  const notice = doc.createElement('div');
  notice.className = 'draft__mesh-notice';
  notice.setAttribute('role', 'status');
  const groups = [
    { message: t('draft.notice.replacedMeshSynonymsWithOfficial'),
      items: notices.replacedMeshHeadings.map((item) => `#${item.blockId} ${item.blockLabel}: ${item.from} → ${item.to.join(t('draft.notice.listSeparator'))}`) },
    { message: t('draft.notice.removedHeadingsThatAreNot'),
      items: notices.removedMeshHeadings.map((item) => `#${item.blockId} ${item.blockLabel}: ${item.descriptor}`) },
    { message: t('draft.notice.addedParenthesesAroundAndOr'),
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
