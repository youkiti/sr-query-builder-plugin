import { createFolder, getFileText, uploadTextFile } from './drive';

function okJson(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function okText(body: string): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({}),
    text: async () => body,
  } as Response;
}

describe('createFolder', () => {
  test('親フォルダ指定で作成', async () => {
    const fetch = jest.fn().mockResolvedValue(okJson({ id: 'F1', webViewLink: 'https://drive/x' }));
    const deps = { fetch, getAccessToken: jest.fn().mockResolvedValue('t') };
    const result = await createFolder('sub', 'PARENT', deps);
    expect(result).toEqual({ id: 'F1', webViewLink: 'https://drive/x' });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toContain('/drive/v3/files?fields=id,webViewLink');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({
      name: 'sub',
      mimeType: 'application/vnd.google-apps.folder',
      parents: ['PARENT'],
    });
  });

  test('親 null ならマイドライブ直下（parents 未指定）', async () => {
    const fetch = jest.fn().mockResolvedValue(okJson({ id: 'F1', webViewLink: '' }));
    const deps = { fetch, getAccessToken: jest.fn().mockResolvedValue('t') };
    await createFolder('root', null, deps);
    const body = JSON.parse((fetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body.parents).toBeUndefined();
  });
});

describe('uploadTextFile', () => {
  test('multipart 本文に metadata + content が入る', async () => {
    const fetch = jest
      .fn()
      .mockResolvedValue(okJson({ id: 'file-1', webViewLink: 'https://drive/y' }));
    const deps = { fetch, getAccessToken: jest.fn().mockResolvedValue('t') };
    const result = await uploadTextFile(
      { name: 'log.json', content: '{"a":1}', parentId: 'FOLDER', mimeType: 'application/json' },
      deps
    );
    expect(result).toEqual({ id: 'file-1', webViewLink: 'https://drive/y' });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toContain('/upload/drive/v3/files?uploadType=multipart');
    const body = (init as RequestInit).body as string;
    expect(body).toContain('"name":"log.json"');
    expect(body).toContain('"parents":["FOLDER"]');
    expect(body).toContain('{"a":1}');
    expect(body).toContain('application/json; charset=UTF-8');
  });

  test('mimeType 未指定なら text/plain', async () => {
    const fetch = jest.fn().mockResolvedValue(okJson({ id: 'f', webViewLink: '' }));
    const deps = { fetch, getAccessToken: jest.fn().mockResolvedValue('t') };
    await uploadTextFile({ name: 'note.txt', content: 'hi', parentId: 'P' }, deps);
    const body = (fetch.mock.calls[0][1] as RequestInit).body as string;
    expect(body).toContain('text/plain; charset=UTF-8');
  });
});

describe('getFileText', () => {
  test('alt=media で本文を取得', async () => {
    const fetch = jest.fn().mockResolvedValue(okText('hello world'));
    const deps = { fetch, getAccessToken: jest.fn().mockResolvedValue('t') };
    await expect(getFileText('FILE-id', deps)).resolves.toBe('hello world');
    const [url] = fetch.mock.calls[0];
    expect(url).toContain('/drive/v3/files/FILE-id?alt=media');
  });
});
