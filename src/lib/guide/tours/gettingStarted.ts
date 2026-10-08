import { stepKey, tourDescKey, tourKeyBase, tourTitleKey } from './keys';
import type { TourFor } from './types';

export type GettingStartedEvent = never;
export type GettingStartedCondition = never;
const BASE = tourKeyBase('getting-started');

/** 画面の構成を見せ、プロトコル入力を開くところまで案内する。動作確認用の短い手順で、後から手順を足す。 */
export const GETTING_STARTED_TOUR: TourFor<GettingStartedEvent, GettingStartedCondition> = {
  id: 'getting-started',
  titleKey: tourTitleKey(BASE),
  descriptionKey: tourDescKey(BASE),
  steps: [
    { id: 'welcome', route: '#/home', target: 'nav', textKey: stepKey(BASE, 'welcome'),
      advance: { type: 'next' } },
    { id: 'open-protocol', target: 'nav-protocol', textKey: stepKey(BASE, 'open-protocol'),
      advance: { type: 'events', events: ['route-opened-protocol'] } },
    { id: 'finish', target: 'tour-list', textKey: stepKey(BASE, 'finish'),
      advance: { type: 'next' } },
  ],
};
