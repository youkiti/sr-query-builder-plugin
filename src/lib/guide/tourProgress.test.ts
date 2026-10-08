import {
  GUIDE_PROGRESS_STORAGE_KEY, availableTours, completeTour, createEmptyGuideProgress,
  decideProgressSync, dismissTour, hasRemainingSteps, isTourUnavailable, nextStepIndex, parseGuideProgress,
  serializeGuideProgress, setActiveStep, shouldAdvance, shouldSuggest, startTour,
  suppressSuggestions, tourToSuggestOnEvent, visibleStepPosition, resolveShownCount, shownStepPosition, recordShownStep, recordResumedStep,
} from './tourProgress';
import { GUIDE_TOURS, type GuideTourId, type TourDefinition, type TourStep } from './tours';

import { useTestTours } from '../../../tests/fixtures/guideTours';

const ID = 'getting-started';
const NOW = '2026-10-07T00:00:00.000Z';
const steps: TourStep[] = [
  { id: 'import', target: 'import', textKey: 'import', route: '#/seeds', skipIf: 'has-project', advance: { type: 'events', events: ['route-opened-seeds'] } },
  { id: 'protocol', target: 'protocol', textKey: 'protocol', skipIf: 'has-protocol', advance: { type: 'next' } },
  { id: 'finish', target: 'finish', textKey: 'finish', advance: { type: 'next' } },
];
const tour: TourDefinition = { id: ID, titleKey: 'title', descriptionKey: 'description', steps, suggestOn: 'route-opened-home' };
const empty = createEmptyGuideProgress;

useTestTours([tour]);

test.each([undefined, 0, -1, 0.5, 4])('再開で越えた先は旧保存値・不正値 %s を移動先の位置で補完する', savedCount => {
  const base = startTour(empty(), ID);
  const resumed = recordResumedStep(base, ID, 1, { 'has-project': true }, savedCount);
  expect(resumed.active).toEqual({ tourId: ID, stepId: 'protocol', stepIndex: 1, shownCount: 1 });
  expect(recordResumedStep(base, ID, 2, { 'has-project': true }, savedCount).active?.shownCount).toBe(2);
  expect(base.active?.shownCount).toBeUndefined();
});

test('再開で越えた先は有効な保存表示数に加算する', () => {
  const resumed = recordResumedStep(startTour(empty(), ID), ID, 1, { 'has-project': true }, 1);
  expect(resumed.active?.shownCount).toBe(2);
});

test('終了以外の省略されない手順がある場合だけ残作業がある', () => {
  expect(hasRemainingSteps(tour, {})).toBe(true);
  expect(hasRemainingSteps(tour, new Set(['has-project']))).toBe(true);
  expect(hasRemainingSteps(tour, { 'has-project': true, 'has-protocol': true })).toBe(false);
  expect(hasRemainingSteps({ steps: [steps[2]!] }, {})).toBe(false);
  expect(hasRemainingSteps({ steps: [] }, {})).toBe(false);
  expect(hasRemainingSteps({ steps: [{ ...steps[2]!, id: 'action' }] }, {})).toBe(true);
});

test('保存キーと既定値。不正な値・記録は読み飛ばす', () => {
  expect(GUIDE_PROGRESS_STORAGE_KEY).toBe('guide_progress');
  for (const raw of [undefined, null, 'x', 3, [], { tours: 'x', active: 5 }]) {
    expect(parseGuideProgress(raw)).toEqual(empty());
  }
  for (const value of [null, [], { status: 'invalid', at: NOW }, { status: 'done', at: 1 }]) {
    expect(parseGuideProgress({ tours: { [ID]: value, unknown: { status: 'done', at: NOW } } })).toEqual(empty());
  }
  for (const status of ['done', 'dismissed']) {
    expect(parseGuideProgress({ tours: { [ID]: { status, at: NOW } }, suppressSuggestions: true, extra: 1 }))
      .toEqual({ tours: { [ID]: { status, at: NOW } }, active: null, suppressSuggestions: true });
  }
});

test('再開は添字より手順 ID を優先し、旧形式は整数の範囲内だけを読む', () => {
  expect(parseGuideProgress({ active: { tourId: ID, stepId: 'finish', stepIndex: 99 } }).active)
    .toEqual({ tourId: ID, stepId: 'finish', stepIndex: 2 });
  for (const active of [
    { tourId: 'unknown', stepIndex: 0 }, { tourId: ID, stepId: 'removed', stepIndex: 0 },
    ...[undefined, '1', -1, 1.5, 3, NaN].map(stepIndex => ({ tourId: ID, stepIndex })),
  ]) {
    const parsed = parseGuideProgress({ active, tours: { [ID]: { status: 'done', at: NOW } } });
    expect(parsed.active).toBeNull();
    expect(parsed.tours[ID]).toEqual({ status: 'done', at: NOW });
  }
  expect(parseGuideProgress({ active: { tourId: ID, stepIndex: 1 } }).active)
    .toEqual({ tourId: ID, stepId: 'protocol', stepIndex: 1 });
});

test('直列化の往復と状態遷移は元の状態を書き換えない', () => {
  const base = empty();
  const started = startTour(base, ID);
  expect(started.active).toEqual({ tourId: ID, stepId: 'import', stepIndex: 0 });
  const moved = setActiveStep(started, 2);
  expect(moved.active).toEqual({ tourId: ID, stepId: 'finish', stepIndex: 2 });
  expect(parseGuideProgress(JSON.parse(JSON.stringify(serializeGuideProgress(moved))))).toEqual(moved);
  expect(serializeGuideProgress(moved).active).not.toBe(moved.active);
  expect(serializeGuideProgress(moved).tours).not.toBe(moved.tours);
  expect(serializeGuideProgress(base)).toEqual(base);
  expect(setActiveStep(base, 1)).toBe(base);
  expect(startTour(moved, ID, 1).active?.stepIndex).toBe(1);
  expect(startTour(base, ID, 99).active?.stepId).toBe('');
  expect(completeTour(moved, ID, NOW)).toEqual({ ...base, tours: { [ID]: { status: 'done', at: NOW } } });
  expect(dismissTour(started, ID, NOW).tours[ID]).toEqual({ status: 'dismissed', at: NOW });
  expect(completeTour(base, ID, NOW).active).toBeNull();
  // 将来別のツアーが追加された場合も、実行中でないツアーの終了は表示を消さない。
  const other = 'another-tour' as GuideTourId;
  expect(completeTour(moved, other, NOW).active).toEqual(moved.active);
  expect(suppressSuggestions(moved).suppressSuggestions).toBe(true);
  expect(base).toEqual(empty());
  expect(started.active?.stepIndex).toBe(0);
});

test('条件に応じて連続した手順を飛ばし、最後を過ぎると終了する', () => {
  expect(nextStepIndex(tour, -1, {})).toBe(0);
  expect(nextStepIndex(tour, 0, { 'has-project': true, 'has-protocol': true })).toBe(2);
  expect(nextStepIndex(tour, 0, new Set(['has-project']))).toBe(1);
  expect(nextStepIndex(tour, 0, new Set())).toBe(0);
  expect(nextStepIndex(tour, 3, {})).toBeNull();
  expect(nextStepIndex({ steps: steps.slice(0, 2) }, 0, { 'has-project': true, 'has-protocol': true })).toBeNull();
  expect(nextStepIndex({ steps: [] }, 0, {})).toBeNull();
});

test('表示番号は飛ばされない手順だけで数え、先頭を飛ばす場合は最低 1、全部なら 0', () => {
  expect(visibleStepPosition(tour, 0, {})).toEqual({ position: 1, total: 3 });
  expect(visibleStepPosition(tour, 2, {})).toEqual({ position: 3, total: 3 });
  expect(visibleStepPosition(tour, 0, { 'has-project': true })).toEqual({ position: 1, total: 2 });
  expect(visibleStepPosition(tour, 1, new Set(['has-protocol']))).toEqual({ position: 1, total: 2 });
  expect(visibleStepPosition({ steps: steps.slice(0, 2) }, 0, { 'has-project': true, 'has-protocol': true }))
    .toEqual({ position: 0, total: 0 });
});

test('events は一致イベントだけで進み、optional でも同じ。next はイベントでは進まない', () => {
  for (const optional of [undefined, true] as const) {
    const step: TourStep = { ...steps[0]!, advance: { type: 'events', events: ['route-opened-seeds'], optional } };
    expect(shouldAdvance(step, 'route-opened-seeds')).toBe(true);
    expect(shouldAdvance(step, 'route-opened-home')).toBe(false);
  }
  expect(shouldAdvance(steps[2]!, 'route-opened-home')).toBe(false);
});

test('利用可能性は draft と任意の条件で判定する', () => {
  const unavailable: TourDefinition = { ...tour, unavailableIf: 'has-protocol' };
  expect(availableTours([{ ...tour, draft: true }, tour])).toEqual([tour]);
  expect(availableTours()).toEqual([tour]);
  expect(availableTours([unavailable])).toEqual([unavailable]);
  expect(availableTours([unavailable], { 'has-protocol': true })).toEqual([]);
  expect(availableTours([unavailable], {})).toEqual([unavailable]);
  expect(isTourUnavailable(tour, {})).toBe(false);
  expect(isTourUnavailable(unavailable, new Set(['has-protocol']))).toBe(true);
  expect(isTourUnavailable(unavailable, {})).toBe(false);
});

test('初回提案は画面・延期・抑止・実行中・完了・却下を考慮する', () => {
  const context = { screen: 'home' as const };
  expect(shouldSuggest(empty(), context)).toBe(true);
  expect(shouldSuggest(empty(), { screen: 'other' })).toBe(false);
  expect(shouldSuggest(empty(), { ...context, postponedThisSession: true })).toBe(false);
  for (const progress of [suppressSuggestions(empty()), startTour(empty(), ID), completeTour(empty(), ID, NOW), dismissTour(empty(), ID, NOW)]) {
    expect(shouldSuggest(progress, context)).toBe(false);
  }
  GUIDE_TOURS[ID] = { ...tour, draft: true };
  expect(shouldSuggest(empty(), context)).toBe(false);
});

test('イベント提案は一致する未完了ツアーだけを返す', () => {
  expect(tourToSuggestOnEvent(empty(), 'route-opened-home')).toBe(GUIDE_TOURS[ID]);
  expect(tourToSuggestOnEvent(empty(), 'route-opened-seeds', [tour])).toBeNull();
  expect(tourToSuggestOnEvent(empty(), 'route-opened-home', [{ ...tour, suggestOn: undefined }])).toBeNull();
  expect(tourToSuggestOnEvent(empty(), 'route-opened-home', [{ ...tour, draft: true }])).toBeNull();
  expect(tourToSuggestOnEvent(empty(), 'route-opened-home', [{ ...tour, unavailableIf: 'has-project' }], { 'has-project': true })).toBeNull();
  for (const progress of [suppressSuggestions(empty()), startTour(empty(), ID), completeTour(empty(), ID, NOW), dismissTour(empty(), ID, NOW)]) {
    expect(tourToSuggestOnEvent(progress, 'route-opened-home', [tour])).toBeNull();
  }
});

test('同期は保存値を正として、同じ手順なら維持、違えば切替、終了・別ツアーなら閉じる', () => {
  const active = startTour(empty(), ID).active!;
  expect(decideProgressSync(active, null)).toEqual({ type: 'none' });
  expect(decideProgressSync(null, active)).toEqual({ type: 'close' });
  expect(decideProgressSync(active, { tourId: 'another-tour' as GuideTourId, stepIndex: 0 })).toEqual({ type: 'close' });
  expect(decideProgressSync(active, active)).toEqual({ type: 'none' });
  expect(decideProgressSync({ ...active, stepIndex: 2 }, active)).toEqual({ type: 'switch', stepIndex: 2 });
});


test('表示数の保存・補完と、通過済みを保持した残りの計算', () => {
  const first = recordShownStep(empty(), ID, 0, 0);
  const moved = recordShownStep(first, ID, 1, first.active!.shownCount!);
  expect(first.active?.shownCount).toBe(1);
  expect(moved.active?.shownCount).toBe(2);
  expect(parseGuideProgress(serializeGuideProgress(moved))).toEqual(moved);
  expect(shownStepPosition(tour, 1, { 'has-project': true }, 2)).toEqual({ position: 2, total: 3 });
  expect(shownStepPosition(tour, 0, new Set(['has-protocol']), 1)).toEqual({ position: 1, total: 2 });
  expect(resolveShownCount(tour, 2, { 'has-project': true }, 3)).toBe(3);
  for (const shownCount of [undefined, null, '2', -1, 0, 1.5, 4, NaN, Infinity]) {
    const parsed = parseGuideProgress({ active: { tourId: ID, stepIndex: 2, shownCount } });
    expect(parsed.active?.shownCount).toBeUndefined();
    expect(resolveShownCount(tour, 2, { 'has-project': true }, shownCount)).toBe(2);
  }
});
