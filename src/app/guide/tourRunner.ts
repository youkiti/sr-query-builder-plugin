import { t, type MessageKey } from '../../lib/i18n';
import { GUIDE_TOURS, type GuideTourId, type GuideEventName, type TourDefinition } from '../../lib/guide/tours';
import {
  completeTour, dismissTour, nextStepIndex, recordShownStep, recordResumedStep, decideProgressSync,
  isTourUnavailable, shouldAdvance, resolveShownCount, shownStepPosition, type GuideConditionValues,
} from '../../lib/guide/tourProgress';
import { getGuideProgress, subscribeGuideProgressChange, updateGuideProgress } from '../../lib/guide/guideProgressStore';
import { computeTourCardPosition, intersectsViewport } from './placement';
import { guideButton } from './suggestBand';
import { isSatisfiedByRoute } from './guideEvents';

export interface TourRunnerHost {
  computeConditions: () => GuideConditionValues;
  currentRoute: () => string;
  navigate: (hash: string) => void;
}

/** 保存値の読込後に生成する。stop は表示だけを片づけ、再開位置を保持する。 */
export function createTourRunner(host: TourRunnerHost, { doc, win }: { doc: Document; win: Window } = { doc: document, win: window }) {
  let running: { tour: TourDefinition; index: number; followed: boolean; shownCount: number } | null = null;
  let cleanup = (): void => {};

  function stop(): void { cleanup(); running = null; }

  function syncAvailability(): void {
    if (running && isTourUnavailable(running.tour, host.computeConditions())) stop();
  }

  function show(tour: TourDefinition, index: number, followed: boolean, focus = true, shownCount = resolveShownCount(tour, index, host.computeConditions(), getGuideProgress().active!.shownCount)): void {
    stop();
    running = { tour, index, followed, shownCount };
    const step = tour.steps[index]!;
    let needsScroll = focus;
    let scrollAttempts = 0;
    let scrollTimer: number | undefined;
    const card = doc.createElement('section');
    card.className = 'guide-tour-card';
    card.dataset.guideStep = step.id;
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', t(tour.titleKey as MessageKey));
    const title = doc.createElement('h2');
    title.textContent = t(tour.titleKey as MessageKey);
    const text = doc.createElement('p');
    text.textContent = t(step.textKey as MessageKey);
    const progress = doc.createElement('p');
    const waiting = doc.createElement('p');
    waiting.textContent = t('guide.waiting');
    waiting.setAttribute('role', 'status');
    const goRoute = guideButton(doc, 'go-route', t('guide.goRoute'), () => host.navigate(step.route!));
    const next = guideButton(doc, step.advance.type === 'next' ? 'next' : 'skip', '', advance);
    next.hidden = step.advance.type === 'events' && !step.advance.optional;
    const end = guideButton(doc, 'end', t('guide.end'), () => {
      updateGuideProgress(current => dismissTour(current, tour.id, new Date().toISOString()));
      stop();
    });
    card.append(title, text, progress, waiting, goRoute, next, end);
    const highlight = doc.createElement('div');
    highlight.className = 'guide-tour-highlight';
    const block = doc.createElement('div');
    block.className = 'guide-tour-block';
    doc.body.append(highlight, block, card);

    function findTarget(): HTMLElement | undefined {
      return Array.from(doc.querySelectorAll<HTMLElement>(`[data-tour="${step.target}"]`))
        .find(element => element.getClientRects().length > 0 && win.getComputedStyle(element).visibility !== 'hidden');
    }

    function reposition(): void {
      const viewport = { width: win.innerWidth, height: win.innerHeight };
      const target = findTarget();
      const rect = target?.getBoundingClientRect();
      const visible = rect !== undefined && intersectsViewport(rect, viewport);
      if (rect && needsScroll) {
        const fullyVisible = rect.top >= 0 && rect.bottom <= viewport.height && rect.left >= 0 && rect.right <= viewport.width;
        if ((scrollAttempts > 0 && visible) || (step.scroll === 'if-hidden' && fullyVisible)) {
          needsScroll = false;
          win.clearTimeout(scrollTimer);
          scrollTimer = undefined;
        } else if (scrollAttempts < 5 && scrollTimer === undefined) {
          // 再描画後の要素へスクロールし、成否は次の位置確認で判断する。
          scrollTimer = win.setTimeout(() => {
            scrollTimer = undefined;
            const current = findTarget();
            if (!current) return;
            const currentRect = current.getBoundingClientRect();
            scrollAttempts += 1;
            current.scrollIntoView({ block: step.scroll === 'start' || currentRect.height > win.innerHeight * 0.6 ? 'start' : 'center', inline: 'nearest' });
          }, 0);
        }
      }
      highlight.hidden = !visible;
      block.hidden = !visible || !step.blockTarget;
      waiting.hidden = visible;
      goRoute.hidden = visible || step.route === undefined || step.route === host.currentRoute();
      card.dataset.guideWaiting = String(!visible);
      if (visible) {
        for (const element of [highlight, block]) {
          Object.assign(element.style, { left: `${rect.left - 3}px`, top: `${rect.top - 3}px`, width: `${rect.width + 6}px`, height: `${rect.height + 6}px` });
        }
      }
      const conditions = host.computeConditions();
      const position = shownStepPosition(tour, index, conditions, shownCount);
      progress.textContent = `${position.position} / ${position.total}`;
      next.textContent = t(step.advance.type === 'events' ? 'guide.skip' : nextStepIndex(tour, index + 1, conditions) === null ? 'guide.complete' : 'guide.next');
      const point = computeTourCardPosition({ viewport, card: card.getBoundingClientRect(), target: visible ? rect : null, margin: 12, gap: 8, pad: 3 });
      card.style.left = `${point.left}px`;
      card.style.top = `${point.top}px`;
    }
    const observer = new MutationObserver(records => {
      if (records.some(record => ![card, highlight, block].some(element => element.contains(record.target)))) reposition();
    });
    observer.observe(doc.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'hidden', 'data-tour'] });
    const timer = win.setInterval(reposition, 400);
    win.addEventListener('resize', reposition);
    win.addEventListener('scroll', reposition, true);
    const onTargetClick = (event: MouseEvent): void => {
      if (isSatisfiedByRoute(step, host.currentRoute()) && event.target instanceof Element &&
          event.target.closest(`[data-tour="${step.target}"]`)) advance();
    };
    doc.addEventListener('click', onTargetClick);
    const blockTarget = (event: Event): void => {
      if (event instanceof KeyboardEvent && event.key !== 'Enter' && event.key !== ' ') return;
      // 暗黙のフォーム送信も、送信元ボタンが対象内の場合だけ遮断する。
      const source = event.type === 'submit' ? (event as SubmitEvent).submitter : event.target;
      if (source instanceof Element && source.closest(`[data-tour="${step.target}"]`)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    const blockedEvents = ['click', 'keydown', 'submit'] as const;
    if (step.blockTarget) {
      blockedEvents.forEach(type => doc.addEventListener(type, blockTarget, true));
    }
    const unsubscribe = subscribeGuideProgressChange(() => {
      const action = decideProgressSync(getGuideProgress().active, { tourId: tour.id, stepIndex: index });
      if (action.type === 'close') stop();
      else if (action.type === 'switch') show(tour, action.stepIndex, true);
      else {
        shownCount = resolveShownCount(tour, index, host.computeConditions(), getGuideProgress().active!.shownCount);
        running!.shownCount = shownCount;
        reposition();
      }
    });
    cleanup = () => {
      observer.disconnect();
      win.clearInterval(timer);
      win.clearTimeout(scrollTimer);
      win.removeEventListener('resize', reposition);
      win.removeEventListener('scroll', reposition, true);
      doc.removeEventListener('click', onTargetClick);
      if (step.blockTarget) {
        blockedEvents.forEach(type => doc.removeEventListener(type, blockTarget, true));
      }
      unsubscribe();
      card.remove(); highlight.remove(); block.remove();
    };
    reposition();
    if (focus) (next.hidden ? end : next).focus({ preventScroll: true });
  }

  function rerender(): void {
    if (running) show(running.tour, running.index, running.followed, false, running.shownCount);
  }

  function goTo(tour: TourDefinition, index: number | null, resuming = false): void {
    if (index === null) {
      updateGuideProgress(current => completeTour(current, tour.id, new Date().toISOString()));
      stop();
    } else {
      const active = getGuideProgress().active!;
      updateGuideProgress(current => resuming
        ? recordResumedStep(current, tour.id, index, host.computeConditions(), active.shownCount)
        : recordShownStep(current, tour.id, index, running!.shownCount));
      show(tour, index, false);
    }
  }
  function nextLocalStepIndex(tour: TourDefinition, from: number): number | null {
    const conditions = host.computeConditions();
    const route = host.currentRoute();
    let index = nextStepIndex(tour, from, conditions);
    while (index !== null && isSatisfiedByRoute(tour.steps[index]!, route)) {
      index = nextStepIndex(tour, index + 1, conditions);
    }
    return index;
  }
  function advance(): void {
    if (running) goTo(running.tour, nextLocalStepIndex(running.tour, running.index + 1));
  }
  function start(tourId: GuideTourId, fromStepId?: string): void {
    const tour = GUIDE_TOURS[tourId];
    if (tour.draft || isTourUnavailable(tour, host.computeConditions())) return;
    const from = fromStepId === undefined ? 0 : Math.max(0, tour.steps.findIndex(step => step.id === fromStepId));
    const index = nextLocalStepIndex(tour, from);
    if (index === null) { goTo(tour, index); return; }
    updateGuideProgress(current => recordShownStep(current, tourId, index, 0));
    show(tour, index, false);
  }
  function resume(): void {
    const active = getGuideProgress().active;
    if (!active || running) return;
    const tour = GUIDE_TOURS[active.tourId];
    if (tour.draft || isTourUnavailable(tour, host.computeConditions())) return;
    const index = nextLocalStepIndex(tour, active.stepIndex);
    if (index === active.stepIndex) show(tour, index, false);
    else goTo(tour, index, true);
  }
  function handleEvent(name: GuideEventName): void {
    if (!running) return;
    const { tour, index, followed } = running;
    if (shouldAdvance(tour.steps[index]!, name)) { advance(); return; }
    if (followed) return;
    const next = nextLocalStepIndex(tour, index);
    if (next !== index) goTo(tour, next);
  }
  return { start, resume, syncAvailability, handleEvent, stop, rerender };
}
