import { t } from '@/lib/i18n';
import { ROUTE_LABELS, type RouteName } from '../router';
import type { RenderView } from './types';

/**
 * まだ実装されていない画面用のプレースホルダ。
 * 後続セッションで該当 view が実装されたら差し替える。
 */
export function buildNotImplementedView(route: RouteName): RenderView {
  return (container) => {
    container.innerHTML = '';
    const heading = container.ownerDocument.createElement('h2');
    heading.textContent = ROUTE_LABELS[route];
    container.appendChild(heading);
    const note = container.ownerDocument.createElement('p');
    note.className = 'view__placeholder';
    note.textContent = t('shell.notImplemented', { route: ROUTE_LABELS[route] });
    container.appendChild(note);
  };
}
