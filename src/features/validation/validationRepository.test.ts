import type { ValidationLogEntry } from '@/domain/validationLog';
import { SHEET_HEADERS } from '@/domain/sheetsSchema';
import { appendValidationLog } from './validationRepository';

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function deps(): { fetch: jest.Mock; getAccessToken: jest.Mock } {
  return {
    fetch: jest.fn().mockResolvedValue(jsonResponse({})),
    getAccessToken: jest.fn().mockResolvedValue('t'),
  };
}

const fixture: ValidationLogEntry = {
  validationId: 'val-1',
  versionId: 'v-1',
  checkType: 'final_query',
  totalHits: 5000,
  captureRate: 0.8,
  capturedPmids: '111,222,333,444',
  missedPmids: '555',
  detailRef: null,
  executedAt: '2026-04-19T00:00:00.000Z',
};

describe('appendValidationLog', () => {
  test('SHEET_HEADERS.ValidationLog 順で 1 行追記する', async () => {
    const d = deps();
    await appendValidationLog('sid', fixture, d);
    const [url, init] = d.fetch.mock.calls[0];
    expect(url).toContain('ValidationLog');
    expect(url).toContain(':append');
    const body = JSON.parse((init as RequestInit).body as string) as {
      values: (string | number | boolean | null)[][];
    };
    const row = body.values[0]!;
    expect(row).toHaveLength(SHEET_HEADERS.ValidationLog.length);
    const map: Record<string, string | number | boolean | null> = {};
    SHEET_HEADERS.ValidationLog.forEach((k, i) => {
      map[k] = row[i] as string | number | boolean | null;
    });
    expect(map['validation_id']).toBe('val-1');
    expect(map['check_type']).toBe('final_query');
    expect(map['total_hits']).toBe(5000);
    expect(map['capture_rate']).toBe(0.8);
    // null → '' 変換
    expect(map['detail_ref']).toBe('');
  });

  test('line_hits の場合は capture_rate / captured / missed が null', async () => {
    const d = deps();
    await appendValidationLog(
      'sid',
      {
        ...fixture,
        checkType: 'line_hits',
        totalHits: 100,
        captureRate: null,
        capturedPmids: null,
        missedPmids: null,
      },
      d
    );
    const body = JSON.parse((d.fetch.mock.calls[0][1] as RequestInit).body as string) as {
      values: (string | number | boolean | null)[][];
    };
    const row = body.values[0]!;
    const map: Record<string, string | number | boolean | null> = {};
    SHEET_HEADERS.ValidationLog.forEach((k, i) => {
      map[k] = row[i] as string | number | boolean | null;
    });
    expect(map['check_type']).toBe('line_hits');
    expect(map['capture_rate']).toBe('');
    expect(map['captured_pmids']).toBe('');
    expect(map['missed_pmids']).toBe('');
  });
});
