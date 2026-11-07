// 自動調整と人の除外判断の証跡を、出来事ごとに一行追記する。
import { SHEET_HEADERS } from '@/domain/sheetsSchema';
import { appendRow, ensureSheetTab, type GoogleApiDeps } from '@/lib/google';

type CommonEvent = { run_id: string; recorded_at: string; recorded_by?: string | null };
export type OptimizationLogEvent = CommonEvent & (
  | { event: 'run_started'; app_version?: string | null; max_hits: number; max_iterations: number;
    seed_count: number; model: string; resumed_from_run_id?: string }
  | { event: 'run_finished'; status: 'achieved' | 'needs_review' | 'stopped' | 'error'; stop_reason?: string;
    final_hits?: number; captured_seed_count?: number; note?: string }
  | { event: 'candidate_excluded' | 'candidate_exclusion_undone'; candidate_id: string; candidate_fingerprint?: string | null }
);

export async function appendOptimizationLog(spreadsheetId: string, event: OptimizationLogEvent, deps: GoogleApiDeps): Promise<void> {
  const headers = SHEET_HEADERS.OptimizationLog;
  const values: Record<string, string | number | null | undefined> = { ...event };
  const row = headers.map((key) => values[key] == null ? '' : String(values[key]));
  await ensureSheetTab(spreadsheetId, 'OptimizationLog', headers, deps);
  await appendRow(spreadsheetId, 'OptimizationLog', row, deps);
}
