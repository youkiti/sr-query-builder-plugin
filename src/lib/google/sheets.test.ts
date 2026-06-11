import { appendRow, createSpreadsheet, getSheetValues, updateRow, writeHeaderRow } from './sheets';

function okJson(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function deps(body: unknown = {}): { fetch: jest.Mock; getAccessToken: jest.Mock } {
  return {
    fetch: jest.fn().mockResolvedValue(okJson(body)),
    getAccessToken: jest.fn().mockResolvedValue('token'),
  };
}

describe('createSpreadsheet', () => {
  test('POST /v4/spreadsheets にタブ指定付きで作成リクエスト', async () => {
    const d = deps({ spreadsheetId: 'sid', spreadsheetUrl: 'https://sheets.google/x' });
    const result = await createSpreadsheet('My project', ['Meta', 'Protocol'], d);
    expect(result).toEqual({
      spreadsheetId: 'sid',
      spreadsheetUrl: 'https://sheets.google/x',
    });
    const [url, init] = d.fetch.mock.calls[0];
    expect(url).toBe('https://sheets.googleapis.com/v4/spreadsheets');
    expect((init as RequestInit).method).toBe('POST');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.properties.title).toBe('My project');
    expect(body.sheets).toEqual([
      { properties: { title: 'Meta' } },
      { properties: { title: 'Protocol' } },
    ]);
  });
});

describe('writeHeaderRow', () => {
  test('PUT /values/{range}?valueInputOption=RAW でヘッダを書き込む', async () => {
    const d = deps();
    await writeHeaderRow('sid', 'Meta', ['project_id', 'title'], d);
    const [url, init] = d.fetch.mock.calls[0];
    expect(url).toContain('/sid/values/Meta!A1?valueInputOption=RAW');
    expect((init as RequestInit).method).toBe('PUT');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.values).toEqual([['project_id', 'title']]);
  });
});

describe('appendRow', () => {
  test('POST :append で 1 行追加、null は空文字に変換', async () => {
    const d = deps();
    await appendRow('sid', 'Protocol', ['a', 1, true, null], d);
    const [url, init] = d.fetch.mock.calls[0];
    expect(url).toContain(':append?valueInputOption=RAW');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.values).toEqual([['a', 1, true, '']]);
  });
});

describe('updateRow', () => {
  test('PUT /values/{tab}!A{n}:Z{n}?valueInputOption=RAW で行を上書き、null は空文字に変換', async () => {
    const d = deps();
    await updateRow('sid', 'SeedPapers', 3, ['x', null, true], d);
    const [url, init] = d.fetch.mock.calls[0];
    expect(url).toContain('/sid/values/');
    // range は SeedPapers!A3:Z3（encodeURIComponent 済み）
    expect(decodeURIComponent(url as string)).toContain('SeedPapers!A3:Z3?valueInputOption=RAW');
    expect((init as RequestInit).method).toBe('PUT');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.values).toEqual([['x', '', true]]);
  });
});

describe('getSheetValues', () => {
  test('values が返ってくればそのまま返す', async () => {
    const d = deps({ values: [['a', 'b'], ['c', 'd']] });
    await expect(getSheetValues('sid', 'Protocol', d)).resolves.toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  test('values が未定義なら [] を返す', async () => {
    const d = deps({});
    await expect(getSheetValues('sid', 'Protocol', d)).resolves.toEqual([]);
  });
});
