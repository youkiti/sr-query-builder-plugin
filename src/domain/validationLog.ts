/**
 * ValidationLog タブに対応する型。
 * requirements.md §3.1 参照。
 */

export type ValidationCheckType = 'line_hits' | 'final_query' | 'mesh' | 'block_overlap';

export interface ValidationLogEntry {
  validationId: string;
  versionId: string;
  checkType: ValidationCheckType;
  totalHits: number | null;
  captureRate: number | null;
  capturedPmids: string | null;
  missedPmids: string | null;
  detailRef: string | null;
  executedAt: string;
}
