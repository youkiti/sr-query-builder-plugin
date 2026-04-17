/**
 * FormulaVersions タブに対応する型。
 * requirements.md §3.1 参照。
 */

export type FormulaCreatedBy = 'ai_draft' | 'user_edit' | 'auto_optimize';

export interface FormulaVersion {
  versionId: string;
  parentVersionId: string | null;
  protocolVersion: number;
  protocolSnapshotRef: string;
  formulaMd: string;
  createdBy: FormulaCreatedBy;
  createdAt: string;
  note: string | null;
}
