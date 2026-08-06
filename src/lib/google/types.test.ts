import { GoogleApiError, googleFetch } from './types';

function makeDeps(response: Response): { fetch: jest.Mock; getAccessToken: jest.Mock } {
  return {
    fetch: jest.fn().mockResolvedValue(response),
    getAccessToken: jest.fn().mockResolvedValue('tok'),
  };
}

describe('googleFetch', () => {
  test('Authorization ヘッダにトークンを付けて fetch する', async () => {
    const res = {
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => '',
    } as Response;
    const deps = makeDeps(res);
    await googleFetch('https://api/', { method: 'GET' }, deps);
    expect(deps.fetch).toHaveBeenCalledTimes(1);
    const [, init] = deps.fetch.mock.calls[0];
    const headers = (init as RequestInit).headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer tok');
  });

  test('非 2xx は GoogleApiError を throw する', async () => {
    const res = {
      ok: false,
      status: 403,
      json: async () => ({}),
      text: async () => 'forbidden',
    } as Response;
    const deps = makeDeps(res);
    await expect(googleFetch('https://api/', { method: 'GET' }, deps)).rejects.toBeInstanceOf(
      GoogleApiError
    );
  });

  test('GoogleApiError は status / endpoint / responseBody を保持する', async () => {
    const res = {
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => 'server err',
    } as Response;
    const deps = makeDeps(res);
    try {
      await googleFetch('https://api/x', { method: 'GET' }, deps);
    } catch (err) {
      expect(err).toBeInstanceOf(GoogleApiError);
      const e = err as GoogleApiError;
      expect(e.status).toBe(500);
      expect(e.endpoint).toBe('https://api/x');
      expect(e.responseBody).toBe('server err');
      return;
    }
    throw new Error('should have thrown');
  });

  test('text() が失敗しても空文字で握りつぶして GoogleApiError を投げる', async () => {
    const res = {
      ok: false,
      status: 502,
      json: async () => ({}),
      text: async (): Promise<string> => {
        throw new Error('network');
      },
    } as Response;
    const deps = makeDeps(res);
    await expect(googleFetch('https://api/', { method: 'GET' }, deps)).rejects.toMatchObject({
      status: 502,
      responseBody: '',
    });
  });

  test('エラーメッセージに Google の error.message が含まれる', async () => {
    const res = {
      ok: false,
      status: 503,
      json: async () => ({}),
      text: async () =>
        JSON.stringify({
          error: { code: 503, message: 'The service is currently unavailable.', status: 'UNAVAILABLE' },
        }),
    } as Response;
    const deps = makeDeps(res);
    await expect(
      googleFetch('https://sheets.googleapis.com/v4/spreadsheets', { method: 'POST' }, deps)
    ).rejects.toMatchObject({
      message: expect.stringContaining('The service is currently unavailable.'),
    });
  });

  test('JSON でない本文はそのまま（長い場合は 200 文字程度に切り詰めて）含まれる', async () => {
    const longBody = 'x'.repeat(250);
    const res = {
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => longBody,
    } as Response;
    const deps = makeDeps(res);
    try {
      await googleFetch('https://api/x', { method: 'GET' }, deps);
      throw new Error('should have thrown');
    } catch (err) {
      const e = err as GoogleApiError;
      expect(e.message).toContain('x'.repeat(200));
      expect(e.message).not.toContain('x'.repeat(201));
    }
  });

  test('本文が空でも壊れず、余計な区切り文字が残らない', async () => {
    const res = {
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => '',
    } as Response;
    const deps = makeDeps(res);
    await expect(googleFetch('https://api/', { method: 'GET' }, deps)).rejects.toMatchObject({
      message: 'Google API failed: HTTP 500 (GET https://api/)',
    });
  });

  test('メソッドと URL がメッセージに含まれる', async () => {
    const res = {
      ok: false,
      status: 403,
      json: async () => ({}),
      text: async () => 'forbidden',
    } as Response;
    const deps = makeDeps(res);
    await expect(
      googleFetch('https://www.googleapis.com/drive/v3/files/F1', { method: 'PATCH' }, deps)
    ).rejects.toMatchObject({
      message: expect.stringContaining('(PATCH https://www.googleapis.com/drive/v3/files/F1)'),
    });
  });

  test('初期ヘッダをマージする', async () => {
    const res = {
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => '',
    } as Response;
    const deps = makeDeps(res);
    await googleFetch(
      'https://api/',
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      deps
    );
    const [, init] = deps.fetch.mock.calls[0];
    const headers = (init as RequestInit).headers as Headers;
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get('Authorization')).toBe('Bearer tok');
  });
});
