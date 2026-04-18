import { createChromeAuthDeps, getAccessToken, refreshAccessToken } from './auth';

describe('getAccessToken / refreshAccessToken', () => {
  test('getAccessToken は deps.getAuthToken({interactive}) を呼ぶ', async () => {
    const deps = {
      getAuthToken: jest.fn().mockResolvedValue('T'),
      removeCachedAuthToken: jest.fn().mockResolvedValue(undefined),
    };
    await expect(getAccessToken(deps)).resolves.toBe('T');
    expect(deps.getAuthToken).toHaveBeenCalledWith({ interactive: false });
  });

  test('interactive=true で対話フローを要求できる', async () => {
    const deps = {
      getAuthToken: jest.fn().mockResolvedValue('T'),
      removeCachedAuthToken: jest.fn(),
    };
    await getAccessToken(deps, true);
    expect(deps.getAuthToken).toHaveBeenCalledWith({ interactive: true });
  });

  test('refreshAccessToken は失効トークンを無効化して再取得する', async () => {
    const deps = {
      getAuthToken: jest.fn().mockResolvedValue('NEW'),
      removeCachedAuthToken: jest.fn().mockResolvedValue(undefined),
    };
    await expect(refreshAccessToken(deps, 'STALE')).resolves.toBe('NEW');
    expect(deps.removeCachedAuthToken).toHaveBeenCalledWith('STALE');
    expect(deps.getAuthToken).toHaveBeenCalledWith({ interactive: true });
  });
});

describe('createChromeAuthDeps', () => {
  function setChromeIdentity(opts: {
    getAuthToken?: (
      options: { interactive?: boolean },
      cb: (token: string | undefined) => void
    ) => void;
    lastError?: { message: string };
    removeCachedAuthToken?: (details: { token: string }, cb: () => void) => void;
  }): void {
    (globalThis as unknown as { chrome: typeof chrome }).chrome = {
      identity: {
        getAuthToken:
          opts.getAuthToken ??
          ((_options, cb) => {
            cb('token-xyz');
          }),
        removeCachedAuthToken:
          opts.removeCachedAuthToken ??
          ((_details, cb) => {
            cb();
          }),
      },
      runtime: { lastError: opts.lastError },
    } as unknown as typeof chrome;
  }

  test('getAuthToken が token を返す（lastError なし）', async () => {
    setChromeIdentity({});
    const deps = createChromeAuthDeps();
    await expect(deps.getAuthToken()).resolves.toBe('token-xyz');
  });

  test('getAuthToken が lastError を返すと reject', async () => {
    setChromeIdentity({
      getAuthToken: (_opts, cb) => {
        cb(undefined);
      },
      lastError: { message: 'denied' },
    });
    const deps = createChromeAuthDeps();
    await expect(deps.getAuthToken()).rejects.toThrow(/denied/);
  });

  test('token が空文字でも reject', async () => {
    setChromeIdentity({
      getAuthToken: (_opts, cb) => {
        cb(undefined);
      },
    });
    const deps = createChromeAuthDeps();
    await expect(deps.getAuthToken()).rejects.toThrow(/empty/);
  });

  test('removeCachedAuthToken は resolve する', async () => {
    setChromeIdentity({});
    const deps = createChromeAuthDeps();
    await expect(deps.removeCachedAuthToken('TOK')).resolves.toBeUndefined();
  });
});
