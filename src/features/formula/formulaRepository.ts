import type { FormulaVersion } from '@/domain/formulaVersion';
import { SHEET_HEADERS } from '@/domain/sheetsSchema';
import { appendRow, getSheetValues, type GoogleApiDeps } from '@/lib/google';

/**
 * FormulaVersions タブの読み書き。requirements.md §3.1 の列順を保ち、
 * 追記型・上書き禁止のポリシー（全てのバージョンを履歴として残す）。
 */

const HEADER = SHEET_HEADERS.FormulaVersions;

export type FormulaVersionRow = FormulaVersion;

/**
 * FormulaVersions タブに 1 行追記する。
 * parent_version_id / note は null で省略可。
 */
export async function appendFormulaVersion(
  spreadsheetId: string,
  version: FormulaVersionRow,
  deps: GoogleApiDeps
): Promise<void> {
  await appendRow(spreadsheetId, 'FormulaVersions', toRow(version), deps);
}

/**
 * 最新の FormulaVersion 行（末尾行）を返す。1 件も無ければ null。
 */
export async function getLatestFormulaVersion(
  spreadsheetId: string,
  deps: GoogleApiDeps
): Promise<FormulaVersion | null> {
  const rows = await getSheetValues(spreadsheetId, 'FormulaVersions', deps);
  if (rows.length <= 1) {
    return null;
  }
  const dataRows = rows.slice(1);
  const last = dataRows[dataRows.length - 1];
  if (!last) {
    return null;
  }
  return fromRow(last);
}

/**
 * FormulaVersions タブの全行を新しい順で返す。ヘッダ行は除外する。
 * #/history 画面で一覧表示に使う。
 */
export async function listFormulaVersions(
  spreadsheetId: string,
  deps: GoogleApiDeps
): Promise<FormulaVersion[]> {
  const rows = await getSheetValues(spreadsheetId, 'FormulaVersions', deps);
  if (rows.length <= 1) {
    return [];
  }
  const dataRows = rows.slice(1).filter((r): r is string[] => Array.isArray(r));
  const versions = dataRows.map((row) => fromRow(row));
  // 末尾が最新なので逆順
  return versions.reverse();
}

/**
 * 指定した version_id に一致する 1 件を返す。存在しなければ null。
 * /history や /edit で特定バージョンを読み込むときに使う。
 */
export async function getFormulaVersionById(
  spreadsheetId: string,
  versionId: string,
  deps: GoogleApiDeps
): Promise<FormulaVersion | null> {
  const rows = await getSheetValues(spreadsheetId, 'FormulaVersions', deps);
  if (rows.length <= 1) {
    return null;
  }
  const idIdx = HEADER.indexOf('version_id');
  /* istanbul ignore if -- HEADER に version_id は必ず含まれる */
  if (idIdx < 0) return null;
  for (const row of rows.slice(1)) {
    if (!Array.isArray(row)) continue;
    /* istanbul ignore next -- noUncheckedIndexedAccess 対策。実配列は範囲内で値を持つ */
    const cell = row[idIdx] ?? '';
    if (cell === versionId) {
      return fromRow(row);
    }
  }
  return null;
}

function toRow(v: FormulaVersionRow): (string | number | boolean | null)[] {
  const map: Record<string, string | number | boolean | null> = {
    version_id: v.versionId,
    parent_version_id: v.parentVersionId,
    protocol_version: v.protocolVersion,
    protocol_snapshot_ref: v.protocolSnapshotRef,
    formula_md: v.formulaMd,
    created_by: v.createdBy,
    created_at: v.createdAt,
    note: v.note,
  };
  return HEADER.map((key) => map[key] ?? null);
}

function fromRow(row: readonly string[]): FormulaVersion {
  const cell = (key: string): string => {
    const idx = HEADER.indexOf(key);
    /* istanbul ignore if -- 呼び出しは HEADER 内の固定キーしか渡さない */
    if (idx < 0) return '';
    return row[idx] ?? '';
  };
  const protocolVersion = Number.parseInt(cell('protocol_version'), 10);
  const createdByRaw = cell('created_by');
  const createdBy: FormulaVersion['createdBy'] =
    createdByRaw === 'ai_draft' || createdByRaw === 'user_edit' || createdByRaw === 'auto_optimize'
      ? createdByRaw
      : 'ai_draft';
  return {
    versionId: cell('version_id'),
    parentVersionId: cell('parent_version_id') === '' ? null : cell('parent_version_id'),
    protocolVersion: Number.isFinite(protocolVersion) ? protocolVersion : 0,
    protocolSnapshotRef: cell('protocol_snapshot_ref'),
    formulaMd: cell('formula_md'),
    createdBy,
    createdAt: cell('created_at'),
    note: cell('note') === '' ? null : cell('note'),
  };
}
