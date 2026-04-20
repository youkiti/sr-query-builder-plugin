import { createChromeStorageDeps } from './chromeStorage';

function setChrome(storage: {
  get: (k: string) => Promise<Record<string, unknown>>;
  set: (items: Record<string, unknown>) => Promise<void>;
}): void {
  (globalThis as unknown as { chrome: typeof chrome }).chrome = {
    storage: { local: storage },
  } as unknown as typeof chrome;
}

describe('createChromeStorageDeps', () => {
  test('read は chrome.storage.local.get の結果から型引数で値を取り出す', async () => {
    setChrome({
      get: jest.fn().mockResolvedValue({ foo: { nested: 42 } }),
      set: jest.fn().mockResolvedValue(undefined),
    });
    const deps = createChromeStorageDeps();
    await expect(deps.read<{ nested: number }>('foo')).resolves.toEqual({ nested: 42 });
  });

  test('read は未定義なら undefined を返す', async () => {
    setChrome({
      get: jest.fn().mockResolvedValue({}),
      set: jest.fn().mockResolvedValue(undefined),
    });
    const deps = createChromeStorageDeps();
    await expect(deps.read<string>('missing')).resolves.toBeUndefined();
  });

  test('write は与えられた items をそのまま chrome.storage.local.set に渡す', async () => {
    const set = jest.fn().mockResolvedValue(undefined);
    setChrome({
      get: jest.fn().mockResolvedValue({}),
      set,
    });
    const deps = createChromeStorageDeps();
    await deps.write({ a: 1, b: 'x' });
    expect(set).toHaveBeenCalledWith({ a: 1, b: 'x' });
  });
});
