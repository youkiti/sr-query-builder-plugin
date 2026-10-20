import { getSheetValues, writeHeaderRow } from './sheets';
import type { GoogleApiDeps } from './types';

const sessions = new WeakMap<GoogleApiDeps, Map<string, Promise<void>>>();

/** 同じ接続・シートの見出し確認を共有し、失敗時は次回に再試行する。 */
export function ensureSheetHeaders(spreadsheetId: string, tab: string, headers: readonly string[],
  deps: GoogleApiDeps): Promise<void> {
  let checks = sessions.get(deps);
  if (!checks) { checks = new Map(); sessions.set(deps, checks); }
  const sessionChecks = checks;
  const key = `${spreadsheetId}/${tab}`;
  const existing = checks.get(key);
  if (existing) return existing;
  const check = (async () => {
    const rows = await getSheetValues(spreadsheetId, tab, deps, '1:1');
    const current = rows[0];
    if (!current?.length || current.length > headers.length || current.some((value, i) => value !== headers[i])) {
      console.warn('シートの見出しが想定と異なるため更新しませんでした');
      return;
    }
    if (current.length < headers.length) await writeHeaderRow(spreadsheetId, tab, headers, deps);
  })().catch(() => {
    sessionChecks.delete(key);
    // 応答本文や認証情報を出さず、次回の追記時に再確認する。
    console.warn('シートの見出しを確認・更新できなかったため、追記を続けます');
  });
  checks.set(key, check);
  return check;
}
