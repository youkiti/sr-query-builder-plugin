import { createTourEntry } from './tourEntry';
import { createSuggestBand } from './suggestBand';
import { createEmptyGuideProgress, completeTour } from '../../lib/guide/tourProgress';
import * as storage from '../../lib/guide/guideProgressStore';
import { getUiLanguage, setUiLanguage } from '../../lib/i18n';
import { UI_LANGUAGE_STORAGE_KEY } from '../../lib/i18n/uiLanguageStore';

import { useTestTours } from '../../../tests/fixtures/guideTours';

useTestTours([{
  id: 'getting-started', titleKey: 'guide.tourGettingStartedTitle', descriptionKey: 'guide.tourGettingStartedDesc',
  unavailableIf: 'has-protocol',
  steps: [{ id: 'finish', target: 'tour-list', textKey: 'guide.tourGettingStartedStepFinish', advance: { type: 'next' } }],
}]);

afterEach(() => { setUiLanguage('ja'); jest.restoreAllMocks(); });

const panel = (): HTMLElement | null => document.getElementById('guide-tour-list');

test('提案帯は三つの操作を配線する', () => {
  const actions = { start: jest.fn(), postpone: jest.fn(), suppress: jest.fn() };
  const band = createSuggestBand(document, actions);
  expect(band.id).toBe('guide-suggest-band');
  expect(Array.from(band.querySelectorAll('button')).map(button => button.textContent)).toEqual(['ツアーで進める', 'あとで', '今後表示しない']);
  for (const name of ['start', 'postpone', 'suppress'] as const) {
    band.querySelector<HTMLButtonElement>(`[data-guide-action="${name}"]`)!.click();
    expect(actions[name]).toHaveBeenCalledTimes(1);
  }
});

test('一覧の開閉、外側、Esc、開始、済み、利用条件', () => {
  const progress = jest.spyOn(storage, 'getGuideProgress').mockReturnValue(createEmptyGuideProgress());
  document.body.innerHTML = '<button id="anchor">ツアー</button><p>外</p>';
  const anchor = document.getElementById('anchor')!;
  let unavailable = false;
  const start = jest.fn();
  const entry = createTourEntry(document, anchor, () => ({ 'has-protocol': unavailable }), start);
  anchor.click(); expect(panel()).not.toBeNull(); expect(anchor.getAttribute('aria-expanded')).toBe('true');
  expect(anchor.getAttribute('aria-controls')).toBe('guide-tour-list');
  expect(panel()!.getAttribute('aria-label')).toBe('ツアー');
  expect(document.activeElement).toBe(panel()!.querySelector('[data-guide-action="close-list"]'));
  panel()!.click(); expect(panel()).not.toBeNull();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' })); expect(panel()).not.toBeNull();
  anchor.click(); expect(panel()).toBeNull();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  anchor.click(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  expect(document.activeElement).toBe(anchor); expect(panel()).toBeNull();
  anchor.click(); document.querySelector('p')!.click(); expect(panel()).toBeNull();
  anchor.click(); panel()!.querySelector<HTMLButtonElement>('[data-guide-action="close-list"]')!.click(); expect(panel()).toBeNull();
  progress.mockReturnValue(completeTour(createEmptyGuideProgress(), 'getting-started', 'now'));
  anchor.click(); expect(panel()!.textContent).toContain('済み');
  panel()!.querySelector<HTMLButtonElement>('[data-guide-action="start"]')!.click();
  expect(start).toHaveBeenCalledWith('getting-started'); expect(panel()).toBeNull();
  unavailable = true; anchor.click(); expect(panel()!.querySelector('[data-guide-action="start"]')).toBeNull();
  unavailable = false; entry.refresh(); expect(panel()!.querySelector('[data-guide-action="start"]')).not.toBeNull();
  progress.mockReturnValue({ ...createEmptyGuideProgress(), tours: { 'getting-started': { status: 'dismissed', at: 'now' } } });
  entry.refresh(); expect(panel()!.textContent).not.toContain('済み');
  entry.destroy(); anchor.click(); expect(panel()).toBeNull();
});

test('一覧の末尾に表示言語の切り替えがあり、押すと言語が変わり保存され、一覧は開いたまま現在の言語を示す', () => {
  const set = jest.fn(async () => undefined);
  const root = globalThis as unknown as { chrome: { storage: { local: { set: unknown } } } };
  const saved = root.chrome.storage.local.set;
  root.chrome.storage.local.set = set;
  jest.spyOn(storage, 'getGuideProgress').mockReturnValue(createEmptyGuideProgress());
  document.body.innerHTML = '<button id="anchor">ツアー</button>';
  const anchor = document.getElementById('anchor')!;
  const entry = createTourEntry(document, anchor, () => ({}), jest.fn());
  try {
    anchor.click();
    const buttons = (): HTMLButtonElement[] => Array.from(panel()!.querySelectorAll<HTMLButtonElement>('[data-guide-action="language"]'));
    expect(panel()!.lastElementChild!.contains(buttons()[0]!)).toBe(true);
    expect(buttons().map(button => [button.textContent, button.getAttribute('aria-pressed')])).toEqual([['日本語', 'true'], ['English', 'false']]);
    buttons()[1]!.click();
    expect(getUiLanguage()).toBe('en');
    expect(set).toHaveBeenCalledWith({ [UI_LANGUAGE_STORAGE_KEY]: 'en' });
    expect(panel()).not.toBeNull();
    expect(anchor.getAttribute('aria-expanded')).toBe('true');
    expect(panel()!.querySelector('h2')!.textContent).toBe('Getting started');
    expect(panel()!.querySelector('[data-guide-action="start"]')!.textContent).toBe('Start');
    expect(panel()!.querySelector('[data-guide-action="close-list"]')!.textContent).toBe('Close list');
    expect(buttons().map(button => button.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
    expect(document.activeElement).toBe(buttons()[1]);
    buttons()[0]!.click();
    expect(getUiLanguage()).toBe('ja');
    expect(panel()!.querySelector('h2')!.textContent).toBe('はじめての流れ');
  } finally {
    entry.destroy();
    root.chrome.storage.local.set = saved;
  }
});
