// 既存プロジェクトにも追記用タブを用意し、接続ごとに作成処理を共有する。
import { ensureSheetHeaders } from './ensureSheetHeaders';
import { writeHeaderRow } from './sheets';
import { googleFetch, GoogleApiError, type GoogleApiDeps } from './types';

const sessions = new WeakMap<GoogleApiDeps, Map<string, Promise<void>>>();
const unfinishedHeaders = new WeakMap<GoogleApiDeps, Set<string>>();

export function ensureSheetTab(spreadsheetId: string, tab: string, headers: readonly string[],
  deps: GoogleApiDeps): Promise<void> {
  let checks = sessions.get(deps);
  if (!checks) {
    checks = new Map();
    sessions.set(deps, checks);
  }
  let pendingHeaders = unfinishedHeaders.get(deps);
  if (!pendingHeaders) {
    pendingHeaders = new Set();
    unfinishedHeaders.set(deps, pendingHeaders);
  }
  const sessionChecks = checks;
  const initialization = pendingHeaders;
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
      try {
        await googleFetch(`${base}:batchUpdate`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tab } } }] }) }, deps);
        initialization.add(key);
      } catch (error) {
        if (!(error instanceof GoogleApiError && error.status === 400 && /already exists/i.test(error.responseBody))) {
          throw error;
        }
      }
    }
    if (initialization.has(key)) {
      await writeHeaderRow(spreadsheetId, tab, headers, deps);
      initialization.delete(key);
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
