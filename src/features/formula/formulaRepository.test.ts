import { SHEET_HEADERS } from '@/domain/sheetsSchema';
import type { FormulaVersion } from '@/domain/formulaVersion';
import {
  appendFormulaVersion,
  getLatestFormulaVersion,
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
