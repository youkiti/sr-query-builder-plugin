import { GUIDE_TOURS, isGuideTourId } from './tours';
import type { GuideCondition, GuideEventName, TourDefinition, TourStep } from './tours';
import type { GuideTourId } from './tours/types';

/**
 * ツアーの進行状態。保存・読み込みそのものは呼び出し側が行い、
 * このモジュールは検証・直列化・状態遷移の純関数だけを持つ。
 */
export const GUIDE_PROGRESS_STORAGE_KEY = 'guide_progress';

export interface GuideTourRecord {
  status: 'done' | 'dismissed';
  /** ISO 8601 の日時 */
  at: string;
}

export interface GuideActiveTour {
  tourId: GuideTourId;
  /** 実行中の手順の ID。保存・再開の正本（手順を足す・並べ替えても再開位置がずれない） */
  stepId: string;
  /** 実行中の手順の位置（steps の添字）。読み込み時に stepId から今の定義に合わせて求め直す */
  stepIndex: number;
  /** 実際に表示した手順数。旧保存値は表示時の条件で補完する */
  shownCount?: number;
}

export interface GuideProgress {
  tours: Partial<Record<GuideTourId, GuideTourRecord>>;
  active: GuideActiveTour | null;
  /** 自動提案を「今後表示しない」にしたか */
  suppressSuggestions: boolean;
}

/** 呼び出し側が画面の状態から作る条件の値。Record でも Set でもよい（無いキーは偽）。 */
export type GuideConditionValues = Readonly<Partial<Record<GuideCondition, boolean>>> | ReadonlySet<GuideCondition>;

export function createEmptyGuideProgress(): GuideProgress {
  return { tours: {}, active: null, suppressSuggestions: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 不明な値から検証済みの進行状態を作る。壊れた値・未知のキーは読み飛ばして既定値に戻す。 */
export function parseGuideProgress(raw: unknown): GuideProgress {
  const result = createEmptyGuideProgress();
  if (!isRecord(raw)) return result;

  if (isRecord(raw.tours)) {
    for (const [key, value] of Object.entries(raw.tours)) {
      if (!isGuideTourId(key) || !isRecord(value)) continue;
      if (value.status !== 'done' && value.status !== 'dismissed') continue;
      if (typeof value.at !== 'string') continue;
      result.tours[key] = { status: value.status, at: value.at };
    }
  }

  if (isRecord(raw.active) && isGuideTourId(raw.active.tourId)) {
    const tour = GUIDE_TOURS[raw.active.tourId];
    const savedId = raw.active.stepId;
    const index = raw.active.stepIndex;
    if (typeof savedId === 'string') {
      // 手順の ID を優先する。保存時の添字と食い違っていても、今の定義での位置に解決する。
      // 実在しない ID（手順が削除・改名された）は再開しない
      const found = tour.steps.findIndex(step => step.id === savedId);
      if (found >= 0) result.active = { tourId: tour.id, stepId: savedId, stepIndex: found };
    } else if (typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < tour.steps.length) {
      // stepId を持たない旧版の保存値は添字しか情報が無い。手順の挿入などでずれている可能性は
      // ここでは直せない。
      result.active = { tourId: tour.id, stepId: tour.steps[index]!.id, stepIndex: index };
    }
    if (result.active && isValidShownCount(raw.active.shownCount, tour)) {
      result.active.shownCount = raw.active.shownCount;
    }
  }

  result.suppressSuggestions = raw.suppressSuggestions === true;
  return result;
}

/** 保存する値（JSON にできるプレーンなオブジェクト）。 */
export function serializeGuideProgress(progress: GuideProgress): GuideProgress {
  return {
    tours: { ...progress.tours },
    active: progress.active ? { ...progress.active } : null,
    suppressSuggestions: progress.suppressSuggestions,
  };
}

function isConditionTrue(conditions: GuideConditionValues, condition: GuideCondition): boolean {
  if (conditions instanceof Set) return conditions.has(condition);
  return (conditions as Partial<Record<GuideCondition, boolean>>)[condition] === true;
}

/**
 * fromIndex 以降で、skipIf を満たさない最初の手順の位置を返す。全部飛ばす／最後を過ぎたら null（終了）。
 * 開始時は 0、手順を終えたあとは「今の位置 + 1」を渡す。
 */
export function nextStepIndex(
  tour: Pick<TourDefinition, 'steps'>,
  fromIndex: number,
  conditions: GuideConditionValues,
): number | null {
  for (let i = Math.max(0, fromIndex); i < tour.steps.length; i += 1) {
    const skipIf = tour.steps[i]!.skipIf;
    if (skipIf === undefined || !isConditionTrue(conditions, skipIf)) return i;
  }
  return null;
}

export interface VisibleStepPosition {
  /** 表示する現在位置（1 始まり。旧形式で全件省略なら 0） */
  position: number;
  /** 表示する全体の手順数 */
  total: number;
}

/** 終了の案内以外に、今の条件で省略されない手順が残っているか。 */
export function hasRemainingSteps(tour: Pick<TourDefinition, 'steps'>, conditions: GuideConditionValues): boolean {
  return tour.steps.some(step => step.id !== 'finish' &&
    (step.skipIf === undefined || !isConditionTrue(conditions, step.skipIf)));
}

/**
 * 旧保存値の表示数を補完するための位置。conditions で飛ばされる手順は数えない。
 * index が飛ばされる手順そのものなら、その位置までに出る手順の数（最低 1。出る手順が1つも無ければ 0 / 0）。
 * 新形式のカード表示は、補完した値を保持して shownStepPosition に渡す。
 */
export function visibleStepPosition(
  tour: Pick<TourDefinition, 'steps'>,
  index: number,
  conditions: GuideConditionValues,
): VisibleStepPosition {
  let position = 0;
  let total = 0;
  tour.steps.forEach((step, i) => {
    if (step.skipIf !== undefined && isConditionTrue(conditions, step.skipIf)) return;
    total += 1;
    if (i <= index) position += 1;
  });
  return { position: total === 0 ? 0 : Math.max(1, position), total };
}

function isValidShownCount(value: unknown, tour: Pick<TourDefinition, 'steps'>): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= tour.steps.length;
}

/** 保存された表示数を使い、旧保存値・不正値だけを現在の条件で補完する。 */
export function resolveShownCount(tour: Pick<TourDefinition, 'steps'>, index: number, conditions: GuideConditionValues, saved: unknown): number {
  return isValidShownCount(saved, tour) ? saved : visibleStepPosition(tour, index, conditions).position;
}

/** 通過済み手順を保持したカードの番号。後続だけを現在の条件で数える。 */
export function shownStepPosition(tour: Pick<TourDefinition, 'steps'>, index: number, conditions: GuideConditionValues, shownCount: number): VisibleStepPosition {
  const remaining = tour.steps.filter((step, i) => i > index &&
    (step.skipIf === undefined || !isConditionTrue(conditions, step.skipIf))).length;
  return { position: shownCount, total: shownCount + remaining };
}

/** 新しく表示する手順を記録する。開始時は previousCount を 0 にする。再表示・追従には使わない。 */
export function recordShownStep(progress: GuideProgress, tourId: GuideTourId, index: number, previousCount: number): GuideProgress {
  const next = startTour(progress, tourId, index);
  return { ...next, active: { ...next.active!, shownCount: previousCount + 1 } };
}

/** 再開時に越えた先を記録する。旧保存値・不正値は移動先の位置で補完し、加算しない。 */
export function recordResumedStep(progress: GuideProgress, tourId: GuideTourId, index: number, conditions: GuideConditionValues, savedCount: unknown): GuideProgress {
  const tour = GUIDE_TOURS[tourId];
  const shownCount = isValidShownCount(savedCount, tour)
    ? savedCount + 1 : visibleStepPosition(tour, index, conditions).position;
  const next = startTour(progress, tourId, index);
  return { ...next, active: { ...next.active!, shownCount } };
}

/** イベントでこの手順が進むか。'next' で進む手順はイベントでは進まない。 */
export function shouldAdvance(step: Pick<TourStep, 'advance'>, event: GuideEventName): boolean {
  return step.advance.type === 'events' && step.advance.events.includes(event);
}

export interface GuideSuggestContext {
  /** 今表示している画面。自動提案は Home（#/home）でだけ出す */
  screen: 'home' | 'other';
  /** このセッションで「あとで」を押したか（保存しない） */
  postponedThisSession?: boolean;
}

/**
 * 提案してよいツアー。利用不可の条件が渡された場合はそれも判定する。
 * まだ中身の無い枠（draft）は含めない。一覧・提案・開始・テストの照合の対象はすべてこの関数を通る。
 */
export function availableTours(
  tours: ReadonlyArray<TourDefinition> = Object.values(GUIDE_TOURS),
  conditions?: GuideConditionValues,
): TourDefinition[] {
  return tours.filter((tour) => {
    if (tour.draft) return false;
    if (conditions !== undefined && isTourUnavailable(tour, conditions)) return false;
    return true;
  });
}

/** 今の状態ではこのツアーを使えないか（unavailableIf が真）。ツアーが unavailableIf を持たなければ偽。 */
export function isTourUnavailable(tour: Pick<TourDefinition, 'unavailableIf'>, conditions: GuideConditionValues): boolean {
  return tour.unavailableIf !== undefined && isConditionTrue(conditions, tour.unavailableIf);
}

/** 自動提案を出すか。使えるツアーのどれも済・却下でなく、実行中でもなく、止められても延期されてもいないとき。 */
export function shouldSuggest(progress: GuideProgress, context: GuideSuggestContext): boolean {
  if (context.screen !== 'home') return false;
  if (progress.suppressSuggestions || context.postponedThisSession) return false;
  if (progress.active) return false;
  const tours = availableTours();
  if (tours.length === 0) return false;
  return tours.every((tour) => progress.tours[tour.id] === undefined);
}

/**
 * タブ・画面に入ったことを知らせるイベントで、提案の帯に出すツアー（無ければ null）。
 * suggestOn がそのイベントに一致する使えるツアーのうち、まだ済・却下でなく、ほかのツアーが実行中でなく、
 * 全体の「今後表示しない」でないときだけ返す。tours を渡すと、その中から選ぶ（テスト用。省略時は availableTours）。
 */
export function tourToSuggestOnEvent(
  progress: GuideProgress,
  event: GuideEventName,
  tours: ReadonlyArray<TourDefinition> = Object.values(GUIDE_TOURS),
  conditions?: GuideConditionValues,
): TourDefinition | null {
  if (progress.suppressSuggestions || progress.active) return null;
  return availableTours(tours, conditions).find(tour => tour.suggestOn === event && progress.tours[tour.id] === undefined) ?? null;
}

/** 別の画面から保存値が変わったと知らされたとき、この画面の表示がすべきこと。 */
export type ProgressSyncAction =
  | { type: 'none' }
  | { type: 'close' }
  | { type: 'switch'; stepIndex: number };

/**
 * 保存値を正として、複数の画面が同じツアーの同じ手順を表示するための判断（純関数）。
 * shown はこの画面で今表示しているツアーと手順（表示していなければ null）。
 * - 表示していない: 何もしない。
 * - 保存値の active が無い、または別のツアー: 片づける（別の画面でツアーが終わった・置き換わった）。
 * - active が自分のツアーで手順が違う: その手順に切り替える（保存はしない。保存し直すと通知が往復する）。
 * - 同じ: 何もしない。
 * 切り替え先がこの画面の条件で飛ばされる手順でも、保存値は変えず、そのまま表示する（対象が見えなければ待機表示になる）。
 */
export function decideProgressSync(
  active: GuideActiveTour | null,
  shown: { tourId: GuideTourId; stepIndex: number } | null,
): ProgressSyncAction {
  if (shown === null) return { type: 'none' };
  if (active === null || active.tourId !== shown.tourId) return { type: 'close' };
  if (active.stepIndex === shown.stepIndex) return { type: 'none' };
  return { type: 'switch', stepIndex: active.stepIndex };
}

function stepIdAt(tourId: GuideTourId, stepIndex: number): string {
  return GUIDE_TOURS[tourId].steps[stepIndex]?.id ?? '';
}

/** ツアーを始める（既に別のツアーが動いていれば置き換える。同時に走るのは1本だけ）。 */
export function startTour(progress: GuideProgress, tourId: GuideTourId, stepIndex = 0): GuideProgress {
  return { ...progress, active: { tourId, stepId: stepIdAt(tourId, stepIndex), stepIndex } };
}

/** 実行中のツアーの手順の位置を更新する。実行中でなければ何もしない。 */
export function setActiveStep(progress: GuideProgress, stepIndex: number): GuideProgress {
  if (!progress.active) return progress;
  return { ...progress, active: { ...progress.active, stepId: stepIdAt(progress.active.tourId, stepIndex), stepIndex } };
}

function endTour(
  progress: GuideProgress,
  tourId: GuideTourId,
  status: GuideTourRecord['status'],
  nowIso: string,
): GuideProgress {
  const active = progress.active && progress.active.tourId === tourId ? null : progress.active;
  return { ...progress, tours: { ...progress.tours, [tourId]: { status, at: nowIso } }, active };
}

/** 最後まで行った。 */
export function completeTour(progress: GuideProgress, tourId: GuideTourId, nowIso: string): GuideProgress {
  return endTour(progress, tourId, 'done', nowIso);
}

/** 「ツアーを終える」で途中で止めた。 */
export function dismissTour(progress: GuideProgress, tourId: GuideTourId, nowIso: string): GuideProgress {
  return endTour(progress, tourId, 'dismissed', nowIso);
}

/** 自動提案を「今後表示しない」にする。 */
export function suppressSuggestions(progress: GuideProgress): GuideProgress {
  return { ...progress, suppressSuggestions: true };
}
