// 出来事の種類ごとに、証跡の列順と無関係な列の空欄を確認する。
import { appendOptimizationLog, type OptimizationLogEvent } from './optimizationLogRepository';
import { SHEET_HEADERS } from '@/domain/sheetsSchema';

const common = { run_id: 'run', recorded_at: 'time', recorded_by: 'person' };
const events: OptimizationLogEvent[] = [
  { ...common, event: 'run_started', app_version: '1', max_hits: 100, max_iterations: 3, seed_count: 2, model: 'fake' },
  { ...common, event: 'run_finished', status: 'achieved', stop_reason: 'conditions_met', final_hits: 90, captured_seed_count: 2 },
  { ...common, event: 'candidate_excluded', candidate_id: 'c', candidate_fingerprint: 'fingerprint' },
  { ...common, event: 'candidate_exclusion_undone', candidate_id: 'c', candidate_fingerprint: null },
];

test.each(events)('$event の列順を維持し、関係しない列は空にする', async (event) => {
  const fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ sheets: [] }) });
  await appendOptimizationLog('sheet', event, { fetch, getAccessToken: async () => 'fake' });
  expect(fetch.mock.calls.map((call) => call[1].method)).toEqual(['GET', 'POST', 'PUT', 'POST']);
  const row = JSON.parse(fetch.mock.calls[3]![1].body).values[0];
  const values = event as unknown as Record<string, unknown>;
  expect(row).toEqual(SHEET_HEADERS.OptimizationLog.map((key) => values[key] == null ? '' : String(values[key])));
  expect(row.slice(0, 5)).toEqual([event.event, 'run', 'time', 'person', event.event === 'run_started' ? '1' : '']);
  expect(row.slice(14, 16)).toEqual(event.event.startsWith('candidate_')
    ? ['c', event.event === 'candidate_excluded' ? 'fingerprint' : ''] : ['', '']);
});
