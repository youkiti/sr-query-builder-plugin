import { initGuide } from './index';
import { createStore, INITIAL_STATE, type AppStore, type AppState } from '../store';
import { createEmptyGuideProgress, startTour, type GuideProgress } from '../../lib/guide/tourProgress';
import { GUIDE_TOURS } from '../../lib/guide/tours';
import * as storage from '../../lib/guide/guideProgressStore';
import * as languageStore from '../../lib/i18n/uiLanguageStore';
import { createTourRunner } from './tourRunner';
import { getUiLanguage, setUiLanguage, t } from '../../lib/i18n';
import type { RouteName } from '../router';

import { useTestTours } from '../../../tests/fixtures/guideTours';

useTestTours([GUIDE_TOURS['getting-started']]);

jest.mock('../../lib/guide/guideProgressStore');
jest.mock('../../lib/i18n/uiLanguageStore');
jest.mock('./tourRunner');
const project = { projectId: 'p', spreadsheetId: 's', driveFolderId: 'd', title: 't' };
let store: AppStore;
let progress: GuideProgress;
let postponed: boolean;
let listeners: Set<() => void>;
let hash: string;
let hashListeners: Set<() => void>;
const navigate = jest.fn();
const runner = { start: jest.fn(), resume: jest.fn(), syncAvailability: jest.fn(), stop: jest.fn(), handleEvent: jest.fn(), rerender: jest.fn() };
const band = (): HTMLElement | null => document.getElementById('guide-suggest-band');
const click = (name: string): void => document.querySelector<HTMLButtonElement>(`#guide-suggest-band [data-guide-action="${name}"]`)!.click();
const touch = (patch: Partial<AppState> = {}): void => store.setState(state => ({ ...state, ...patch }));
const run = (): ReturnType<typeof initGuide> => initGuide({
  store, win: window, doc: document, navigate,
  getHash: () => hash,
  onHashChange: listener => { hashListeners.add(listener); return () => { hashListeners.delete(listener); }; },
});
const go = (next: string): void => { hash = next; hashListeners.forEach(listener => listener()); };

beforeEach(() => {
  document.body.innerHTML = '<button id="app-open-tours">ツアー</button><main id="app-content"></main>';
  hash = '#/home'; hashListeners = new Set(); navigate.mockClear();
  store = createStore({ ...INITIAL_STATE, project });
  progress = createEmptyGuideProgress(); postponed = false; listeners = new Set();
  Object.values(runner).forEach(fn => fn.mockReset());
  jest.mocked(languageStore.loadUiLanguage).mockResolvedValue('ja');
  jest.mocked(languageStore.saveUiLanguage).mockResolvedValue(undefined);
  jest.mocked(storage.loadGuideProgress).mockImplementation(async () => progress);
  jest.mocked(storage.getGuideProgress).mockImplementation(() => progress);
  jest.mocked(storage.updateGuideProgress).mockImplementation(update => { progress = update(progress); });
  jest.mocked(storage.isGuidePostponed).mockImplementation(() => postponed);
  jest.mocked(storage.postponeGuideSuggestions).mockImplementation(() => { postponed = true; });
  jest.mocked(storage.subscribeGuideProgressChange).mockImplementation(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; });
  jest.mocked(createTourRunner).mockReset().mockReturnValue(runner);
  runner.start.mockImplementation(() => { progress = startTour(progress, 'getting-started'); });
});
afterEach(() => { window.dispatchEvent(new Event('pagehide')); setUiLanguage('ja'); });

test('入口のボタンまたは表示領域が無い文書では何もしない', async () => {
  document.getElementById('app-open-tours')!.remove();
  const dispose = await run();
  expect(createTourRunner).not.toHaveBeenCalled();
  expect(dispose()).toBeUndefined();
  document.body.innerHTML = '<button id="app-open-tours"></button>';
  await run();
  expect(createTourRunner).not.toHaveBeenCalled();
});

test('進捗の読み込みが済めば待たずに、保存済みの手順を再開し、入口のボタンへ辞書の文字を入れる', async () => {
  progress = startTour(progress, 'getting-started');
  document.getElementById('app-open-tours')!.textContent = '';
  await run();
  expect(runner.resume).toHaveBeenCalledTimes(1);
  expect(document.getElementById('app-open-tours')!.textContent).toBe('ツアー');
  touch();
  expect(runner.resume).toHaveBeenCalledTimes(2);
});

test('保存された表示言語を読み込んで反映する', async () => {
  jest.mocked(languageStore.loadUiLanguage).mockResolvedValue('en');
  await run();
  expect(getUiLanguage()).toBe('en');
  expect(document.getElementById('app-open-tours')!.textContent).toBe('Tours');
  expect(band()?.querySelector('[data-guide-action="start"]')?.textContent).toBe('Take the tour');
});

test('#/home で未完了・未抑止なら提案帯を出し、自動では開始しない', async () => {
  await run();
  expect(band()).not.toBeNull();
  expect(runner.start).not.toHaveBeenCalled();
  expect(Array.from(band()!.querySelectorAll('button')).map(button => button.textContent)).toEqual(['ツアーで進める', 'あとで', '今後表示しない']);
});

test('#/home 以外では提案しない。#/home に入ると出て、離れると消える', async () => {
  hash = '#/blocks';
  await run();
  expect(band()).toBeNull();
  go('#/home');
  expect(band()).not.toBeNull();
  go('#/seeds');
  expect(band()).toBeNull();
});

test.each([
  ['実行中', () => startTour(createEmptyGuideProgress(), 'getting-started')],
  ['完了済み', () => ({ ...createEmptyGuideProgress(), tours: { 'getting-started': { status: 'done' as const, at: 'now' } } })],
  ['却下済み', () => ({ ...createEmptyGuideProgress(), tours: { 'getting-started': { status: 'dismissed' as const, at: 'now' } } })],
  ['今後表示しない', () => ({ ...createEmptyGuideProgress(), suppressSuggestions: true })],
])('%s なら提案帯を出さない', async (_name, make) => {
  progress = make();
  await run();
  expect(band()).toBeNull();
});

test('提案帯の再挿入、ツアーで進める、あとで、今後表示しない、他タブ変更', async () => {
  await run();
  document.getElementById('app-content')!.replaceChildren(); await Promise.resolve();
  expect(band()).not.toBeNull();
  expect(document.querySelectorAll('#guide-suggest-band')).toHaveLength(1);
  click('postpone'); expect(band()).toBeNull();
  expect(postponed).toBe(true);
  touch(); expect(band()).toBeNull();
  postponed = false; touch(); expect(band()).not.toBeNull();
  click('suppress');
  expect(progress.suppressSuggestions).toBe(true); expect(band()).toBeNull();
  progress = { ...progress, suppressSuggestions: false }; listeners.forEach(listener => listener()); expect(band()).not.toBeNull();
  click('start'); expect(runner.start).toHaveBeenCalledWith('getting-started'); expect(band()).toBeNull();
  touch(); expect(band()).toBeNull();
});

test('一覧から開始できる', async () => {
  await run();
  document.getElementById('app-open-tours')!.click();
  document.querySelector<HTMLButtonElement>('#guide-tour-list [data-guide-action="start"]')!.click();
  expect(runner.start).toHaveBeenCalledWith('getting-started');
  expect(band()).toBeNull();
});

test('実行部へ条件・現在のルート・ガード付きの遷移を渡す', async () => {
  await run();
  const host = jest.mocked(createTourRunner).mock.calls[0]![0];
  expect(host.computeConditions()).toMatchObject({ 'has-project': true, 'has-protocol': false });
  expect(host.currentRoute()).toBe('#/home');
  host.navigate('#/protocol');
  expect(navigate).toHaveBeenCalledWith('protocol' satisfies RouteName);
  hash = '';
  expect(host.currentRoute()).toBe('#/protocol');
});

test('画面を開いたときと、状態が変わるたびに、利用条件の確認と再開を実行部へ伝える', async () => {
  await run();
  go('#/protocol'); go('#/protocol');
  expect(runner.handleEvent).toHaveBeenCalledTimes(1);
  expect(runner.handleEvent).toHaveBeenCalledWith('route-opened-protocol');
  runner.syncAvailability.mockClear();
  touch({ project: null });
  expect(runner.syncAvailability).toHaveBeenCalledTimes(1);
});

test('言語変更でボタン・カードの再描画・提案帯・開いている一覧を更新し、保存値は書き換えない', async () => {
  await run();
  document.getElementById('app-open-tours')!.click();
  const saved = JSON.parse(JSON.stringify(progress)) as GuideProgress;
  const writes = jest.mocked(storage.updateGuideProgress); writes.mockClear();
  setUiLanguage('en');
  expect(runner.rerender).toHaveBeenCalledTimes(1);
  expect(document.getElementById('app-open-tours')!.textContent).toBe('Tours');
  expect(band()?.querySelector('p')?.textContent).toBe(t('guide.suggest'));
  expect(band()?.querySelector('[data-guide-action="start"]')?.textContent).toBe('Take the tour');
  expect(document.querySelector('#guide-tour-list h2')?.textContent).toBe('Getting started');
  expect(document.querySelector('#guide-tour-list [data-guide-action="close-list"]')?.textContent).toBe('Close list');
  expect(progress).toEqual(saved); expect(writes).not.toHaveBeenCalled();
  click('postpone'); setUiLanguage('ja');
  expect(band()).toBeNull();
});

test('後始末で購読・表示を片づけ、以後は何も反応しない', async () => {
  const dispose = await run();
  document.getElementById('app-open-tours')!.click();
  dispose();
  expect(runner.stop).toHaveBeenCalledTimes(1);
  expect(listeners.size).toBe(0);
  expect(hashListeners.size).toBe(0);
  expect(document.getElementById('guide-tour-list')).toBeNull();
  runner.rerender.mockClear();
  setUiLanguage('en');
  expect(runner.rerender).not.toHaveBeenCalled();
  runner.resume.mockClear();
  touch({ project: null });
  go('#/seeds');
  window.dispatchEvent(new Event('pagehide'));
  expect(runner.resume).not.toHaveBeenCalled();
  expect(runner.handleEvent).not.toHaveBeenCalled();
  expect(runner.stop).toHaveBeenCalledTimes(1);
  document.getElementById('app-open-tours')!.click();
  expect(document.getElementById('guide-tour-list')).toBeNull();
});

test('pagehide でも後始末する', async () => {
  await run();
  window.dispatchEvent(new Event('pagehide'));
  expect(runner.stop).toHaveBeenCalledTimes(1);
  expect(hashListeners.size).toBe(0);
});

test.each(['store', 'hashchange', 'progress', 'observer', 'pagehide'] as const)('初期化の %s で失敗したら、それまでの購読をすべて解除して例外を返す', async stage => {
  const error = new Error('初期化失敗');
  const subscribe = store.subscribe.bind(store);
  const unsubscribe = jest.fn();
  jest.spyOn(store, 'subscribe').mockImplementation(listener => {
    if (stage === 'store') throw error;
    const remove = subscribe(listener);
    return () => { unsubscribe(); remove(); };
  });
  const add = window.addEventListener.bind(window);
  jest.spyOn(window, 'addEventListener').mockImplementation((name: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
    if (name === stage) throw error;
    add(name, listener, options);
  });
  const observeSpy = jest.spyOn(MutationObserver.prototype, 'observe');
  const disconnectSpy = jest.spyOn(MutationObserver.prototype, 'disconnect');
  if (stage === 'progress') jest.mocked(storage.subscribeGuideProgressChange).mockImplementationOnce(() => { throw error; });
  if (stage === 'observer') observeSpy.mockImplementationOnce(() => { throw error; });
  try {
    const failing = stage === 'hashchange'
      ? initGuide({ store, win: window, doc: document, navigate, getHash: () => hash, onHashChange: () => { throw error; } })
      : run();
    await expect(failing).rejects.toBe(error);
    expect(unsubscribe).toHaveBeenCalledTimes(stage === 'store' ? 0 : 1);
    expect(listeners.size).toBe(0);
    if (stage === 'observer' || stage === 'pagehide') expect(disconnectSpy).toHaveBeenCalledTimes(1);
    expect(runner.stop).toHaveBeenCalledTimes(1);
    expect(runner.resume).not.toHaveBeenCalled();
    runner.handleEvent.mockClear();
    touch({ project: null });
    window.dispatchEvent(new Event('pagehide'));
    document.getElementById('app-open-tours')!.click();
    await Promise.resolve();
    expect(runner.handleEvent).not.toHaveBeenCalled();
    expect(runner.resume).not.toHaveBeenCalled();
    expect(runner.stop).toHaveBeenCalledTimes(1);
    expect(document.getElementById('guide-tour-list')).toBeNull();
    expect(band()).toBeNull();
  } finally {
    jest.restoreAllMocks();
  }
});

describe('見出しの「?」とメニュー', () => {
  const content = (): HTMLElement => document.getElementById('app-content')!;
  const helpButtons = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('#app-content .guide-help-btn'));
  const nextFrame = (): Promise<void> => new Promise(resolve => { window.requestAnimationFrame(() => resolve()); });
  const render = (html: string): void => { content().innerHTML = html; };

  test('初期化時に最初の h2 へ 1 つ差し、見出しの文字は変えない', async () => {
    render('<h2>ホーム</h2><h2>二つ目</h2>');
    await run();
    expect(helpButtons()).toHaveLength(1);
    expect(helpButtons()[0]!.dataset.help).toBe('home');
    expect(content().querySelector('h2')!.firstChild!.textContent).toBe('ホーム');
    expect(content().querySelector('h2')!.querySelector('button')).toBeNull();
    expect(content().querySelector('h2')!.nextElementSibling).toBe(helpButtons()[0]);
    expect(helpButtons()[0]!.textContent).toBe('');
  });

  test('描き直しのたびに 1 つだけ入り、二重にならない', async () => {
    await run();
    expect(helpButtons()).toHaveLength(0);
    render('<h2>ホーム</h2>');
    await nextFrame();
    expect(helpButtons()).toHaveLength(1);
    render('<section><div><h2>入れ子の見出し</h2></div></section>');
    await nextFrame();
    await nextFrame();
    expect(helpButtons()).toHaveLength(1);
    expect(content().querySelectorAll('.guide-help-btn')).toHaveLength(1);
  });

  test('見出しの中だけが描き直されても取りこぼさない', async () => {
    render('<section><h2>見出し</h2></section>');
    await run();
    content().querySelector('h2')!.replaceChildren('新しい見出し');
    await nextFrame();
    expect(helpButtons()).toHaveLength(1);
  });

  test('ルートが変わるとトピックが替わる', async () => {
    render('<h2>見出し</h2>');
    await run();
    go('#/blocks');
    expect(helpButtons()).toHaveLength(1);
    expect(helpButtons()[0]!.dataset.help).toBe('blocks');
  });

  test('h2 が無い画面では何もしない', async () => {
    render('<h3>見出し</h3>');
    await run();
    go('#/seeds');
    expect(helpButtons()).toHaveLength(0);
  });

  test('data-help-topic を持つ要素にも入る', async () => {
    render('<h2>見出し</h2><div id="extra" data-help-topic="expand"></div>');
    await run();
    expect((document.getElementById('extra')!.nextElementSibling as HTMLElement).dataset.help).toBe('expand');
    expect(document.getElementById('extra')!.querySelector('.guide-help-btn')).toBeNull();
    expect(helpButtons()).toHaveLength(2);
  });

  test('「ここからツアーを始める」でツアーが始まる', async () => {
    render('<h2>ホーム</h2>');
    await run();
    helpButtons()[0]!.click();
    document.querySelector<HTMLButtonElement>('.guide-help-menu [data-help-action="start-tour"]')!.click();
    expect(runner.start).toHaveBeenCalledWith('getting-started');
    expect(document.querySelector('.guide-help-menu')).toBeNull();
  });

  test('「ツアーの一覧」で一覧が開き、メニューは閉じる', async () => {
    render('<h2>ホーム</h2>');
    await run();
    helpButtons()[0]!.click();
    document.querySelector<HTMLButtonElement>('.guide-help-menu [data-help-action="tour-list"]')!.click();
    expect(document.getElementById('guide-tour-list')).not.toBeNull();
    expect(document.querySelector('.guide-help-menu')).toBeNull();
    expect(document.getElementById('app-open-tours')!.getAttribute('aria-expanded')).toBe('true');
  });

  test('言語切替で「?」の aria-label とメニューの文面が替わり、画面が描き直されてもメニューは開いたまま新しい「?」へ付け替わる', async () => {
    render('<h2>ホーム</h2>');
    await run();
    helpButtons()[0]!.click();
    setUiLanguage('en');
    expect(helpButtons()[0]!.getAttribute('aria-label')).toBe('Help: Home');
    expect(document.querySelector('.guide-help-menu a')!.textContent).toBe('Read the help');
    render('<h2>別の画面</h2>');
    await nextFrame();
    expect(document.querySelector('.guide-help-menu')).not.toBeNull();
    expect(helpButtons()[0]!.getAttribute('aria-expanded')).toBe('true');
    go('#/seeds');
    await nextFrame();
    expect(document.querySelector('.guide-help-menu')).toBeNull();
  });

  test('後始末でメニューと保留中の描画を片づける', async () => {
    render('<h2>ホーム</h2>');
    const dispose = await run();
    helpButtons()[0]!.click();
    render('<h2>次</h2>');
    dispose();
    await nextFrame();
    expect(document.querySelector('.guide-help-menu')).toBeNull();
    expect(helpButtons()).toHaveLength(0);
  });
});
