import { getUiLanguage, t } from '../../lib/i18n';
import { availableTours, type GuideConditionValues } from '../../lib/guide/tourProgress';
import type { GuideTourId } from '../../lib/guide/tours';
import { GUIDE_TOPICS, buildHelpUrl, buildVideoUrl, isGuideTopicId, type GuideTopicId } from '../../lib/guide/topics';
import { HELP_BUTTON_CLASS, topicTitle } from './helpButton';
import { computeTourCardPosition } from './placement';

export interface HelpMenuHost {
  conditions: () => GuideConditionValues;
  start: (id: GuideTourId) => void;
  openTourList: () => void;
}

const MENU_CLASS = 'guide-help-menu';
const MARGIN = 12;
const GAP = 4;

/**
 * 「?」ボタンから開く小さなメニュー。document への委譲クリックでボタンを拾うので、
 * ボタンが後から差し込まれても、描き直されても動く。
 */
export function createHelpMenu(doc: Document, host: HelpMenuHost) {
  const menu = doc.createElement('section');
  menu.className = MENU_CLASS;
  menu.setAttribute('role', 'dialog');
  let activeButton: HTMLElement | null = null;
  let openedTopic: string | undefined;

  function activeTopic(): GuideTopicId | null {
    const topic = activeButton?.dataset.help;
    return isGuideTopicId(topic) ? topic : null;
  }
  function isOpen(): boolean {
    return menu.isConnected;
  }
  function close(): void {
    activeButton?.setAttribute('aria-expanded', 'false');
    activeButton = null;
    menu.remove();
  }
  function closeAndFocusButton(): void {
    const button = activeButton;
    close();
    button?.focus();
  }
  function link(label: string, href: string): HTMLAnchorElement {
    const anchor = doc.createElement('a');
    anchor.href = href;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.textContent = label;
    anchor.addEventListener('click', () => close());
    return anchor;
  }
  function action(name: string, label: string, run: () => void): HTMLButtonElement {
    const button = doc.createElement('button');
    button.type = 'button';
    button.dataset.helpAction = name;
    button.textContent = label;
    button.addEventListener('click', event => {
      // 開いた先（ツアーの一覧など）が、この同じクリックを「外側のクリック」と受け取って閉じないようにする。
      event.stopPropagation();
      close();
      run();
    });
    return button;
  }
  function position(): void {
    if (!activeButton) return;
    const view = doc.defaultView;
    const rect = activeButton.getBoundingClientRect();
    const box = menu.getBoundingClientRect();
    const point = computeTourCardPosition({
      viewport: { width: view?.innerWidth ?? 0, height: view?.innerHeight ?? 0 },
      card: { width: box.width, height: box.height },
      target: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
      margin: MARGIN, gap: GAP, pad: 0,
    });
    menu.style.left = `${point.left}px`;
    menu.style.top = `${point.top}px`;
  }
  /** 現在のトピック・言語・使えるツアーでメニューの中身を組み直す。フォーカス中の項目は同じ項目へ戻す。 */
  function rebuild(): void {
    const topicId = activeTopic();
    if (!topicId) return;
    const topic = GUIDE_TOPICS[topicId];
    const focused = menu.contains(doc.activeElement) ? (doc.activeElement as HTMLElement).dataset.helpAction ?? null : null;
    menu.setAttribute('aria-label', topicTitle(topicId));
    const items: HTMLElement[] = [];
    const read = link(t('guide.menuReadHelp'), buildHelpUrl(topicId, getUiLanguage()));
    read.dataset.helpAction = 'read';
    items.push(read);
    if (topic.video) {
      const video = link(t('guide.menuWatchVideo'), buildVideoUrl(topic.video));
      video.dataset.helpAction = 'video';
      items.push(video);
    }
    const tourId = topic.tourId;
    if (tourId && availableTours(undefined, host.conditions()).some(tour => tour.id === tourId)) {
      items.push(action('start-tour', t('guide.menuStartTour'), () => host.start(tourId)));
    }
    items.push(action('tour-list', t('guide.menuTourList'), () => host.openTourList()));
    menu.replaceChildren(...items);
    if (focused !== null) items.find(item => item.dataset.helpAction === focused)?.focus();
  }
  function open(button: HTMLElement): void {
    activeButton?.setAttribute('aria-expanded', 'false');
    activeButton = button;
    openedTopic = button.dataset.help;
    button.setAttribute('aria-expanded', 'true');
    rebuild();
    if (!isOpen()) doc.body.append(menu);
    position();
    (menu.firstElementChild as HTMLElement | null)?.focus();
  }
  function onClick(event: MouseEvent): void {
    const path = event.composedPath();
    const button = path.find((node): node is HTMLElement => node instanceof HTMLElement && node.classList.contains(HELP_BUTTON_CLASS));
    if (button) {
      if (!isGuideTopicId(button.dataset.help)) return;
      if (isOpen() && activeButton === button) close();
      else open(button);
      return;
    }
    if (isOpen() && !path.includes(menu)) close();
  }
  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && isOpen()) closeAndFocusButton();
  }
  const view = doc.defaultView;
  const reposition = (): void => { if (isOpen()) position(); };
  doc.addEventListener('click', onClick);
  doc.addEventListener('keydown', onKeydown);
  view?.addEventListener('resize', reposition);
  view?.addEventListener('scroll', reposition, true);
  return {
    /**
     * 開いている間だけ、文面と項目を作り直す。開いたときのボタンが文書から外れていたら、
     * 同じトピックの「?」を探して付け替える（画面の描き直しでボタンが作り直されても閉じない）。
     * 見つからないときは closeIfMissing が true の場合だけ閉じる。ボタンを差し直す前に呼ぶ側は false にする。
     */
    refresh(closeIfMissing = true): void {
      if (!isOpen()) return;
      if (!activeButton?.isConnected) {
        const topic = activeButton?.dataset.help;
        const next = topic ? doc.querySelector<HTMLElement>(`.${HELP_BUTTON_CLASS}[data-help="${topic}"]`) : null;
        if (!next) {
          if (closeIfMissing) close();
          return;
        }
        activeButton = next;
        next.setAttribute('aria-expanded', 'true');
      }
      // 同じ要素のままトピックが替わった（ルートが変わった）ときは、開いたメニューの対象ではなくなるので閉じる。
      if (!activeTopic() || activeButton.dataset.help !== openedTopic) { if (closeIfMissing) close(); return; }
      rebuild();
      position();
    },
    close,
    destroy(): void {
      close();
      doc.removeEventListener('click', onClick);
      doc.removeEventListener('keydown', onKeydown);
      view?.removeEventListener('resize', reposition);
      view?.removeEventListener('scroll', reposition, true);
    },
  };
}
