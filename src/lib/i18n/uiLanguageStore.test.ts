import { getUiLanguage, setUiLanguage } from './index';
import { defaultUiLanguage, subscribeUiLanguage, loadUiLanguage, saveUiLanguage, UI_LANGUAGE_STORAGE_KEY } from './uiLanguageStore';

type ChromeLike = { storage?: unknown; i18n?: unknown };
const root = globalThis as unknown as { chrome: ChromeLike | undefined };
const original = root.chrome;
afterEach(() => { root.chrome = original; setUiLanguage('ja'); jest.restoreAllMocks(); });

function install(options: { stored?: unknown; uiLanguage?: string; failGet?: boolean; failSet?: boolean }): { set: jest.Mock } {
  const set = jest.fn(async () => { if (options.failSet) throw new Error('保存失敗'); });
  root.chrome = {
    storage: { local: {
      get: async () => { if (options.failGet) throw new Error('読込失敗'); return options.stored === undefined ? {} : { [UI_LANGUAGE_STORAGE_KEY]: options.stored }; },
      set,
    } },
    ...(options.uiLanguage === undefined ? {} : { i18n: { getUILanguage: () => options.uiLanguage } }),
  };
  return { set };
}

test('保存キーは uiLanguage', () => {
  expect(UI_LANGUAGE_STORAGE_KEY).toBe('uiLanguage');
});

test.each([['ja', 'ja'], ['ja-JP', 'ja'], ['en-US', 'en'], ['fr', 'en']])('保存値が無ければブラウザの UI 言語 %s から %s になる', async (browser, expected) => {
  install({ uiLanguage: browser });
  expect(defaultUiLanguage()).toBe(expected);
  expect(await loadUiLanguage()).toBe(expected);
});

test('chrome.i18n が無い環境の既定は ja', async () => {
  install({});
  expect(defaultUiLanguage()).toBe('ja');
  root.chrome = undefined;
  expect(defaultUiLanguage()).toBe('ja');
  expect(await loadUiLanguage()).toBe('ja');
});

test('保存値があればそれを返し、不正な値は既定に戻す', async () => {
  install({ stored: 'en', uiLanguage: 'ja' });
  expect(await loadUiLanguage()).toBe('en');
  install({ stored: 'fr', uiLanguage: 'ja' });
  expect(await loadUiLanguage()).toBe('ja');
});

test('読み込みに失敗しても警告して既定を返す', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  install({ failGet: true, uiLanguage: 'en' });
  expect(await loadUiLanguage()).toBe('en');
  expect(warn).toHaveBeenCalledTimes(1);
});

test('保存する。失敗しても例外にせず警告し、storage が無ければ何もしない', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  const ok = install({});
  await saveUiLanguage('en');
  expect(ok.set).toHaveBeenCalledWith({ uiLanguage: 'en' });
  install({ failSet: true });
  await expect(saveUiLanguage('ja')).resolves.toBeUndefined();
  expect(warn).toHaveBeenCalledTimes(1);
  root.chrome = {};
  await expect(saveUiLanguage('ja')).resolves.toBeUndefined();
  root.chrome = undefined;
  await expect(saveUiLanguage('ja')).resolves.toBeUndefined();
});


test('他ページの local の有効値だけを反映し、購読を解除できる', () => {
  const listeners = new Set<(changes: Record<string, chrome.storage.StorageChange>, area: string) => void>();
  root.chrome = { storage: { onChanged: {
    addListener: (listener: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void) => listeners.add(listener),
    removeListener: (listener: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void) => listeners.delete(listener),
  } } };
  const emit = (value: unknown, area = 'local'): void => {
    for (const listener of listeners) listener({ uiLanguage: { newValue: value } }, area);
  };
  const off = subscribeUiLanguage();
  emit('en', 'sync');
  expect(getUiLanguage()).toBe('ja');
  emit('en');
  expect(getUiLanguage()).toBe('en');
  emit('fr');
  emit(undefined);
  expect(getUiLanguage()).toBe('en');
  off();
  emit('ja');
  expect(getUiLanguage()).toBe('en');
  expect(listeners.size).toBe(0);
});

test('storage.onChanged が無い場合は何もしない', () => {
  root.chrome = undefined;
  expect(() => subscribeUiLanguage()()).not.toThrow();
  root.chrome = {};
  expect(() => subscribeUiLanguage()()).not.toThrow();
});
