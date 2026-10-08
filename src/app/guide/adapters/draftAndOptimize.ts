import type { GuideCondition } from '../../../lib/guide/tours';
import type { DraftAndOptimizeCondition, DraftAndOptimizeEvent } from '../../../lib/guide/tours/draftAndOptimize';
import { evaluateGuards } from '../../guards';
import type { AppState } from '../../store';

export const DRAFT_AND_OPTIMIZE_ADAPTER = {
  conditions(state: AppState): Record<DraftAndOptimizeCondition, boolean> {
    return {
      // #/draft を開ける条件（guards.ts）と同じ判定に揃える。
      'draft-unavailable': !evaluateGuards(state).draft.enabled,
      'optimization-running': state.queryOptimizationRun?.status === 'running',
    };
  },
  risingEvents: {
    'optimization-running': 'optimization-started',
  } satisfies Partial<Record<GuideCondition, DraftAndOptimizeEvent>>,
};
