import { stepKey, tourDescKey, tourKeyBase, tourTitleKey } from './keys';
import type { TourFor } from './types';

/** expand-candidates-fetched: 境界事例の取得が終わり、候補が出た。 */
export type ExpandSeedsEvent = 'expand-candidates-fetched';
/** expand-unavailable: #/expand を開けない状態。expand-candidates-ready: 候補の取得が済んでいる。 */
export type ExpandSeedsCondition = 'expand-unavailable' | 'expand-candidates-ready';
const BASE = tourKeyBase('expand-seeds');

/** #/expand で、現式の外側から境界事例を取得し、判定して、更新提案を見るまでを案内する。 */
export const EXPAND_SEEDS_TOUR: TourFor<ExpandSeedsEvent, ExpandSeedsCondition> = {
  id: 'expand-seeds',
  titleKey: tourTitleKey(BASE),
  descriptionKey: tourDescKey(BASE),
  unavailableIf: 'expand-unavailable',
  steps: [
    { id: 'open-expand', target: 'nav-expand', textKey: stepKey(BASE, 'open-expand'),
      advance: { type: 'events', events: ['route-opened-expand'] } },
    { id: 'fetch-candidates', target: 'expand-fetch', textKey: stepKey(BASE, 'fetch-candidates'),
      route: '#/expand', dynamicTarget: true,
      advance: { type: 'events', events: ['expand-candidates-fetched'], optional: true } },
    { id: 'judge-candidates', target: 'expand-candidates', textKey: stepKey(BASE, 'judge-candidates'),
      route: '#/expand', dynamicTarget: true, scroll: 'start',
      advance: { type: 'next' } },
    { id: 'update-proposals', target: 'expand-proposals', textKey: stepKey(BASE, 'update-proposals'),
      route: '#/expand', dynamicTarget: true,
      advance: { type: 'next' } },
    { id: 'finish', target: 'tour-list', textKey: stepKey(BASE, 'finish'),
      advance: { type: 'next' } },
  ],
};
