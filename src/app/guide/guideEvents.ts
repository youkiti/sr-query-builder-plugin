import type { GuideCondition, GuideEventName, TourStep } from '../../lib/guide/tours';
import type { RouteName } from '../router';
import { GUIDE_ADAPTERS } from './adapters';

const EVENTS = Object.values(GUIDE_ADAPTERS).flatMap(adapter => Object.entries(adapter.risingEvents)) as Array<[GuideCondition, GuideEventName]>;

/** 状態の立ち上がりだけを通知する。サービスの成功経路には依存しない。 */
export function guideEvents(
  before: Record<GuideCondition, boolean>, after: Record<GuideCondition, boolean>,
): GuideEventName[] {
  return EVENTS
    .filter(([condition]) => !before[condition] && after[condition])
    .map(([, event]) => event);
}

export function routeGuideEvent(route: `#/${RouteName}`): GuideEventName {
  return `route-opened-${route.slice(2)}` as GuideEventName;
}

export function isSatisfiedByRoute(step: TourStep, route: string): boolean {
  return step.advance.type === 'events' && step.advance.events.some(event => event === `route-opened-${route.slice(2)}`);
}
