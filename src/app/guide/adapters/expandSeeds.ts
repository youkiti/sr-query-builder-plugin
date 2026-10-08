import type { GuideCondition } from '../../../lib/guide/tours';
import type { ExpandSeedsCondition, ExpandSeedsEvent } from '../../../lib/guide/tours/expandSeeds';
import { evaluateGuards } from '../../guards';
import type { AppState } from '../../store';

export const EXPAND_SEEDS_ADAPTER = {
  conditions(state: AppState): Record<ExpandSeedsCondition, boolean> {
    return {
      // #/expand を開ける条件（guards.ts）と同じ判定に揃える。
      'expand-unavailable': !evaluateGuards(state).expand.enabled,
      'expand-candidates-ready': state.expandRun?.status === 'ready',
    };
  },
  risingEvents: {
    'expand-candidates-ready': 'expand-candidates-fetched',
  } satisfies Partial<Record<GuideCondition, ExpandSeedsEvent>>,
};
