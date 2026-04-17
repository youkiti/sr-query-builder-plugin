/**
 * Meta タブ 1 行に相当するプロジェクトのアイデンティティ。
 * requirements.md §3.1 `Meta` と対応。
 */
export interface ProjectMeta {
  projectId: string;
  projectTitle: string;
  spreadsheetId: string;
  driveFolderId: string;
  schemaVersion: string;
  createdAt: string;
  createdBy: string;
}

/** 本拡張が書き込む現行スキーマバージョン */
export const CURRENT_SCHEMA_VERSION = '1.0';
