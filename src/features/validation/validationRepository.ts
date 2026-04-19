import type { ValidationLogEntry } from '@/domain/validationLog';
import { SHEET_HEADERS } from '@/domain/sheetsSchema';
import { appendRow, type GoogleApiDeps } from '@/lib/google';

/**
 * ValidationLog タブの書き込み。requirements.md §3.1 参照。
 * 検証実行ごとに 1 行追記する追記型ポリシー。
 */

const HEADER = SHEET_HEADERS.ValidationLog;

export async function appendValidationLog(
  spreadsheetId: string,
  entry: ValidationLogEntry,
  deps: GoogleApiDeps
): Promise<void> {
  await appendRow(spreadsheetId, 'ValidationLog', toRow(entry), deps);
}

function toRow(entry: ValidationLogEntry): (string | number | boolean | null)[] {
  const map: Record<string, string | number | boolean | null> = {
    validation_id: entry.validationId,
    version_id: entry.versionId,
    check_type: entry.checkType,
    total_hits: entry.totalHits,
    capture_rate: entry.captureRate,
    captured_pmids: entry.capturedPmids,
    missed_pmids: entry.missedPmids,
    detail_ref: entry.detailRef,
    executed_at: entry.executedAt,
  };
  return HEADER.map((key) => map[key] ?? null);
}
