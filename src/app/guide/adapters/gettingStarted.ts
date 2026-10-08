import type { GuideCondition } from '../../../lib/guide/tours';
import type { GettingStartedCondition, GettingStartedEvent } from '../../../lib/guide/tours/gettingStarted';
import { evaluateGuards } from '../../guards';
import type { AppState } from '../../store';

export const GETTING_STARTED_ADAPTER = {
  conditions(state: AppState): Record<GettingStartedCondition, boolean> {
    return {
      // ブロックが承認（Sheets へ保存）された状態。#/draft を開ける条件に、保存済みであることを足す。
      'blocks-approved': evaluateGuards(state).draft.enabled && state.protocolDraftPersisted,
    };
  },
  risingEvents: {
    'has-protocol': 'protocol-analyzed',
    'blocks-approved': 'blocks-approved',
  } satisfies Partial<Record<GuideCondition, GettingStartedEvent>>,
};
