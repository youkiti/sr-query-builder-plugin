import type { ConversionEntry } from '@/domain/conversion';
import { SHEET_HEADERS } from '@/domain/sheetsSchema';
import { appendConversion } from './conversionRepository';

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

const fixture: ConversionEntry = {
  conversionId: 'c1',
  versionId: 'v1',
  targetDb: 'central',
  convertedFormula: '#1 [mh "X"]',
  warnings: null,
  exportedAt: '2026-04-19T00:00:00.000Z',
};

describe('appendConversion', () => {
  test('SHEET_HEADERS.Conversions の列順で 1 行追記する', async () => {
    const d = deps();
    await appendConversion('sid', fixture, d);
    const [url, init] = d.fetch.mock.calls[0];
    expect(url).toContain('Conversions');
    expect(url).toContain(':append');
    const body = JSON.parse((init as RequestInit).body as string) as {
      values: (string | number | boolean | null)[][];
    };
    const row = body.values[0]!;
    expect(row).toHaveLength(SHEET_HEADERS.Conversions.length);
    const map: Record<string, string | number | boolean | null> = {};
    SHEET_HEADERS.Conversions.forEach((key, i) => {
      map[key] = row[i] as string | number | boolean | null;
    });
    expect(map['conversion_id']).toBe('c1');
    expect(map['version_id']).toBe('v1');
    expect(map['target_db']).toBe('central');
    // null → '' 変換
    expect(map['warnings']).toBe('');
  });

  test('warnings ありも反映される', async () => {
    const d = deps();
    await appendConversion(
      'sid',
      { ...fixture, warnings: '所属フィールド [ad] を削除しました' },
      d
    );
    const body = JSON.parse((d.fetch.mock.calls[0][1] as RequestInit).body as string) as {
      values: (string | number | boolean | null)[][];
    };
    const idx = SHEET_HEADERS.Conversions.indexOf('warnings');
    expect(body.values[0]![idx]).toBe('所属フィールド [ad] を削除しました');
  });
});
