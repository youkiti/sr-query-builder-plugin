import type { SeedPaper } from '@/domain/seedPaper';
import { SHEET_HEADERS } from '@/domain/sheetsSchema';
import {
  appendSeedPaper,
  hasDuplicateSeedPmid,
  hasValidSeedPmid,
  invalidateSeedRow,
  listSeedPapers,
  listSeedPapersWithRows,
  setSeedEnabledRow,
} from './seedRepository';

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function deps(body?: unknown): { fetch: jest.Mock; getAccessToken: jest.Mock } {
  return {
    fetch: jest.fn().mockResolvedValue(jsonResponse(body ?? {})),
    getAccessToken: jest.fn().mockResolvedValue('t'),
  };
}

function seedFixture(overrides: Partial<SeedPaper> = {}): SeedPaper {
  return {
    pmid: '12345678',
    title: 'Study of X',
    year: 2022,
    source: 'initial',
    ingestFormat: 'pmid_direct',
    originalDb: null,
    isValid: true,
    exclusionReason: null,
    originalPayloadRef: null,
    userDecision: null,
    decidedAt: null,
    decidedBy: null,
    note: null,
    ...overrides,
  };
}

describe('appendSeedPaper', () => {
  test('SHEET_HEADERS.SeedPapers 順で 1 行追記する', async () => {
    const d = deps();
    await appendSeedPaper('sid', seedFixture(), d);
    const [url, init] = d.fetch.mock.calls[0];
    expect(url).toContain('SeedPapers');
    expect(url).toContain(':append');
    const body = JSON.parse((init as RequestInit).body as string) as {
      values: (string | number | boolean | null)[][];
    };
    const row = body.values[0]!;
    expect(row).toHaveLength(SHEET_HEADERS.SeedPapers.length);
    const map: Record<string, string | number | boolean | null> = {};
    SHEET_HEADERS.SeedPapers.forEach((k, i) => {
      map[k] = row[i] as string | number | boolean | null;
    });
    expect(map['pmid']).toBe('12345678');
    expect(map['is_valid']).toBe(true);
    expect(map['year']).toBe(2022);
    expect(map['original_db']).toBe('');
  });

  test('ris_no_pmid（PMID=null）も列順を保つ', async () => {
    const d = deps();
    await appendSeedPaper(
      'sid',
      seedFixture({
        pmid: null,
        ingestFormat: 'ris_no_pmid',
        isValid: false,
        exclusionReason: 'no_pmid_resolved',
        originalDb: 'Embase',
        originalPayloadRef: 'https://drive/abc',
      }),
      d
    );
    const body = JSON.parse((d.fetch.mock.calls[0][1] as RequestInit).body as string) as {
      values: (string | number | boolean | null)[][];
    };
    const row = body.values[0]!;
    const map: Record<string, string | number | boolean | null> = {};
    SHEET_HEADERS.SeedPapers.forEach((k, i) => {
      map[k] = row[i] as string | number | boolean | null;
    });
    expect(map['pmid']).toBe('');
    expect(map['ingest_format']).toBe('ris_no_pmid');
    expect(map['is_valid']).toBe(false);
    expect(map['exclusion_reason']).toBe('no_pmid_resolved');
    expect(map['original_db']).toBe('Embase');
    expect(map['original_payload_ref']).toBe('https://drive/abc');
  });
});

describe('listSeedPapers', () => {
  const header = [...SHEET_HEADERS.SeedPapers];
  function row(overrides: Partial<Record<string, string>> = {}): string[] {
    const base: Record<string, string> = {
      pmid: '111',
      title: 'T',
      year: '2020',
      source: 'initial',
      ingest_format: 'pmid_direct',
      original_db: '',
      is_valid: 'true',
      exclusion_reason: '',
      original_payload_ref: '',
      user_decision: '',
      decided_at: '',
      decided_by: '',
      note: '',
    };
    return header.map((key) => overrides[key] ?? base[key] ?? '');
  }

  test('ヘッダのみなら []', async () => {
    const d = deps({ values: [header] });
    await expect(listSeedPapers('sid', d)).resolves.toEqual([]);
  });

  test('values 未定義でも []', async () => {
    const d = deps({});
    await expect(listSeedPapers('sid', d)).resolves.toEqual([]);
  });

  test('複数行をパースする', async () => {
    const d = deps({
      values: [
        header,
        row(),
        row({ pmid: '222', is_valid: 'false', exclusion_reason: 'pmid_not_found' }),
        row({
          pmid: '',
          ingest_format: 'ris_no_pmid',
          is_valid: 'false',
          exclusion_reason: 'no_pmid_resolved',
          original_db: 'Scopus',
          original_payload_ref: 'https://drive/x',
        }),
        row({
          pmid: '333',
          source: 'interactive',
          ingest_format: 'interactive',
          user_decision: 'include',
          decided_at: '2026-04-19',
          decided_by: 'me@x',
          note: 'memo',
        }),
      ],
    });
    const seeds = await listSeedPapers('sid', d);
    expect(seeds).toHaveLength(4);
    expect(seeds[0]?.pmid).toBe('111');
    expect(seeds[0]?.isValid).toBe(true);
    expect(seeds[1]?.exclusionReason).toBe('pmid_not_found');
    expect(seeds[2]?.pmid).toBeNull();
    expect(seeds[2]?.ingestFormat).toBe('ris_no_pmid');
    expect(seeds[2]?.originalDb).toBe('Scopus');
    expect(seeds[3]?.source).toBe('interactive');
    expect(seeds[3]?.userDecision).toBe('include');
    expect(seeds[3]?.note).toBe('memo');
  });

  test('想定外の enum 値は既定値にフォールバック', async () => {
    const d = deps({
      values: [
        header,
        row({
          source: 'unknown',
          ingest_format: 'unknown',
          exclusion_reason: 'bogus',
          user_decision: 'bogus',
          year: 'not-a-year',
        }),
      ],
    });
    const seeds = await listSeedPapers('sid', d);
    expect(seeds[0]?.source).toBe('initial');
    expect(seeds[0]?.ingestFormat).toBe('pmid_direct');
    expect(seeds[0]?.exclusionReason).toBeNull();
    expect(seeds[0]?.userDecision).toBeNull();
    expect(seeds[0]?.year).toBeNull();
  });

  test('year 列が未定義でも落ちない', async () => {
    const d = deps({
      values: [header, row({ year: '' })],
    });
    const seeds = await listSeedPapers('sid', d);
    expect(seeds[0]?.year).toBeNull();
  });

  test('短い行（末尾セルが不足）でも空文字で埋める', async () => {
    const d = deps({ values: [header, ['999']] });
    const seeds = await listSeedPapers('sid', d);
    expect(seeds[0]?.pmid).toBe('999');
    expect(seeds[0]?.title).toBeNull();
    expect(seeds[0]?.year).toBeNull();
  });
});

describe('listSeedPapersWithRows', () => {
  const header = [...SHEET_HEADERS.SeedPapers];
  function row(overrides: Partial<Record<string, string>> = {}): string[] {
    const base: Record<string, string> = {
      pmid: '111',
      title: 'T',
      year: '2020',
      source: 'initial',
      ingest_format: 'pmid_direct',
      original_db: '',
      is_valid: 'true',
      exclusion_reason: '',
      original_payload_ref: '',
      user_decision: '',
      decided_at: '',
      decided_by: '',
      note: '',
    };
    return header.map((key) => overrides[key] ?? base[key] ?? '');
  }

  test('ヘッダのみなら []', async () => {
    const d = deps({ values: [header] });
    await expect(listSeedPapersWithRows('sid', d)).resolves.toEqual([]);
  });

  test('各行に 1 始まりのシート行番号を添える（ヘッダ=1、データ 1 件目=2）', async () => {
    const d = deps({
      values: [
        header,
        row({ pmid: '111' }),
        row({ pmid: '222', is_valid: 'false', exclusion_reason: 'pmid_not_found' }),
      ],
    });
    const rows = await listSeedPapersWithRows('sid', d);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.rowIndex).toBe(2);
    expect(rows[0]?.seed.pmid).toBe('111');
    expect(rows[1]?.rowIndex).toBe(3);
    expect(rows[1]?.seed.exclusionReason).toBe('pmid_not_found');
  });
});

describe('invalidateSeedRow', () => {
  test('指定行番号を A{n}:Z{n} に PUT し、is_valid=false / user_removed に書き換える', async () => {
    const d = deps();
    const updated = await invalidateSeedRow('sid', 4, seedFixture({ pmid: '111' }), d);
    const [url, init] = d.fetch.mock.calls[0];
    expect(decodeURIComponent(url as string)).toContain('SeedPapers!A4:Z4?valueInputOption=RAW');
    expect((init as RequestInit).method).toBe('PUT');
    const body = JSON.parse((init as RequestInit).body as string) as {
      values: (string | number | boolean | null)[][];
    };
    const map: Record<string, string | number | boolean | null> = {};
    SHEET_HEADERS.SeedPapers.forEach((k, i) => {
      map[k] = body.values[0]![i] as string | number | boolean | null;
    });
    expect(map['is_valid']).toBe(false);
    expect(map['exclusion_reason']).toBe('user_removed');
    expect(map['pmid']).toBe('111');
    // 戻り値も書き換え後の seed
    expect(updated.isValid).toBe(false);
    expect(updated.exclusionReason).toBe('user_removed');
  });
});

describe('setSeedEnabledRow', () => {
  test('enabled=false: is_valid=false / user_disabled に書き換える', async () => {
    const d = deps();
    const updated = await setSeedEnabledRow('sid', 4, seedFixture({ pmid: '111' }), false, d);
    const [url, init] = d.fetch.mock.calls[0];
    expect(decodeURIComponent(url as string)).toContain('SeedPapers!A4:Z4?valueInputOption=RAW');
    expect((init as RequestInit).method).toBe('PUT');
    const body = JSON.parse((init as RequestInit).body as string) as {
      values: (string | number | boolean | null)[][];
    };
    const map: Record<string, string | number | boolean | null> = {};
    SHEET_HEADERS.SeedPapers.forEach((k, i) => {
      map[k] = body.values[0]![i] as string | number | boolean | null;
    });
    expect(map['is_valid']).toBe(false);
    expect(map['exclusion_reason']).toBe('user_disabled');
    expect(updated.isValid).toBe(false);
    expect(updated.exclusionReason).toBe('user_disabled');
  });

  test('enabled=true: is_valid=true / exclusion_reason=null に戻す', async () => {
    const d = deps();
    const disabled = seedFixture({
      pmid: '111',
      isValid: false,
      exclusionReason: 'user_disabled',
    });
    const updated = await setSeedEnabledRow('sid', 4, disabled, true, d);
    const [, init] = d.fetch.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string) as {
      values: (string | number | boolean | null)[][];
    };
    const map: Record<string, string | number | boolean | null> = {};
    SHEET_HEADERS.SeedPapers.forEach((k, i) => {
      map[k] = body.values[0]![i] as string | number | boolean | null;
    });
    expect(map['is_valid']).toBe(true);
    // null セルは Sheets へは空文字として書き込まれる（lib/google の serialize 仕様）
    expect(map['exclusion_reason']).toBe('');
    expect(updated.isValid).toBe(true);
    expect(updated.exclusionReason).toBeNull();
  });
});

describe('hasValidSeedPmid', () => {
  const header = [...SHEET_HEADERS.SeedPapers];
  function row(overrides: Partial<Record<string, string>> = {}): string[] {
    const base: Record<string, string> = {
      pmid: '111',
      title: 'T',
      year: '2020',
      source: 'initial',
      ingest_format: 'pmid_direct',
      original_db: '',
      is_valid: 'true',
      exclusion_reason: '',
      original_payload_ref: '',
      user_decision: '',
      decided_at: '',
      decided_by: '',
      note: '',
    };
    return header.map((key) => overrides[key] ?? base[key] ?? '');
  }

  test('有効行があれば true', async () => {
    const d = deps({ values: [header, row({ pmid: '12345' })] });
    await expect(hasValidSeedPmid('sid', '12345', d)).resolves.toBe(true);
  });

  test('無効行しかなければ false', async () => {
    const d = deps({
      values: [header, row({ pmid: '12345', is_valid: 'false' })],
    });
    await expect(hasValidSeedPmid('sid', '12345', d)).resolves.toBe(false);
  });

  test('該当 PMID が無ければ false', async () => {
    const d = deps({ values: [header, row({ pmid: '999' })] });
    await expect(hasValidSeedPmid('sid', '12345', d)).resolves.toBe(false);
  });
});

describe('hasDuplicateSeedPmid', () => {
  const header = [...SHEET_HEADERS.SeedPapers];
  function row(overrides: Partial<Record<string, string>> = {}): string[] {
    const base: Record<string, string> = {
      pmid: '111',
      title: 'T',
      year: '2020',
      source: 'initial',
      ingest_format: 'pmid_direct',
      original_db: '',
      is_valid: 'true',
      exclusion_reason: '',
      original_payload_ref: '',
      user_decision: '',
      decided_at: '',
      decided_by: '',
      note: '',
    };
    return header.map((key) => overrides[key] ?? base[key] ?? '');
  }

  test('有効行があれば true', async () => {
    const d = deps({ values: [header, row({ pmid: '12345' })] });
    await expect(hasDuplicateSeedPmid('sid', '12345', d)).resolves.toBe(true);
  });

  test('user_removed 行があれば true（一度削除した事実を重複扱いにする）', async () => {
    const d = deps({
      values: [header, row({ pmid: '12345', is_valid: 'false', exclusion_reason: 'user_removed' })],
    });
    await expect(hasDuplicateSeedPmid('sid', '12345', d)).resolves.toBe(true);
  });

  test('user_disabled 行があれば true（チェックボックスで再有効化する前提のため重複扱い）', async () => {
    const d = deps({
      values: [
        header,
        row({ pmid: '12345', is_valid: 'false', exclusion_reason: 'user_disabled' }),
      ],
    });
    await expect(hasDuplicateSeedPmid('sid', '12345', d)).resolves.toBe(true);
  });

  test('pmid_not_found 行のみなら false（再試行で再 ingest する前提）', async () => {
    const d = deps({
      values: [header, row({ pmid: '12345', is_valid: 'false', exclusion_reason: 'pmid_not_found' })],
    });
    await expect(hasDuplicateSeedPmid('sid', '12345', d)).resolves.toBe(false);
  });

  test('duplicate_pmid 行のみなら false（二重カウントしない）', async () => {
    const d = deps({
      values: [header, row({ pmid: '12345', is_valid: 'false', exclusion_reason: 'duplicate_pmid' })],
    });
    await expect(hasDuplicateSeedPmid('sid', '12345', d)).resolves.toBe(false);
  });

  test('該当 PMID が無ければ false', async () => {
    const d = deps({ values: [header, row({ pmid: '999' })] });
    await expect(hasDuplicateSeedPmid('sid', '12345', d)).resolves.toBe(false);
  });
});
