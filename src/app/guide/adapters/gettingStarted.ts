import type { GuideCondition } from '../../../lib/guide/tours';
import type { GettingStartedCondition, GettingStartedEvent } from '../../../lib/guide/tours/gettingStarted';
import type { AppState } from '../../store';

/** このツアーに固有の条件とイベントは今は無い。手順を足すときにここへ足す。 */
export const GETTING_STARTED_ADAPTER = {
  conditions(_state: AppState): Record<GettingStartedCondition, boolean> {
    return {};
  },
  risingEvents: {} satisfies Partial<Record<GuideCondition, GettingStartedEvent>>,
};
