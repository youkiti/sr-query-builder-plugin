import type { GuideCondition } from '../../../lib/guide/tours';
import type { EditAndExportCondition, EditAndExportEvent } from '../../../lib/guide/tours/editAndExport';
import { evaluateGuards } from '../../guards';
import type { AppState } from '../../store';

export const EDIT_AND_EXPORT_ADAPTER = {
  conditions(state: AppState): Record<EditAndExportCondition, boolean> {
    return {
      // #/edit を開ける条件（guards.ts）と同じ判定に揃える。
      'edit-unavailable': !evaluateGuards(state).edit.enabled,
      // #/export を開けない間（保存済みの版が無い）は、エクスポートの手順を飛ばす。
      'export-unavailable': !evaluateGuards(state).export.enabled,
      'formula-save-done': state.formulaSave?.status === 'saved',
    };
  },
  risingEvents: {
    'formula-save-done': 'formula-saved',
  } satisfies Partial<Record<GuideCondition, EditAndExportEvent>>,
};
