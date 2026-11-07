// 既存プロジェクトにも追記用タブを用意し、接続ごとに作成処理を共有する。
import { ensureSheetHeaders } from './ensureSheetHeaders';
import { getSheetValues, writeHeaderRow } from './sheets';
import { googleFetch, GoogleApiError, type GoogleApiDeps } from './types';

const sessions = new WeakMap<GoogleApiDeps, Map<string, Promise<void>>>();

export function ensureSheetTab(spreadsheetId: string, tab: string, headers: readonly string[],
  deps: GoogleApiDeps): Promise<void> {
  let checks = sessions.get(deps);
  if (!checks) {
    checks = new Map();
    sessions.set(deps, checks);
  }
  const sessionChecks = checks;
  const key = `${spreadsheetId}/${tab}`;
  const existing = checks.get(key);
  if (existing) {
    return existing;
  }
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`;
  const check = (async () => {
    const response = await googleFetch(`${base}?fields=sheets.properties.title`, { method: 'GET' }, deps);
    const data = await response.json() as { sheets?: { properties: { title: string } }[] };
    if (!data.sheets?.some((sheet) => sheet.properties.title === tab)) {
      let created = false;
      try {
        await googleFetch(`${base}:batchUpdate`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tab } } }] }) }, deps);
        created = true;
      } catch (error) {
        if (!(error instanceof GoogleApiError && error.status === 400 && /already exists/i.test(error.responseBody))) {
          throw error;
        }
      }
      if (created) {
        await writeHeaderRow(spreadsheetId, tab, headers, deps);
        return;
      }
    }
    const rows = await getSheetValues(spreadsheetId, tab, deps, '1:1');
    if (!rows[0]?.length) {
      await writeHeaderRow(spreadsheetId, tab, headers, deps);
    } else {
      await ensureSheetHeaders(spreadsheetId, tab, headers, deps, true);
    }
  })().catch((error: unknown) => {
    sessionChecks.delete(key);
    throw error;
  });
  checks.set(key, check);
  return check;
}
