import { GUIDE_TOURS, type GuideTourId, type TourDefinition } from '../../src/lib/guide/tours';

/**
 * テストの間だけ登録済みのツアーを差し替える。登録済みの ID は空の枠（draft）にし、
 * 渡したツアーだけを有効にする。終了時に元へ戻す。
 */
export function useTestTours(tours: readonly TourDefinition[]): void {
  let original: typeof GUIDE_TOURS;
  beforeEach(() => {
    original = { ...GUIDE_TOURS };
    for (const id of Object.keys(GUIDE_TOURS) as GuideTourId[]) {
      GUIDE_TOURS[id] = { id, titleKey: 'guide.tourGettingStartedTitle', descriptionKey: 'guide.tourGettingStartedDesc', draft: true, steps: [] };
    }
    for (const tour of tours) GUIDE_TOURS[tour.id] = { ...tour, steps: tour.steps.map(step => ({ ...step })) };
  });
  afterEach(() => { Object.assign(GUIDE_TOURS, original); });
}
