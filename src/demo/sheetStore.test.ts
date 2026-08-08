import {
  createFolder,
  createSpreadsheet,
  ensureChildFolder,
  ensureRootFolder,
  getFileText,
  getSheetValues,
  moveFileToFolder,
  uploadTextFile,
  writeHeaderRow,
  appendRow,
  updateRow,
  type GoogleApiDeps,
} from '@/lib/google';
import { createProject } from '@/features/project';
import { appendProtocol, getLatestProtocol } from '@/features/protocol';
import { handleDriveRequest, handleSheetsRequest, resetDemoBackend } from './sheetStore';

/**
 * sheetStore.ts を本番の Sheets/Drive クライアント（`@/lib/google`）経由で叩いて検証する。
 * llmFixtures.test.ts / eutilsMock.test.ts と同じ「本番コードから叩く」方針。
 */
function makeDeps(): GoogleApiDeps {
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const bodyText = typeof init?.body === 'string' ? init.body : '';
    if (url.startsWith('https://sheets.googleapis.com/')) {
      return handleSheetsRequest(url, method, bodyText);
    }
    const headers = new Headers(init?.headers);
    return handleDriveRequest(url, method, bodyText, headers.get('Content-Type') ?? '');
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, getAccessToken: async () => 'demo-token' };
}

beforeEach(async () => {
  await resetDemoBackend();
});

describe('Sheets API モック', () => {
  it('スプレッドシート作成 → ヘッダ書き込み → 追記 → 読み出しの往復ができる', async () => {
    const deps = makeDeps();
    const created = await createSpreadsheet('デモ（テスト）', ['Protocol', 'SeedPapers'], deps);
    expect(created.spreadsheetId).toBeTruthy();

    await writeHeaderRow(created.spreadsheetId, 'Protocol', ['version', 'research_question'], deps);
    await appendRow(created.spreadsheetId, 'Protocol', [1, 'RQ テキスト'], deps);
    const rows = await getSheetValues(created.spreadsheetId, 'Protocol', deps);
    expect(rows).toEqual([
      ['version', 'research_question'],
      ['1', 'RQ テキスト'],
    ]);

    await updateRow(created.spreadsheetId, 'Protocol', 2, [1, '更新後の RQ'], deps);
    const rowsAfterUpdate = await getSheetValues(created.spreadsheetId, 'Protocol', deps);
    expect(rowsAfterUpdate[1]).toEqual(['1', '更新後の RQ']);
  });

  it('存在しない spreadsheetId は目立つエラーを投げる', async () => {
    const deps = makeDeps();
    await expect(getSheetValues('does-not-exist', 'Protocol', deps)).rejects.toThrow();
  });
});

describe('Drive API モック', () => {
  it('フォルダ作成・既存検索（ensureChildFolder）・テキストアップロード・取得ができる', async () => {
    const deps = makeDeps();
    const root = await createFolder('root-folder', null, deps);
    const child1 = await ensureChildFolder('logs', root.id, deps);
    const child2 = await ensureChildFolder('logs', root.id, deps);
    // 2 回目は新規作成せず同じフォルダを返す
    expect(child2.id).toBe(child1.id);

    const uploaded = await uploadTextFile(
      { name: 'note.txt', content: 'hello demo', parentId: child1.id },
      deps
    );
    const text = await getFileText(uploaded.id, deps);
    expect(text).toBe('hello demo');
  });

  it('ensureRootFolder はマイドライブ直下を検索し、無ければ作成する', async () => {
    const deps = makeDeps();
    const first = await ensureRootFolder('sr-query-builder', deps);
    const second = await ensureRootFolder('sr-query-builder', deps);
    expect(second.id).toBe(first.id);
  });

  it('moveFileToFolder は親フォルダを付け替える', async () => {
    const deps = makeDeps();
    const folderA = await createFolder('A', null, deps);
    const folderB = await createFolder('B', null, deps);
    const file = await uploadTextFile({ name: 'x.txt', content: 'x', parentId: folderA.id }, deps);
    const moved = await moveFileToFolder(file.id, folderB.id, deps);
    expect(moved.parents).toEqual([folderB.id]);
  });
});

describe('createProject（本番の feature 関数を丸ごと駆動する統合確認）', () => {
  it('Meta / 9 タブ初期化まで一気通貫で成功する', async () => {
    const deps = makeDeps();
    const result = await createProject(
      { projectTitle: 'デモ検証用プロジェクト', createdBy: 'demo@example.com' },
      deps
    );
    expect(result.meta.projectId).toBeTruthy();
    expect(result.spreadsheet.spreadsheetId).toBeTruthy();

    await appendProtocol(
      result.spreadsheet.spreadsheetId,
      {
        version: 1,
        frameworkType: 'pico',
        researchQuestion: 'RQ',
        inclusionCriteria: null,
        exclusionCriteria: null,
        studyDesign: null,
        blockCount: 1,
        combinationExpression: '#1',
        sourceType: 'manual',
        sourceFilename: null,
        rawTextRef: null,
        rawTextPreview: null,
        rawTextInline: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        createdBy: 'demo@example.com',
      },
      deps
    );
    const protocol = await getLatestProtocol(result.spreadsheet.spreadsheetId, deps);
    expect(protocol?.researchQuestion).toBe('RQ');
  });
});
