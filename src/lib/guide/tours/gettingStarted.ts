import { stepKey, tourDescKey, tourKeyBase, tourTitleKey } from './keys';
import type { TourFor } from './types';

/** protocol-analyzed: プロトコルの解析が済んだ。blocks-approved: ブロックが承認（保存）された。 */
export type GettingStartedEvent = 'protocol-analyzed' | 'blocks-approved';
/**
 * blocks-approved: ブロックが承認済み。
 * blocks-unavailable: #/blocks を開けない。seeds-unavailable: #/seeds を開けない。
 * approve-blocks-not-needed: 承認の手順が要らない（#/blocks を開けない、または承認済み）。
 */
export type GettingStartedCondition = 'blocks-approved' | 'blocks-unavailable' | 'seeds-unavailable' | 'approve-blocks-not-needed';
const BASE = tourKeyBase('getting-started');

/** プロジェクトを選んだ状態から、プロトコル入力・ブロック承認・シード論文の登録までを案内する。 */
export const GETTING_STARTED_TOUR: TourFor<GettingStartedEvent, GettingStartedCondition> = {
  id: 'getting-started',
  titleKey: tourTitleKey(BASE),
  descriptionKey: tourDescKey(BASE),
  steps: [
    { id: 'welcome', route: '#/home', target: 'nav', textKey: stepKey(BASE, 'welcome'),
      advance: { type: 'next' } },
    { id: 'open-protocol', target: 'nav-protocol', textKey: stepKey(BASE, 'open-protocol'),
      skipIf: 'has-protocol',
      advance: { type: 'events', events: ['route-opened-protocol'] } },
    { id: 'enter-protocol', target: 'protocol-form', textKey: stepKey(BASE, 'enter-protocol'),
      route: '#/protocol', dynamicTarget: true,
      skipIf: 'has-protocol',
      advance: { type: 'events', events: ['protocol-analyzed'], optional: true } },
    { id: 'open-blocks', target: 'nav-blocks', textKey: stepKey(BASE, 'open-blocks'),
      skipIf: 'blocks-unavailable',
      advance: { type: 'events', events: ['route-opened-blocks'] } },
    { id: 'review-blocks', target: 'blocks-list', textKey: stepKey(BASE, 'review-blocks'),
      route: '#/blocks', dynamicTarget: true,
      skipIf: 'blocks-unavailable',
      advance: { type: 'next' } },
    { id: 'review-filters', target: 'blocks-filters', textKey: stepKey(BASE, 'review-filters'),
      route: '#/blocks', dynamicTarget: true,
      skipIf: 'blocks-unavailable',
      advance: { type: 'next' } },
    { id: 'approve-blocks', target: 'blocks-approve', textKey: stepKey(BASE, 'approve-blocks'),
      route: '#/blocks', dynamicTarget: true,
      skipIf: 'approve-blocks-not-needed',
      advance: { type: 'events', events: ['blocks-approved'], optional: true } },
    { id: 'open-seeds', target: 'nav-seeds', textKey: stepKey(BASE, 'open-seeds'),
      skipIf: 'seeds-unavailable',
      advance: { type: 'events', events: ['route-opened-seeds'] } },
    { id: 'add-seeds', target: 'seeds-form', textKey: stepKey(BASE, 'add-seeds'),
      route: '#/seeds', dynamicTarget: true,
      skipIf: 'seeds-unavailable',
      advance: { type: 'next' } },
    { id: 'finish', target: 'tour-list', textKey: stepKey(BASE, 'finish'),
      advance: { type: 'next' } },
  ],
};
