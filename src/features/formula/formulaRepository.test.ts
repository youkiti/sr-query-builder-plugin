import { SHEET_HEADERS } from '@/domain/sheetsSchema';
import type { FormulaVersion } from '@/domain/formulaVersion';
import {
  appendFormulaVersion,
  getFormulaVersionById,
  getLatestFormulaVersion,
  listFormulaVersions,
  updateFormulaVersion,
} from './formulaRepository';

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

const fixture: FormulaVersion = {
  versionId: 'v1',
  parentVersionId: null,
  protocolVersion: 3,
  protocolSnapshotRef: 'https://drive/snap',
  formulaMd: '## PubMed/MEDLINE\n\n```\n#1 x\n```\n',
  createdBy: 'ai_draft',
  createdAt: '2026-04-19T00:00:00.000Z',
  note: null,
};

describe('appendFormulaVersion', () => {
  test('SHEET_HEADERS.FormulaVersions 順で 1 行追記する', async () => {
    const d = deps();
    await appendFormulaVersion('sid', fixture, d);
    const [url, init] = d.fetch.mock.calls[0];
    expect(url).toContain('FormulaVersions');
    expect(url).toContain(':append');
    const body = JSON.parse((init as RequestInit).body as string) as {
      values: (string | number | boolean | null)[][];
    };
    const row = body.values[0]!;
    expect(row).toHaveLength(SHEET_HEADERS.FormulaVersions.length);
    const map: Record<string, string | number | boolean | null> = {};
    SHEET_HEADERS.FormulaVersions.forEach((key, i) => {
      map[key] = row[i] as string | number | boolean | null;
    });
    expect(map['version_id']).toBe('v1');
    expect(map['protocol_version']).toBe(3);
    expect(map['created_by']).toBe('ai_draft');
    // null は appendRow 側で '' に変換される
    expect(map['parent_version_id']).toBe('');
    expect(map['note']).toBe('');
  });

  test('parent_version_id / note ありも列に反映される', async () => {
    const d = deps();
    await appendFormulaVersion(
      'sid',
      { ...fixture, parentVersionId: 'v0', note: 'memo', createdBy: 'user_edit' },
      d
    );
    const body = JSON.parse((d.fetch.mock.calls[0][1] as RequestInit).body as string) as {
      values: (string | number | boolean | null)[][];
    };
    const row = body.values[0]!;
    const map: Record<string, string | number | boolean | null> = {};
    SHEET_HEADERS.FormulaVersions.forEach((key, i) => {
      map[key] = row[i] as string | number | boolean | null;
    });
    expect(map['parent_version_id']).toBe('v0');
    expect(map['note']).toBe('memo');
    expect(map['created_by']).toBe('user_edit');
  });
});

describe('getLatestFormulaVersion', () => {
  const header = [...SHEET_HEADERS.FormulaVersions];
  function row(overrides: Partial<Record<string, string>> = {}): string[] {
    const base: Record<string, string> = {
      version_id: 'v1',
      parent_version_id: '',
      protocol_version: '3',
      protocol_snapshot_ref: 'snap',
      formula_md: '#1 x',
      created_by: 'ai_draft',
      created_at: '2026',
      note: '',
    };
    return header.map((key) => overrides[key] ?? base[key] ?? '');
  }

  test('ヘッダのみなら null', async () => {
    const d = deps({ values: [header] });
    await expect(getLatestFormulaVersion('sid', d)).resolves.toBeNull();
  });

  test('空レスポンス（values なし）でも null', async () => {
    const d = deps({});
    await expect(getLatestFormulaVersion('sid', d)).resolves.toBeNull();
  });

  test('末尾行を FormulaVersion に変換して返す', async () => {
    const d = deps({
      values: [
        header,
        row({ version_id: 'v1', protocol_version: '1' }),
        row({
          version_id: 'v2',
          parent_version_id: 'v1',
          protocol_version: '2',
          note: 'latest',
          created_by: 'user_edit',
        }),
      ],
    });
    const result = await getLatestFormulaVersion('sid', d);
    expect(result?.versionId).toBe('v2');
    expect(result?.parentVersionId).toBe('v1');
    expect(result?.protocolVersion).toBe(2);
    expect(result?.note).toBe('latest');
    expect(result?.createdBy).toBe('user_edit');
  });

  test('created_by が想定外なら ai_draft にフォールバック', async () => {
    const d = deps({ values: [header, row({ created_by: 'unknown' })] });
    const result = await getLatestFormulaVersion('sid', d);
    expect(result?.createdBy).toBe('ai_draft');
  });

  test('protocol_version が数値化不能なら 0 にフォールバック', async () => {
    const d = deps({ values: [header, row({ protocol_version: 'abc' })] });
    const result = await getLatestFormulaVersion('sid', d);
    expect(result?.protocolVersion).toBe(0);
  });

  test('列が足りない短い行でも落ちずに空文字で埋める', async () => {
    const d = deps({ values: [header, ['v-short']] });
    const result = await getLatestFormulaVersion('sid', d);
    expect(result?.versionId).toBe('v-short');
    expect(result?.note).toBeNull();
    expect(result?.createdAt).toBe('');
  });

  test('末尾行が undefined でも落ちずに null を返す', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ values: [header, undefined] }),
      text: async () => '',
    } as Response);
    const d = { fetch: mockFetch, getAccessToken: jest.fn().mockResolvedValue('t') };
    await expect(getLatestFormulaVersion('sid', d)).resolves.toBeNull();
  });
});

describe('listFormulaVersions', () => {
  const header = [...SHEET_HEADERS.FormulaVersions];
  function row(overrides: Partial<Record<string, string>> = {}): string[] {
    const base: Record<string, string> = {
      version_id: 'v1',
      parent_version_id: '',
      protocol_version: '1',
      protocol_snapshot_ref: 'snap',
      formula_md: '#1 x',
      created_by: 'ai_draft',
      created_at: '2026',
      note: '',
    };
    return header.map((key) => overrides[key] ?? base[key] ?? '');
  }

  test('ヘッダのみなら空配列', async () => {
    const d = deps({ values: [header] });
    await expect(listFormulaVersions('sid', d)).resolves.toEqual([]);
  });

  test('values なしでも空配列', async () => {
    const d = deps({});
    await expect(listFormulaVersions('sid', d)).resolves.toEqual([]);
  });

  test('末尾が先頭にくる逆順で返す', async () => {
    const d = deps({
      values: [
        header,
        row({ version_id: 'v1', protocol_version: '1' }),
        row({ version_id: 'v2', parent_version_id: 'v1', protocol_version: '2' }),
        row({ version_id: 'v3', parent_version_id: 'v2', protocol_version: '3' }),
      ],
    });
    const result = await listFormulaVersions('sid', d);
    expect(result.map((v) => v.versionId)).toEqual(['v3', 'v2', 'v1']);
  });

  test('非配列の行は除外する', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ values: [header, row({ version_id: 'v1' }), undefined] }),
      text: async () => '',
    } as Response);
    const d = { fetch: mockFetch, getAccessToken: jest.fn().mockResolvedValue('t') };
    const result = await listFormulaVersions('sid', d);
    expect(result).toHaveLength(1);
    expect(result[0]?.versionId).toBe('v1');
  });
});

describe('getFormulaVersionById', () => {
  const header = [...SHEET_HEADERS.FormulaVersions];
  function row(overrides: Partial<Record<string, string>> = {}): string[] {
    const base: Record<string, string> = {
      version_id: 'v1',
      parent_version_id: '',
      protocol_version: '1',
      protocol_snapshot_ref: 'snap',
      formula_md: '#1 x',
      created_by: 'ai_draft',
      created_at: '2026',
      note: '',
    };
    return header.map((key) => overrides[key] ?? base[key] ?? '');
  }

  test('ヘッダのみなら null', async () => {
    const d = deps({ values: [header] });
    await expect(getFormulaVersionById('sid', 'v1', d)).resolves.toBeNull();
  });

  test('values なしでも null', async () => {
    const d = deps({});
    await expect(getFormulaVersionById('sid', 'v1', d)).resolves.toBeNull();
  });

  test('一致する行を返す', async () => {
    const d = deps({
      values: [
        header,
        row({ version_id: 'v1' }),
        row({ version_id: 'v2', note: 'target' }),
      ],
    });
    const result = await getFormulaVersionById('sid', 'v2', d);
    expect(result?.versionId).toBe('v2');
    expect(result?.note).toBe('target');
  });

  test('一致しなければ null', async () => {
    const d = deps({ values: [header, row({ version_id: 'v1' })] });
    await expect(getFormulaVersionById('sid', 'v9', d)).resolves.toBeNull();
  });

  test('非配列の行はスキップする', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ values: [header, undefined, row({ version_id: 'v1' })] }),
      text: async () => '',
    } as Response);
    const d = { fetch: mockFetch, getAccessToken: jest.fn().mockResolvedValue('t') };
    const result = await getFormulaVersionById('sid', 'v1', d);
    expect(result?.versionId).toBe('v1');
  });
});

describe('updateFormulaVersion', () => {
  const HEADER = SHEET_HEADERS.FormulaVersions;
  // version_id, parent_version_id, protocol_version, protocol_snapshot_ref, formula_md, created_by, created_at, note
  const rowV1 = ['v1', '', '3', 'snap', '## PubMed/MEDLINE\n\n```\n#1 old\n```\n', 'ai_draft', 't0', ''];
  const rowV2 = ['v2', 'v1', '3', 'snap', '## PubMed/MEDLINE\n\n```\n#1 x\n```\n', 'user_edit', 't1', ''];

  test('version_id 一致行を同じ位置に PUT で上書きする（version_id / parent は保持）', async () => {
    const d = deps({ values: [HEADER, rowV1, rowV2] });
    const ok = await updateFormulaVersion(
      'sid',
      'v2',
      { formulaMd: 'NEW MD', createdBy: 'user_edit', createdAt: 't2' },
      d
    );
    expect(ok).toBe(true);
    // 1 回目 GET（getSheetValues）、2 回目 PUT（updateRow）
    const putCall = d.fetch.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'PUT');
    expect(putCall).toBeTruthy();
    const [url, init] = putCall!;
    // v2 はデータ 2 行目 → シート行 3
    expect(url).toContain('FormulaVersions!A3');
    const body = JSON.parse((init as RequestInit).body as string) as { values: string[][] };
    const map: Record<string, unknown> = {};
    HEADER.forEach((key, i) => (map[key] = body.values[0]![i]));
    expect(map['version_id']).toBe('v2');
    expect(map['parent_version_id']).toBe('v1');
    expect(map['formula_md']).toBe('NEW MD');
    expect(map['created_by']).toBe('user_edit');
    expect(map['created_at']).toBe('t2');
  });

  test('該当 version_id が無ければ false（書き込みもしない）', async () => {
    const d = deps({ values: [HEADER, rowV1] });
    const ok = await updateFormulaVersion('sid', 'missing', { formulaMd: 'x' }, d);
    expect(ok).toBe(false);
    expect(d.fetch.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === 'PUT')).toBe(
      false
    );
  });

  test('行が無い（ヘッダのみ）なら false', async () => {
    const d = deps({ values: [HEADER] });
    expect(await updateFormulaVersion('sid', 'v1', { formulaMd: 'x' }, d)).toBe(false);
  });
});
