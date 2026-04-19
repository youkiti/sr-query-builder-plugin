import { SHEET_HEADERS } from '@/domain/sheetsSchema';
import { createNewProject, loadExistingProject, type ProjectServiceDeps } from './projectService';

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function makeDeps(overrides: Partial<ProjectServiceDeps> = {}): {
  deps: ProjectServiceDeps;
  storeData: Record<string, unknown>;
  fetchMock: jest.Mock;
} {
  const fetchMock = jest.fn();
  const storeData: Record<string, unknown> = {};
  const base: ProjectServiceDeps = {
    google: {
      fetch: fetchMock as unknown as typeof fetch,
      getAccessToken: jest.fn().mockResolvedValue('t'),
    },
    profile: {
      getProfileUserInfo: jest.fn().mockResolvedValue({ email: 'me@example.com', id: 'u' }),
    },
    store: {
      read: async <T>(key: string) => storeData[key] as T | undefined,
      write: async (items) => {
        Object.assign(storeData, items);
      },
    },
  };
  return { deps: { ...base, ...overrides }, storeData, fetchMock };
}

describe('createNewProject', () => {
  test('Drive フォルダ + Sheets を作成し chrome.storage に書き込む', async () => {
    const { deps, fetchMock, storeData } = makeDeps();
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (url.startsWith('https://www.googleapis.com/drive/v3/files') && init.method === 'POST') {
        const body = JSON.parse(init.body as string) as { name: string };
        return jsonResponse({ id: `F-${body.name}`, webViewLink: 'https://drive/x' });
      }
      if (url === 'https://sheets.googleapis.com/v4/spreadsheets') {
        return jsonResponse({ spreadsheetId: 'SHEET-1', spreadsheetUrl: 'https://sheet/x' });
      }
      return jsonResponse({});
    });
    const { entry } = await createNewProject('My Review', deps);
    expect(entry.spreadsheetId).toBe('SHEET-1');
    expect(entry.title).toBe('My Review');
    expect(storeData['currentProject']).toEqual(entry);
    expect((storeData['recentProjects'] as unknown[])).toContainEqual(entry);
  });

  test('email 未取得のときも createdBy を空文字で続行する', async () => {
    const { deps, fetchMock } = makeDeps({
      profile: { getProfileUserInfo: jest.fn().mockResolvedValue({ email: '', id: '' }) },
    });
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (url.startsWith('https://www.googleapis.com/drive/v3/files') && init.method === 'POST') {
        return jsonResponse({ id: 'F', webViewLink: '' });
      }
      if (url === 'https://sheets.googleapis.com/v4/spreadsheets') {
        return jsonResponse({ spreadsheetId: 'S', spreadsheetUrl: '' });
      }
      return jsonResponse({});
    });
    await expect(createNewProject('Title', deps)).resolves.toBeDefined();
  });

  test('タイトルが空文字 / 空白のみだとエラー', async () => {
    const { deps } = makeDeps();
    await expect(createNewProject('', deps)).rejects.toThrow(/必須/);
    await expect(createNewProject('   ', deps)).rejects.toThrow(/必須/);
  });
});

describe('loadExistingProject', () => {
  test('Meta タブを読んで currentProject に登録する', async () => {
    const { deps, fetchMock, storeData } = makeDeps();
    fetchMock.mockResolvedValue(
      jsonResponse({
        values: [
          [...SHEET_HEADERS.Meta],
          ['pid', 'タイトル', 'sid', 'did', '1.0', '2026-04-19T00:00:00.000Z', 'me@example.com'],
        ],
      })
    );
    const entry = await loadExistingProject('sid', deps);
    expect(entry).toEqual({
      projectId: 'pid',
      spreadsheetId: 'sid',
      driveFolderId: 'did',
      title: 'タイトル',
    });
    expect(storeData['currentProject']).toEqual(entry);
  });

  test('ID が空ならエラー', async () => {
    const { deps } = makeDeps();
    await expect(loadExistingProject('', deps)).rejects.toThrow(/必須/);
    await expect(loadExistingProject('   ', deps)).rejects.toThrow(/必須/);
  });

  test('Meta タブ不正は loadProjectMeta の ProjectSchemaError をそのまま伝播', async () => {
    const { deps, fetchMock } = makeDeps();
    fetchMock.mockResolvedValue(jsonResponse({ values: [] }));
    await expect(loadExistingProject('sid', deps)).rejects.toThrow(/Meta タブ/);
  });
});
