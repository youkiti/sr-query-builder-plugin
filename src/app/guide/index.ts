import { availableTours, hasRemainingSteps, shouldSuggest, suppressSuggestions } from '../../lib/guide/tourProgress';
import type { GuideTourId } from '../../lib/guide/tours';
import {
  getGuideProgress, isGuidePostponed, loadGuideProgress, postponeGuideSuggestions,
  subscribeGuideProgressChange, updateGuideProgress,
} from '../../lib/guide/guideProgressStore';
import { onUiLanguageChange, setUiLanguage, t } from '../../lib/i18n';
import { loadUiLanguage } from '../../lib/i18n/uiLanguageStore';
import { parseRoute, type RouteName } from '../router';
import type { AppStore } from '../store';
import { computeGuideConditions } from './tourConditions';
import { createTourRunner } from './tourRunner';
import { createTourEntry } from './tourEntry';
import { mountHelpButtons } from './helpButton';
import { createHelpMenu } from './helpMenu';
import { topicForRoute } from '../../lib/guide/topics';
import { createSuggestBand } from './suggestBand';
import { guideEvents, routeGuideEvent } from './guideEvents';

export interface GuideInitOptions {
  store: AppStore;
  win: Window;
  doc: Document;
  /** 前提条件のガードを通る画面遷移（startApp の navigate） */
  navigate: (route: RouteName) => void;
  getHash: () => string;
  onHashChange: (listener: () => void) => () => void;
}

/**
 * ヘルプツアーを起動する。入口のボタン（#app-open-tours）または表示領域（#app-content）が
 * 無い文書では何もせず、後始末は空の関数を返す。戻り値は購読・表示を片づける関数。
 */
export async function initGuide({ store, win, doc, navigate, getHash, onHashChange }: GuideInitOptions): Promise<() => void> {
  const anchor = doc.getElementById('app-open-tours');
  const content = doc.getElementById('app-content');
  if (!anchor || !content) return () => {};
  await Promise.all([loadGuideProgress(), loadUiLanguage().then(setUiLanguage)]);
  const conditions = (): ReturnType<typeof computeGuideConditions> => computeGuideConditions(store.getState());
  const currentRoute = (): `#/${RouteName}` => `#/${parseRoute(getHash())}`;
  const runner = createTourRunner({
    computeConditions: conditions,
    currentRoute,
    navigate: hash => navigate(parseRoute(hash)),
  }, { doc, win });
  function start(id: GuideTourId): void {
    runner.start(id);
    refresh();
  }
  const entry = createTourEntry(doc, anchor, conditions, start);
  const helpMenu = createHelpMenu(doc, { conditions, start, openTourList: () => entry.open() });
  /** 見出しの横の「?」を現在のルートのトピックで差し直し、開いているメニューを追従させる。 */
  function mountHelp(): void {
    mountHelpButtons(content!, topicForRoute(parseRoute(getHash())));
    helpMenu.refresh();
  }
  let helpFrame: number | null = null;
  /** 描き直しのたびに走らせず、1 フレームに 1 回へ間引く（自分の挿入では結果が変わらず、再び回らない）。 */
  function scheduleMountHelp(): void {
    if (helpFrame !== null) return;
    helpFrame = win.requestAnimationFrame(() => { helpFrame = null; mountHelp(); });
  }
  function labelAnchor(): void {
    anchor!.textContent = t('guide.openTours');
  }
  function refresh(): void {
    const existing = doc.getElementById('guide-suggest-band');
    const currentConditions = conditions();
    const tour = availableTours(undefined, currentConditions).find(item => item.id === 'getting-started');
    const suggest = tour && hasRemainingSteps(tour, currentConditions) && shouldSuggest(getGuideProgress(), {
      screen: currentRoute() === '#/home' ? 'home' : 'other', postponedThisSession: isGuidePostponed(),
    });
    if (!suggest) { existing?.remove(); return; }
    if (existing) return;
    content!.prepend(createSuggestBand(doc, {
      start: () => start(tour.id),
      postpone: () => { postponeGuideSuggestions(); refresh(); },
      suppress: () => { updateGuideProgress(suppressSuggestions); refresh(); },
    }));
  }
  let previous = conditions();
  let route = currentRoute();
  const onRoute = (): void => {
    const next = currentRoute();
    if (route !== next) { route = next; runner.handleEvent(routeGuideEvent(next)); }
    refresh();
    mountHelp();
  };
  const cleanups: Array<() => void> = [() => runner.stop(), () => entry.destroy(), () => helpMenu.destroy()];
  const dispose = (): void => {
    cleanups.splice(0).reverse().forEach(cleanup => cleanup());
  };
  try {
    labelAnchor();
    const unsubscribeStore = store.subscribe(() => {
      const next = conditions();
      const events = guideEvents(previous, next);
      previous = next;
      runner.syncAvailability();
      events.forEach(event => runner.handleEvent(event));
      runner.resume();
      entry.refresh();
      refresh();
      helpMenu.refresh(false);
    });
    cleanups.push(unsubscribeStore);
    cleanups.push(onHashChange(onRoute));
    const unsubscribeProgress = subscribeGuideProgressChange(() => { entry.refresh(); refresh(); });
    cleanups.push(unsubscribeProgress);
    cleanups.push(onUiLanguageChange(() => {
      labelAnchor();
      runner.rerender();
      doc.getElementById('guide-suggest-band')?.remove();
      refresh();
      entry.refresh();
      mountHelp();
    }));
    // ルートの再描画で表示領域の中身が差し替わっても、提案帯と「?」を戻す。自分の挿入では重複させない。
    // ビューが入れ子の要素ごと見出しを描き直しても取りこぼさないよう、子孫まで見る。
    const observer = new MutationObserver(() => { refresh(); scheduleMountHelp(); });
    cleanups.push(() => observer.disconnect());
    cleanups.push(() => { if (helpFrame !== null) win.cancelAnimationFrame(helpFrame); helpFrame = null; });
    observer.observe(content, { childList: true, subtree: true });
    win.addEventListener('pagehide', dispose);
    cleanups.push(() => win.removeEventListener('pagehide', dispose));
    runner.resume();
    refresh();
    mountHelp();
  } catch (error) {
    dispose();
    throw error;
  }
  return dispose;
}
