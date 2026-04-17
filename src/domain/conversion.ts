/**
 * Conversions タブに対応する型。
 * requirements.md §3.1 参照。
 */

export type TargetDatabase = 'central' | 'dialog' | 'clinicaltrials' | 'ictrp';

export interface ConversionEntry {
  conversionId: string;
  versionId: string;
  targetDb: TargetDatabase;
  convertedFormula: string;
  warnings: string | null;
  exportedAt: string;
}
