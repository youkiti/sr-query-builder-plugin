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
  /**
   * この版の作成を支援した LLM モデル ID（例: 'gemini-3.5-flash'）。
   * user_edit では元ドラフトのモデルを引き継ぐ。model 列導入前の行では null
   */
  model: string | null;
}
