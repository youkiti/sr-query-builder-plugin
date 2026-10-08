import { GUIDE_TOURS, type GuideTourId, type TourDefinition } from '../../src/lib/guide/tours';

/**
 * 実行部（tourRunner など）の検査に使う、3 手順の固定のツアー。実際のツアーの手順は増減するため、
 * 手順数や並びに依存する検査は、実物ではなくこの定義を土台にする（文言キーは実在するものを使う）。
 */
export const SAMPLE_TOUR: TourDefinition = {
  id: 'getting-started',
  titleKey: 'guide.tourGettingStartedTitle',
  descriptionKey: 'guide.tourGettingStartedDesc',
  steps: [
    { id: 'welcome', route: '#/home', target: 'nav', textKey: 'guide.tourGettingStartedStepWelcome',
      advance: { type: 'next' } },
    { id: 'open-protocol', target: 'nav-protocol', textKey: 'guide.tourGettingStartedStepOpenProtocol',
      advance: { type: 'events', events: ['route-opened-protocol'] } },
    { id: 'finish', target: 'tour-list', textKey: 'guide.tourGettingStartedStepFinish',
      advance: { type: 'next' } },
  ],
};

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
