import { stepKey, tourDescKey, tourKeyBase, tourTitleKey } from './keys';
import type { TourFor } from './types';

/** optimization-started: 検索式の自動調整が始まった。 */
export type DraftAndOptimizeEvent = 'optimization-started';
/** draft-unavailable: #/draft を開けない状態。optimization-running: 自動調整の実行中。 */
export type DraftAndOptimizeCondition = 'draft-unavailable' | 'optimization-running';
const BASE = tourKeyBase('draft-and-optimize');

/** #/draft の自動調整の設定・開始・履歴・最終レビューと、補助操作を案内する。 */
export const DRAFT_AND_OPTIMIZE_TOUR: TourFor<DraftAndOptimizeEvent, DraftAndOptimizeCondition> = {
  id: 'draft-and-optimize',
  titleKey: tourTitleKey(BASE),
  descriptionKey: tourDescKey(BASE),
  unavailableIf: 'draft-unavailable',
  steps: [
    { id: 'open-draft', target: 'nav-draft', textKey: stepKey(BASE, 'open-draft'),
      advance: { type: 'events', events: ['route-opened-draft'] } },
    { id: 'optimize-settings', target: 'draft-optimize-settings', textKey: stepKey(BASE, 'optimize-settings'),
      route: '#/draft', dynamicTarget: true,
      advance: { type: 'next' } },
    { id: 'optimize-start', target: 'draft-optimize-start', textKey: stepKey(BASE, 'optimize-start'),
      route: '#/draft', dynamicTarget: true,
      advance: { type: 'events', events: ['optimization-started'], optional: true } },
    { id: 'optimize-history', target: 'draft-optimize-history', textKey: stepKey(BASE, 'optimize-history'),
      route: '#/draft', dynamicTarget: true,
      advance: { type: 'next' } },
    { id: 'optimize-review', target: 'draft-optimize-review', textKey: stepKey(BASE, 'optimize-review'),
      route: '#/draft', dynamicTarget: true, scroll: 'start',
      advance: { type: 'next' } },
    { id: 'held-candidates', target: 'draft-held-candidates', textKey: stepKey(BASE, 'held-candidates'),
      route: '#/draft', dynamicTarget: true, blockTarget: true,
      advance: { type: 'next' } },
    { id: 'revalidate', target: 'draft-secondary-actions', textKey: stepKey(BASE, 'revalidate'),
      route: '#/draft', dynamicTarget: true,
      advance: { type: 'next' } },
    { id: 'finish', target: 'tour-list', textKey: stepKey(BASE, 'finish'),
      advance: { type: 'next' } },
  ],
};
