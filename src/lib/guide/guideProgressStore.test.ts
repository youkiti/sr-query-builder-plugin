import { completeTour, createEmptyGuideProgress, startTour, GUIDE_PROGRESS_STORAGE_KEY } from './tourProgress';

type StorageListener = (changes: Record<string, { newValue?: unknown }>, areaName: string) => void;
const root = globalThis as unknown as { chrome: unknown };
const original = root.chrome;
let data: Record<string, unknown>;
let listeners: Set<StorageListener>;
let failGet = false;
let failSet = false;
afterEach(() => { root.chrome = original; jest.restoreAllMocks(); });

/** モジュール内の保持値を初期化するため、毎回読み込み直す。 */
function load(withChrome = true): typeof import('./guideProgressStore') {
  data = {}; listeners = new Set(); failGet = false; failSet = false;
  root.chrome = withChrome ? {
    storage: {
      local: {
        get: async (key: string) => { if (failGet) throw new Error('読込失敗'); return key in data ? { [key]: data[key] } : {}; },
        set: async (items: Record<string, unknown>) => { if (failSet) throw new Error('保存失敗'); Object.assign(data, items); },
      },
      onChanged: { addListener: (l: StorageListener) => listeners.add(l), removeListener: (l: StorageListener) => listeners.delete(l) },
    },
  } : undefined;
  let module!: typeof import('./guideProgressStore');
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    module = require('./guideProgressStore');
  });
  return module;
}

test('保存値を一度だけ読み込み、保持値を返す', async () => {
  const store = load();
  data[GUIDE_PROGRESS_STORAGE_KEY] = { tours: {}, active: null, suppressSuggestions: true };
  expect((await store.loadGuideProgress()).suppressSuggestions).toBe(true);
  data[GUIDE_PROGRESS_STORAGE_KEY] = { tours: {}, active: null, suppressSuggestions: false };
  await store.loadGuideProgress();
  expect(store.getGuideProgress().suppressSuggestions).toBe(true);
});

test('保存値が無い・壊れている・読み込みに失敗しても空の進捗で動く', async () => {
  expect(await load().loadGuideProgress()).toEqual(createEmptyGuideProgress());
  const broken = load();
  data[GUIDE_PROGRESS_STORAGE_KEY] = 'x';
  expect(await broken.loadGuideProgress()).toEqual(createEmptyGuideProgress());
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  const failing = load();
  failGet = true;
  expect(await failing.loadGuideProgress()).toEqual(createEmptyGuideProgress());
  expect(warn).toHaveBeenCalledTimes(1);
});

test('chrome.storage が無い環境でも読み込み・更新で止まらない', async () => {
  const store = load(false);
  expect(await store.loadGuideProgress()).toEqual(createEmptyGuideProgress());
  store.updateGuideProgress(current => startTour(current, 'getting-started'));
  expect(store.getGuideProgress().active?.tourId).toBe('getting-started');
  expect(store.subscribeGuideProgressChange(() => undefined)()).toBeUndefined();
  const withoutStorage = load(false);
  root.chrome = {};
  expect(await withoutStorage.loadGuideProgress()).toEqual(createEmptyGuideProgress());
});

test('更新は保持値を変えて保存し、保存に失敗しても保持値は戻さない', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  const store = load();
  await store.loadGuideProgress();
  store.updateGuideProgress(current => startTour(current, 'getting-started'));
  await Promise.resolve();
  expect((data[GUIDE_PROGRESS_STORAGE_KEY] as { active: { tourId: string } }).active.tourId).toBe('getting-started');
  failSet = true;
  store.updateGuideProgress(current => completeTour(current, 'getting-started', 'now'));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(store.getGuideProgress().tours['getting-started']?.status).toBe('done');
  expect(warn).toHaveBeenCalledTimes(1);
});

test('他タブの変更は保持値へ反映して通知し、保存しない。無関係な変更・解除後は無視する', async () => {
  const store = load();
  await store.loadGuideProgress();
  const listener = jest.fn();
  const off = store.subscribeGuideProgressChange(listener);
  const change = (changes: Record<string, { newValue?: unknown }>, area = 'local'): void => listeners.forEach(l => l(changes, area));
  change({ other: { newValue: 1 } });
  change({ [GUIDE_PROGRESS_STORAGE_KEY]: { newValue: { tours: {}, active: null, suppressSuggestions: true } } }, 'sync');
  expect(listener).not.toHaveBeenCalled();
  change({ [GUIDE_PROGRESS_STORAGE_KEY]: { newValue: { tours: {}, active: null, suppressSuggestions: true } } });
  expect(listener).toHaveBeenCalledTimes(1);
  expect(store.getGuideProgress().suppressSuggestions).toBe(true);
  expect(data[GUIDE_PROGRESS_STORAGE_KEY]).toBeUndefined();
  change({ [GUIDE_PROGRESS_STORAGE_KEY]: { newValue: undefined } });
  expect(store.getGuideProgress()).toEqual(createEmptyGuideProgress());
  off();
  expect(listeners.size).toBe(0);
});

test('「あとで」はこのセッションの間だけ覚える', () => {
  const store = load();
  expect(store.isGuidePostponed()).toBe(false);
  store.postponeGuideSuggestions();
  expect(store.isGuidePostponed()).toBe(true);
  expect(load().isGuidePostponed()).toBe(false);
});
