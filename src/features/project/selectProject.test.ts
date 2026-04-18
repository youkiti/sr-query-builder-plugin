import { SHEET_HEADERS } from '@/domain/sheetsSchema';
import { ProjectSchemaError, loadProjectMeta } from './selectProject';

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function depsReturning(values: string[][] | undefined): {
  fetch: jest.Mock;
  getAccessToken: jest.Mock;
} {
  return {
    fetch: jest
      .fn()
      .mockResolvedValue(jsonResponse(values === undefined ? {} : { values })),
    getAccessToken: jest.fn().mockResolvedValue('t'),
  };
}

describe('loadProjectMeta', () => {
  test('正しい Meta タブからメタを読み取れる', async () => {
    const deps = depsReturning([
      [...SHEET_HEADERS.Meta],
      ['pid', 'title', 'sid', 'did', '1.0', '2026-01-01T00:00:00.000Z', 'me@x'],
    ]);
    const meta = await loadProjectMeta('sid', deps);
    expect(meta).toEqual({
      projectId: 'pid',
      projectTitle: 'title',
      spreadsheetId: 'sid',
      driveFolderId: 'did',
      schemaVersion: '1.0',
      createdAt: '2026-01-01T00:00:00.000Z',
      createdBy: 'me@x',
    });
  });

  test('空ならエラー', async () => {
    const deps = depsReturning(undefined);
    await expect(loadProjectMeta('sid', deps)).rejects.toBeInstanceOf(ProjectSchemaError);
  });

  test('ヘッダの長さが違うとエラー', async () => {
    const deps = depsReturning([['wrong', 'header']]);
    await expect(loadProjectMeta('sid', deps)).rejects.toThrow(/列構成/);
  });

  test('ヘッダが同じ長さでも中身が違うとエラー', async () => {
    const mismatched = [...SHEET_HEADERS.Meta];
    mismatched[0] = 'different';
    const deps = depsReturning([
      mismatched,
      ['pid', 't', 'sid', 'did', '1.0', '2026', 'me'],
    ]);
    await expect(loadProjectMeta('sid', deps)).rejects.toThrow(/列構成/);
  });

  test('空ヘッダ行（undefined 相当）でもエラー', async () => {
    const deps = depsReturning([[]]);
    await expect(loadProjectMeta('sid', deps)).rejects.toThrow(/列構成/);
  });

  test('データ行が無いとエラー', async () => {
    const deps = depsReturning([[...SHEET_HEADERS.Meta]]);
    await expect(loadProjectMeta('sid', deps)).rejects.toThrow(/データ行/);
  });

  test('未対応スキーマバージョンはエラー', async () => {
    const deps = depsReturning([
      [...SHEET_HEADERS.Meta],
      ['pid', 't', 'sid', 'did', '2.0', '2026', 'me'],
    ]);
    await expect(loadProjectMeta('sid', deps)).rejects.toThrow(/\u30b5\u30dd\u30fc\u30c8\u5916/);
  });

  test('列が足りない行でも null 埋めで読み取る（空文字相当）', async () => {
    const deps = depsReturning([
      [...SHEET_HEADERS.Meta],
      ['pid', 'title', 'sid', 'did', '1.0'], // created_at / created_by が無い
    ]);
    const meta = await loadProjectMeta('sid', deps);
    expect(meta.createdAt).toBe('');
    expect(meta.createdBy).toBe('');
  });
});
