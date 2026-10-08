import { getUiLanguage, setUiLanguage, t, type MessageKey, type UiLanguage } from '../../lib/i18n';
import { saveUiLanguage } from '../../lib/i18n/uiLanguageStore';
import { availableTours, type GuideConditionValues } from '../../lib/guide/tourProgress';
import type { GuideTourId } from '../../lib/guide/tours';
import { getGuideProgress } from '../../lib/guide/guideProgressStore';
import { guideButton } from './suggestBand';

const LANGUAGES: ReadonlyArray<{ language: UiLanguage; labelKey: MessageKey }> = [
  { language: 'ja', labelKey: 'guide.languageJa' },
  { language: 'en', labelKey: 'guide.languageEn' },
];

export function createTourEntry(doc: Document, anchor: HTMLElement, conditions: () => GuideConditionValues, start: (id: GuideTourId) => void) {
  const panel = doc.createElement('section');
  panel.id = 'guide-tour-list';
  panel.className = 'guide-tour-list';
  panel.setAttribute('role', 'dialog');
  anchor.setAttribute('aria-controls', panel.id);
  anchor.setAttribute('aria-expanded', 'false');
  function close(): void {
    panel.remove();
    anchor.setAttribute('aria-expanded', 'false');
  }
  function createLanguageSwitch(): HTMLElement {
    const group = doc.createElement('div');
    group.className = 'guide-tour-list__language';
    const label = doc.createElement('p');
    label.textContent = t('guide.language');
    group.append(label);
    for (const { language, labelKey } of LANGUAGES) {
      const button = guideButton(doc, 'language', t(labelKey), () => {
        setUiLanguage(language);
        void saveUiLanguage(language);
        refresh();
        panel.querySelector<HTMLButtonElement>(`[data-guide-language="${language}"]`)?.focus();
      });
      button.dataset.guideLanguage = language;
      button.setAttribute('aria-pressed', String(getUiLanguage() === language));
      group.append(button);
    }
    return group;
  }
  function buttonKey(button: Element): string {
    const { guideAction = '', guideTour = '', guideLanguage = '' } = (button as HTMLElement).dataset;
    return `${guideAction}|${guideTour}|${guideLanguage}`;
  }
  /** 差し替えでフォーカス中のボタンが失われないよう、パネル内にフォーカスがあったときだけ同じボタンへ戻す。 */
  function refresh(): void {
    const focused = panel.isConnected && panel.contains(doc.activeElement) ? buttonKey(doc.activeElement!) : null;
    rebuild();
    if (focused !== null) {
      Array.from(panel.querySelectorAll<HTMLButtonElement>('button')).find(button => buttonKey(button) === focused)?.focus();
    }
  }
  function rebuild(): void {
    panel.setAttribute('aria-label', t('guide.openTours'));
    panel.replaceChildren(guideButton(doc, 'close-list', t('guide.closeList'), () => { close(); anchor.focus(); }));
    for (const tour of availableTours(undefined, conditions())) {
      const title = doc.createElement('h2');
      title.textContent = t(tour.titleKey as MessageKey);
      if (getGuideProgress().tours[tour.id]?.status === 'done') title.append(` — ${t('guide.done')}`);
      const description = doc.createElement('p');
      description.textContent = t(tour.descriptionKey as MessageKey);
      const button = guideButton(doc, 'start', t('guide.start'), () => { close(); start(tour.id); });
      button.dataset.guideTour = tour.id;
      panel.append(title, description, button);
    }
    panel.append(createLanguageSwitch());
  }
  function toggle(): void {
    if (panel.isConnected) { close(); return; }
    rebuild();
    doc.body.append(panel);
    anchor.setAttribute('aria-expanded', 'true');
    panel.querySelector<HTMLButtonElement>('button')!.focus();
  }
  function outside(event: MouseEvent): void {
    // 言語切替で一覧の中身が差し替わると、押したボタンは文書から外れる。外れた後でも判定できるよう経路で見る。
    const path = event.composedPath();
    if (!path.includes(panel) && !path.includes(anchor)) close();
  }
  function escape(event: KeyboardEvent): void {
    if (event.key === 'Escape' && panel.isConnected) { close(); anchor.focus(); }
  }
  anchor.addEventListener('click', toggle);
  doc.addEventListener('click', outside);
  doc.addEventListener('keydown', escape);
  return { refresh, open(): void {
    if (!panel.isConnected) toggle();
  }, destroy(): void {
    close();
    anchor.removeEventListener('click', toggle);
    doc.removeEventListener('click', outside);
    doc.removeEventListener('keydown', escape);
  } };
}
