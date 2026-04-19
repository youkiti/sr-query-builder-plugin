import type { ConversionEntry } from '@/domain/conversion';
import { SHEET_HEADERS } from '@/domain/sheetsSchema';
import { appendRow, type GoogleApiDeps } from '@/lib/google';

/**
 * Conversions タブの書き込み。requirements.md §3.1 の列順を保ち、
 * 各 DB 向け変換結果を追記型で保存する。
 */

const HEADER = SHEET_HEADERS.Conversions;

export async function appendConversion(
  spreadsheetId: string,
  entry: ConversionEntry,
  deps: GoogleApiDeps
): Promise<void> {
  await appendRow(spreadsheetId, 'Conversions', toRow(entry), deps);
}

function toRow(entry: ConversionEntry): (string | number | boolean | null)[] {
  const map: Record<string, string | number | boolean | null> = {
    conversion_id: entry.conversionId,
    version_id: entry.versionId,
    target_db: entry.targetDb,
    converted_formula: entry.convertedFormula,
    warnings: entry.warnings,
    exported_at: entry.exportedAt,
  };
  return HEADER.map((key) => map[key] ?? null);
}
