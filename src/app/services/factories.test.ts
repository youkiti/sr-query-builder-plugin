import { createChromeGoogleApiDeps, createChromeRuntimeDeps } from './factories';

function setChrome(): void {
  (globalThis as unknown as { chrome: typeof chrome }).chrome = {
    identity: {
      getAuthToken: (_opts: unknown, cb: (token: string) => void) => cb('TOKEN'),
      removeCachedAuthToken: (_d: unknown, cb: () => void) => cb(),
      getProfileUserInfo: (_opts: unknown, cb: (info: { email: string; id: string }) => void) =>
        cb({ email: 'me@x', id: '1' }),
    },
    storage: {
      local: {
        get: jest.fn().mockResolvedValue({}),
        set: jest.fn().mockResolvedValue(undefined),
      },
    },
    runtime: {},
  } as unknown as typeof chrome;
}

describe('createChromeGoogleApiDeps', () => {
  test('既定で chrome.identity を使い、注入された AuthDeps があればそれを使う', async () => {
    const auth = {
      getAuthToken: jest.fn().mockResolvedValue('CUSTOM'),
      removeCachedAuthToken: jest.fn().mockResolvedValue(undefined),
    };
    const deps = createChromeGoogleApiDeps(auth);
    await expect(deps.getAccessToken()).resolves.toBe('CUSTOM');
    expect(auth.getAuthToken).toHaveBeenCalledWith({ interactive: false });
  });

  test('AuthDeps 未指定なら createChromeAuthDeps を内部で使う', async () => {
    setChrome();
    const deps = createChromeGoogleApiDeps();
    await expect(deps.getAccessToken()).resolves.toBe('TOKEN');
  });

  test('fetch は globalThis.fetch を引数透過で呼ぶ', async () => {
    setChrome();
    const stub = jest.fn().mockResolvedValue('R');
    const original = (globalThis as { fetch?: unknown }).fetch;
    (globalThis as { fetch?: unknown }).fetch = stub as unknown;
    try {
      const deps = createChromeGoogleApiDeps();
      await deps.fetch('http://example/', { method: 'GET' });
      expect(stub).toHaveBeenCalledWith('http://example/', { method: 'GET' });
    } finally {
      if (original === undefined) {
        delete (globalThis as { fetch?: unknown }).fetch;
      } else {
        (globalThis as { fetch?: unknown }).fetch = original;
      }
    }
  });
});

describe('createChromeRuntimeDeps', () => {
  test('google / profile / store 3 種を返す', async () => {
    setChrome();
    const deps = createChromeRuntimeDeps();
    expect(typeof deps.google.getAccessToken).toBe('function');
    expect(typeof deps.profile.getProfileUserInfo).toBe('function');
    expect(typeof deps.store.read).toBe('function');
    expect(typeof deps.store.write).toBe('function');
    await expect(deps.profile.getProfileUserInfo()).resolves.toEqual({ email: 'me@x', id: '1' });
  });
});
