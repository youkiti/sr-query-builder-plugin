import type { GuideCondition } from '../../../lib/guide/tours';
import type { GettingStartedCondition, GettingStartedEvent } from '../../../lib/guide/tours/gettingStarted';
import { evaluateGuards } from '../../guards';
import type { AppState } from '../../store';

export const GETTING_STARTED_ADAPTER = {
  conditions(state: AppState): Record<GettingStartedCondition, boolean> {
    const guards = evaluateGuards(state);
    const approved = guards.draft.enabled && state.protocolDraftPersisted;
    return {
      // #/blocks・#/seeds を開けない間は、その画面に関わる手順を飛ばす（開けないと案内が止まるため）。
      'blocks-unavailable': !guards.blocks.enabled,
      'seeds-unavailable': !guards.seeds.enabled,
      // 承認の手順が要らないのは、#/blocks を開けない間か、承認済みのとき。
      'approve-blocks-not-needed': !guards.blocks.enabled || approved,
      // ブロックが承認（Sheets へ保存）された状態。#/draft を開ける条件に、保存済みであることを足す。
      'blocks-approved': approved,
    };
  },
  risingEvents: {
    'has-protocol': 'protocol-analyzed',
    'blocks-approved': 'blocks-approved',
  } satisfies Partial<Record<GuideCondition, GettingStartedEvent>>,
};
