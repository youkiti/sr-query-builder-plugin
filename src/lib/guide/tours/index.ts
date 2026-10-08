import { GETTING_STARTED_TOUR, type GettingStartedEvent, type GettingStartedCondition } from './gettingStarted';
import { DRAFT_AND_OPTIMIZE_TOUR, type DraftAndOptimizeEvent, type DraftAndOptimizeCondition } from './draftAndOptimize';
import { EXPAND_SEEDS_TOUR, type ExpandSeedsEvent, type ExpandSeedsCondition } from './expandSeeds';
import { EDIT_AND_EXPORT_TOUR, type EditAndExportEvent, type EditAndExportCondition } from './editAndExport';
import type {
  CommonGuideCondition,
  CommonGuideEventName,
  GuideTourId,
  TourAdvance,
  TourDefinitionOf,
  TourStepOf,
} from './types';

export type { CommonGuideCondition, CommonGuideEventName, GuideTourId } from './types';
export { stepKey, tourDescKey, tourKeyBase, tourTitleKey } from './keys';

export type GuideEventName = CommonGuideEventName | GettingStartedEvent
  | DraftAndOptimizeEvent
  | ExpandSeedsEvent
  | EditAndExportEvent;
export type GuideCondition = CommonGuideCondition | GettingStartedCondition
  | DraftAndOptimizeCondition
  | ExpandSeedsCondition
  | EditAndExportCondition;
export type TourStep = TourStepOf<GuideEventName, GuideCondition>;
export type TourDefinition = TourDefinitionOf<GuideEventName, GuideCondition>;
export type GuideTourAdvance = TourAdvance<GuideEventName>;

export const GUIDE_TOURS: Record<GuideTourId, TourDefinition> = {
  'getting-started': GETTING_STARTED_TOUR,
  'draft-and-optimize': DRAFT_AND_OPTIMIZE_TOUR,
  'expand-seeds': EXPAND_SEEDS_TOUR,
  'edit-and-export': EDIT_AND_EXPORT_TOUR,
};

export const GUIDE_TOUR_IDS = Object.keys(GUIDE_TOURS) as GuideTourId[];

export function isGuideTourId(value: unknown): value is GuideTourId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(GUIDE_TOURS, value);
}
