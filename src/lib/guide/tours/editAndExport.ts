import { stepKey, tourDescKey, tourKeyBase, tourTitleKey } from './keys';
import type { TourFor } from './types';

/** formula-saved: 編集した検索式が新しいバージョンとして保存された。 */
export type EditAndExportEvent = 'formula-saved';
/** edit-unavailable: #/edit を開けない状態。formula-save-done: 検索式の編集保存が完了している。 */
export type EditAndExportCondition = 'edit-unavailable' | 'formula-save-done';
const BASE = tourKeyBase('edit-and-export');

/** #/edit でブロックを編集して保存し、#/export で他のデータベース向けに変換するまでを案内する。 */
export const EDIT_AND_EXPORT_TOUR: TourFor<EditAndExportEvent, EditAndExportCondition> = {
  id: 'edit-and-export',
  titleKey: tourTitleKey(BASE),
  descriptionKey: tourDescKey(BASE),
  unavailableIf: 'edit-unavailable',
  steps: [
    { id: 'open-edit', target: 'nav-edit', textKey: stepKey(BASE, 'open-edit'),
      advance: { type: 'events', events: ['route-opened-edit'] } },
    { id: 'edit-blocks', target: 'edit-blocks', textKey: stepKey(BASE, 'edit-blocks'),
      route: '#/edit', dynamicTarget: true, scroll: 'start',
      advance: { type: 'next' } },
    { id: 'inspect-block', target: 'edit-inspector', textKey: stepKey(BASE, 'inspect-block'),
      route: '#/edit', dynamicTarget: true, scroll: 'start',
      advance: { type: 'next' } },
    { id: 'save-version', target: 'edit-save', textKey: stepKey(BASE, 'save-version'),
      route: '#/edit', dynamicTarget: true,
      advance: { type: 'events', events: ['formula-saved'], optional: true } },
    { id: 'open-export', target: 'nav-export', textKey: stepKey(BASE, 'open-export'),
      advance: { type: 'events', events: ['route-opened-export'] } },
    // 変換の実行は状態に痕跡を残さない（結果は画面に出るだけ）ため、完了では進めず「次へ」で進める。
    { id: 'run-export', target: 'export-run', textKey: stepKey(BASE, 'run-export'),
      route: '#/export', dynamicTarget: true,
      advance: { type: 'next' } },
    { id: 'convert-databases', target: 'export-results', textKey: stepKey(BASE, 'convert-databases'),
      route: '#/export', dynamicTarget: true, scroll: 'start',
      advance: { type: 'next' } },
    { id: 'finish', target: 'tour-list', textKey: stepKey(BASE, 'finish'),
      advance: { type: 'next' } },
  ],
};
