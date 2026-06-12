import { createProject } from './createProject';
import { SHEET_TABS } from '@/domain/sheetsSchema';

function makeFetch(): {
  fetch: jest.Mock;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch = jest.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    // URL パターンで適切なレスポンスを返す
    if (url.includes('/drive/v3/files') && !url.includes('/upload/')) {
      if (init.method === 'POST') {
        // フォルダ作成
        const body = JSON.parse(init.body as string);
        const id = `FOLDER-${body.name}`;
        return jsonResponse({ id, webViewLink: `https://drive/${id}` });
      }
    }
    if (url === 'https://sheets.googleapis.com/v4/spreadsheets') {
      return jsonResponse({ spreadsheetId: 'SHEET-1', spreadsheetUrl: 'https://sheet/x' });
    }
    if (url.includes('/v4/spreadsheets/SHEET-1/values/')) {
      return jsonResponse({});
    }
    return jsonResponse({});
  });
  return { fetch, calls };
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe('createProject', () => {
  test('Drive フォルダ・サブフォルダ・スプレッドシート・9 タブヘッダ・Meta 行を順に作る', async () => {
    const { fetch, calls } = makeFetch();
    const deps = { fetch, getAccessToken: jest.fn().mockResolvedValue('t') };
    const result = await createProject(
      { projectTitle: 'My Review', createdBy: 'me@example.com' },
      deps,
      {
        ensureRootFolder: async () => 'ROOT',
        newUuid: () => '12345678-aaaa-4aaa-8aaa-000000000000',
        now: () => '2026-04-17T00:00:00.000Z',
      }
    );

    expect(result.meta).toEqual({
      projectId: '12345678-aaaa-4aaa-8aaa-000000000000',
      projectTitle: 'My Review',
      spreadsheetId: 'SHEET-1',
      driveFolderId: 'FOLDER-My Review_12345678',
      schemaVersion: '1.0',
      createdAt: '2026-04-17T00:00:00.000Z',
      createdBy: 'me@example.com',
    });

    const folderCalls = calls.filter(
      (c) => c.url.startsWith('https://www.googleapis.com/drive/v3/files?fields=id,webViewLink') &&
        c.init.method === 'POST'
    );
    // top + raw_protocols + logs + llm + validation = 5 フォルダ
    expect(folderCalls).toHaveLength(5);

    const headerCalls = calls.filter(
      (c) => c.url.includes('/v4/spreadsheets/SHEET-1/values/') && c.init.method === 'PUT'
    );
    expect(headerCalls).toHaveLength(SHEET_TABS.length);

    const appendCalls = calls.filter((c) => c.url.includes(':append'));
    expect(appendCalls).toHaveLength(1);
    const appendBody = JSON.parse(appendCalls[0]!.init.body as string);
    expect(appendBody.values[0][0]).toBe('12345678-aaaa-4aaa-8aaa-000000000000');
  });

  test('ensureRootFolder が null を返すとマイドライブ直下に作る', async () => {
    const { fetch, calls } = makeFetch();
    const deps = { fetch, getAccessToken: jest.fn().mockResolvedValue('t') };
    await createProject(
      { projectTitle: 'X', createdBy: 'u@x' },
      deps,
      {
        ensureRootFolder: async () => null,
        newUuid: () => '00000000-0000-4000-8000-000000000000',
        now: () => '2026-01-01T00:00:00.000Z',
      }
    );
    const firstFolderCall = calls.find(
      (c) =>
        c.url.startsWith('https://www.googleapis.com/drive/v3/files?') &&
        c.init.method === 'POST' &&
        JSON.parse(c.init.body as string).name === 'X_00000000'
    );
    expect(firstFolderCall).toBeTruthy();
    const body = JSON.parse(firstFolderCall!.init.body as string);
    expect(body.parents).toBeUndefined();
  });

  test('ensureRootFolder / newUuid / now の既定値が使われる（ensureRoot 既定はルートフォルダを検索して再利用、なければ作成）', async () => {
    const { fetch, calls } = makeFetch();
    const deps = { fetch, getAccessToken: jest.fn().mockResolvedValue('t') };
    await createProject({ projectTitle: 'Y', createdBy: 'u@y' }, deps);
    // モックが GET に空オブジェクトを返す → 既存フォルダなし → POST で作成する
    // ルートフォルダ（sr-query-builder）+ top + raw_protocols + logs + llm + validation = 6
    const folderCreates = calls.filter(
      (c) =>
        c.url.startsWith('https://www.googleapis.com/drive/v3/files?fields=id,webViewLink') &&
        c.init.method === 'POST'
    );
    expect(folderCreates.length).toBeGreaterThanOrEqual(5);
    const rootCall = folderCreates.find(
      (c) => JSON.parse(c.init.body as string).name === 'sr-query-builder'
    );
    expect(rootCall).toBeTruthy();
  });
});
