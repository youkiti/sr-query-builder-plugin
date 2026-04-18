import { googleFetch, type GoogleApiDeps } from './types';

const API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

/**
 * Sheets API v4 の薄いラッパ群。Sheets API は JSON なので XML 変換は不要。
 * 9 タブの初期化やヘッダ書き込みなど、プロジェクト作成で使う最小限の機能だけ提供する。
 */

export interface CreatedSpreadsheet {
  spreadsheetId: string;
  spreadsheetUrl: string;
}

/**
 * タイトルと初期タブ名を指定してスプレッドシートを新規作成する。
 * 指定されたタブ名と同じ順序で sheet が作られる（既定の `Sheet1` は含めない）。
 */
export async function createSpreadsheet(
  title: string,
  tabTitles: readonly string[],
  deps: GoogleApiDeps
): Promise<CreatedSpreadsheet> {
  const body = {
    properties: { title },
    sheets: tabTitles.map((t) => ({ properties: { title: t } })),
  };
  const res = await googleFetch(
    API_BASE,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    deps
  );
  const json = (await res.json()) as {
    spreadsheetId: string;
    spreadsheetUrl: string;
  };
  return { spreadsheetId: json.spreadsheetId, spreadsheetUrl: json.spreadsheetUrl };
}

/**
 * 指定タブのヘッダ行（A1:Z1）に列名を書き込む。上書き。
 */
export async function writeHeaderRow(
  spreadsheetId: string,
  tab: string,
  headers: readonly string[],
  deps: GoogleApiDeps
): Promise<void> {
  const range = `${tab}!A1`;
  const url = `${API_BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;
  await googleFetch(
    url,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [headers] }),
    },
    deps
  );
}

/**
 * 指定タブに行を 1 件追記する。
 */
export async function appendRow(
  spreadsheetId: string,
  tab: string,
  row: readonly (string | number | boolean | null)[],
  deps: GoogleApiDeps
): Promise<void> {
  const range = `${tab}!A1`;
  const url = `${API_BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
  await googleFetch(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        values: [row.map((v) => (v === null ? '' : v))],
      }),
    },
    deps
  );
}

/**
 * 指定タブの全行を 2 次元配列で取得する。`majorDimension=ROWS`。
 */
export async function getSheetValues(
  spreadsheetId: string,
  tab: string,
  deps: GoogleApiDeps
): Promise<string[][]> {
  const range = `${tab}!A1:Z`;
  const url = `${API_BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}`;
  const res = await googleFetch(url, { method: 'GET' }, deps);
  const json = (await res.json()) as { values?: string[][] };
  return json.values ?? [];
}
