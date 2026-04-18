import { CURRENT_SCHEMA_VERSION, type ProjectMeta } from '@/domain/project';
import { SHEET_HEADERS } from '@/domain/sheetsSchema';
import { getSheetValues, type GoogleApiDeps } from '@/lib/google';

/**
 * 既存スプレッドシートを開くときのメタ情報読み取り + スキーマ検証。
 * requirements.md §4.1「既存プロジェクト選択」に対応。
 */

export class ProjectSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectSchemaError';
  }
}

/**
 * スプレッドシートの Meta タブを読み、ProjectMeta に変換する。
 * スキーマバージョンや列構成が想定と合わないと ProjectSchemaError を throw。
 */
export async function loadProjectMeta(
  spreadsheetId: string,
  deps: GoogleApiDeps
): Promise<ProjectMeta> {
  const rows = await getSheetValues(spreadsheetId, 'Meta', deps);
  if (rows.length === 0) {
    throw new ProjectSchemaError('Meta タブが空です。プロジェクトとして初期化されていません');
  }
  const [header, ...dataRows] = rows;
  const expected = SHEET_HEADERS.Meta;
  if (!header || !sameArray(header, expected)) {
    throw new ProjectSchemaError(
      `Meta タブの列構成が想定と異なります。期待: [${expected.join(', ')}]`
    );
  }
  if (dataRows.length === 0) {
    throw new ProjectSchemaError('Meta タブにデータ行がありません');
  }
  // length > 0 が確定しているので [0] は必ず定義されている
  const row = dataRows[0] as string[];
  const map = toRecord(expected, row);
  // toRecord が expected の全キーを埋めるので非 undefined と扱える
  const schemaVersion = map['schema_version'] as string;
  if (!isSupportedSchemaVersion(schemaVersion)) {
    throw new ProjectSchemaError(
      `サポート外のスキーマバージョンです: ${schemaVersion}（本拡張は ${CURRENT_SCHEMA_VERSION} まで対応）`
    );
  }
  return {
    projectId: map['project_id'] as string,
    projectTitle: map['project_title'] as string,
    spreadsheetId: map['spreadsheet_id'] as string,
    driveFolderId: map['drive_folder_id'] as string,
    schemaVersion,
    createdAt: map['created_at'] as string,
    createdBy: map['created_by'] as string,
  };
}

function sameArray(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function toRecord(header: readonly string[], row: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < header.length; i += 1) {
    const key = header[i];
    if (key !== undefined) {
      result[key] = row[i] ?? '';
    }
  }
  return result;
}

function isSupportedSchemaVersion(version: string): boolean {
  // MVP では完全一致のみサポート。将来の後方互換はメジャーバージョン比較に置き換える
  return version === CURRENT_SCHEMA_VERSION;
}
