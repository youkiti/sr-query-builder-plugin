import type { GuideCondition } from '../../lib/guide/tours';
import { evaluateGuards } from '../guards';
import type { AppState } from '../store';
import { GUIDE_ADAPTERS } from './adapters';

export function computeGuideConditions(state: AppState): Record<GuideCondition, boolean> {
  return {
    'has-project': state.project !== null,
    // #/blocks を開ける条件（guards.ts）と同じ判定に揃える。
    'has-protocol': evaluateGuards(state).blocks.enabled,
    ...GUIDE_ADAPTERS.gettingStarted.conditions(state),
  };
}
