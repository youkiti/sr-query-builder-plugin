import { SHEET_HEADERS } from '@/domain/sheetsSchema';
import {
  appendProtocol,
  appendProtocolBlocks,
  getNextProtocolVersion,
  getLatestProtocol,
  getProtocolByVersion,
  getProtocolBlocksByVersion,
} from './protocolRepository';
import type { Protocol, ProtocolBlock } from '@/domain/protocol';

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function deps(values?: string[][]): { fetch: jest.Mock; getAccessToken: jest.Mock } {
  return {
    fetch: jest
      .fn()
      .mockResolvedValue(jsonResponse(values === undefined ? {} : { values })),
    getAccessToken: jest.fn().mockResolvedValue('t'),
  };
}

const fixtureProtocol: Protocol = {
  version: 3,
  frameworkType: 'pico',
  researchQuestion: 'RQ',
  inclusionCriteria: 'inc',
  exclusionCriteria: 'exc',
  studyDesign: 'RCT',
  blockCount: 2,
  combinationExpression: '#1 AND #2',
  sourceType: 'manual',
  sourceFilename: null,
  rawTextRef: null,
  rawTextPreview: 'プレビュー',
  rawTextInline: '本文',
  createdAt: '2026-04-19T00:00:00.000Z',
  createdBy: 'me@example.com',
};

describe('getNextProtocolVersion', () => {
  test('Protocol タブが空（ヘッダのみ）なら 1 を返す', async () => {
    const d = deps([[...SHEET_HEADERS.Protocol]]);
    await expect(getNextProtocolVersion('sid', d)).resolves.toBe(1);
  });

  test('完全に空のレスポンスでも 1 を返す', async () => {
    const d = deps([]);
    await expect(getNextProtocolVersion('sid', d)).resolves.toBe(1);
  });

  test('既存最大 version + 1 を返す', async () => {
    const versionIdx = SHEET_HEADERS.Protocol.indexOf('version');
    const row = (n: string): string[] => {
      const r = SHEET_HEADERS.Protocol.map(() => '');
      r[versionIdx] = n;
      return r;
    };
    const d = deps([[...SHEET_HEADERS.Protocol], row('1'), row('5'), row('3')]);
    await expect(getNextProtocolVersion('sid', d)).resolves.toBe(6);
  });

  test('数値化できないセルは無視する', async () => {
    const versionIdx = SHEET_HEADERS.Protocol.indexOf('version');
    const row = (n: string): string[] => {
      const r = SHEET_HEADERS.Protocol.map(() => '');
      r[versionIdx] = n;
      return r;
    };
    const d = deps([[...SHEET_HEADERS.Protocol], row('abc'), row('2')]);
    await expect(getNextProtocolVersion('sid', d)).resolves.toBe(3);
  });

  test('version 列より短い行があってもクラッシュしない', async () => {
    const d = deps([[...SHEET_HEADERS.Protocol], [], ['anything']]);
    await expect(getNextProtocolVersion('sid', d)).resolves.toBe(1);
  });
});

describe('appendProtocol', () => {
  test('SHEET_HEADERS.Protocol の列順で 1 行追記する', async () => {
    const d = deps();
    await appendProtocol('sid', fixtureProtocol, d);
    const [url, init] = (d.fetch as jest.Mock).mock.calls[0];
    expect(url).toContain(':append');
    const body = JSON.parse((init as RequestInit).body as string) as {
      values: (string | number | boolean | null)[][];
    };
    const row = body.values[0]!;
    expect(row).toHaveLength(SHEET_HEADERS.Protocol.length);
    const map: Record<string, string | number | boolean | null> = {};
    SHEET_HEADERS.Protocol.forEach((key, i) => {
      map[key] = row[i] as string | number | boolean | null;
    });
    expect(map['version']).toBe(3);
    expect(map['framework_type']).toBe('pico');
    expect(map['combination_expression']).toBe('#1 AND #2');
    // null は appendRow 側で空文字に変換される
    expect(map['source_filename']).toBe('');
    expect(map['raw_text_ref']).toBe('');
  });
});

describe('getLatestProtocol', () => {
  test('末尾の Protocol 行を返す', async () => {
    const row = (version: string, overrides: Partial<Record<string, string>> = {}): string[] => {
      const base: Record<string, string> = {
        version,
        framework_type: 'pico',
        research_question: `RQ-${version}`,
        inclusion_criteria: 'inc',
        exclusion_criteria: 'exc',
        study_design: 'RCT',
        block_count: '2',
        combination_expression: '#1 AND #2',
        source_type: 'manual',
        source_filename: '',
        raw_text_ref: '',
        raw_text_preview: 'preview',
        raw_text_inline: 'inline',
        created_at: '2026-04-20T00:00:00.000Z',
        created_by: 'me@example.com',
      };
      return SHEET_HEADERS.Protocol.map((key) => overrides[key] ?? base[key] ?? '');
    };
    const d = deps([[...SHEET_HEADERS.Protocol], row('1'), row('2', { source_type: 'docx' })]);
    await expect(getLatestProtocol('sid', d)).resolves.toEqual({
      version: 2,
      frameworkType: 'pico',
      researchQuestion: 'RQ-2',
      inclusionCriteria: 'inc',
      exclusionCriteria: 'exc',
      studyDesign: 'RCT',
      blockCount: 2,
      combinationExpression: '#1 AND #2',
      sourceType: 'docx',
      sourceFilename: null,
      rawTextRef: null,
      rawTextPreview: 'preview',
      rawTextInline: 'inline',
      createdAt: '2026-04-20T00:00:00.000Z',
      createdBy: 'me@example.com',
    });
  });

  test('データ行が無ければ null', async () => {
    const d = deps([[...SHEET_HEADERS.Protocol]]);
    await expect(getLatestProtocol('sid', d)).resolves.toBeNull();
  });

  test('セル欠損・不正値の行でも安全に fromProtocolRow される（null / 0 / 既定値フォールバック）', async () => {
    // ヘッダ長より短い行 + version と block_count が非数値 + framework_type / source_type が未知値
    const short: string[] = ['not-a-number', 'unknown-framework', 'RQ', '', '', '', 'NaN'];
    const d = deps([[...SHEET_HEADERS.Protocol], short]);
    await expect(getLatestProtocol('sid', d)).resolves.toEqual({
      version: 0,
      frameworkType: null,
      researchQuestion: 'RQ',
      inclusionCriteria: null,
      exclusionCriteria: null,
      studyDesign: null,
      blockCount: 0,
      combinationExpression: '',
      sourceType: 'manual',
      sourceFilename: null,
      rawTextRef: null,
      rawTextPreview: null,
      rawTextInline: null,
      createdAt: '',
      createdBy: '',
    });
  });
});

describe('getProtocolByVersion', () => {
  test('指定 version の Protocol 行を返す', async () => {
    const row = (version: string, rq: string): string[] =>
      SHEET_HEADERS.Protocol.map((key) => {
        if (key === 'version') return version;
        if (key === 'framework_type') return 'peco';
        if (key === 'research_question') return rq;
        if (key === 'block_count') return '3';
        if (key === 'source_type') return 'markdown';
        if (key === 'created_at') return '2026';
        if (key === 'created_by') return 'tester';
        return '';
      });
    const d = deps([[...SHEET_HEADERS.Protocol], row('1', 'RQ-1'), row('7', 'RQ-7')]);
    await expect(getProtocolByVersion('sid', 7, d)).resolves.toEqual({
      version: 7,
      frameworkType: 'peco',
      researchQuestion: 'RQ-7',
      inclusionCriteria: null,
      exclusionCriteria: null,
      studyDesign: null,
      blockCount: 3,
      combinationExpression: '',
      sourceType: 'markdown',
      sourceFilename: null,
      rawTextRef: null,
      rawTextPreview: null,
      rawTextInline: null,
      createdAt: '2026',
      createdBy: 'tester',
    });
  });

  test('存在しない version は null', async () => {
    const d = deps([[...SHEET_HEADERS.Protocol]]);
    await expect(getProtocolByVersion('sid', 9, d)).resolves.toBeNull();
  });

  test('データ行はあるが指定 version が無ければ null（version セル空の行を含む）', async () => {
    const row = (version: string): string[] =>
      SHEET_HEADERS.Protocol.map((key) => {
        if (key === 'version') return version;
        if (key === 'research_question') return 'RQ';
        if (key === 'block_count') return '1';
        if (key === 'source_type') return 'manual';
        if (key === 'created_at') return '2026';
        if (key === 'created_by') return 'tester';
        return '';
      });
    // 空行（row[versionIdx] が undefined）も混ぜることで `row?.[versionIdx] ?? ''` の fallback を経由させる
    const d = deps([[...SHEET_HEADERS.Protocol], [], row('1'), row('2')]);
    await expect(getProtocolByVersion('sid', 99, d)).resolves.toBeNull();
  });
});

describe('appendProtocolBlocks', () => {
  function block(overrides: Partial<ProtocolBlock>): Omit<ProtocolBlock, 'version'> {
    return {
      blockIndex: 1,
      blockLabel: 'Population',
      description: '対象集団',
      aiGenerated: true,
      note: null,
      ...overrides,
    };
  }

  test('blocks の件数分 fetch が呼ばれる', async () => {
    const d = deps();
    await appendProtocolBlocks(
      'sid',
      3,
      [block({ blockIndex: 1 }), block({ blockIndex: 2, blockLabel: 'Intervention' })],
      d
    );
    expect((d.fetch as jest.Mock).mock.calls).toHaveLength(2);
    const body = JSON.parse(
      ((d.fetch as jest.Mock).mock.calls[0][1] as RequestInit).body as string
    ) as { values: (string | number | boolean | null)[][] };
    const row = body.values[0]!;
    const map: Record<string, string | number | boolean | null> = {};
    SHEET_HEADERS.ProtocolBlocks.forEach((key, i) => {
      map[key] = row[i] as string | number | boolean | null;
    });
    expect(map['version']).toBe(3);
    expect(map['block_index']).toBe(1);
    expect(map['block_label']).toBe('Population');
    expect(map['ai_generated']).toBe(true);
    expect(map['note']).toBe('');
  });

  test('0 件は許可しない', async () => {
    const d = deps();
    await expect(appendProtocolBlocks('sid', 1, [], d)).rejects.toThrow(/件数が不正/);
  });

  test('6 件以上は許可しない', async () => {
    const d = deps();
    const blocks = Array.from({ length: 6 }, (_, i) => block({ blockIndex: i + 1 }));
    await expect(appendProtocolBlocks('sid', 1, blocks, d)).rejects.toThrow(/件数が不正/);
  });
});

describe('getProtocolBlocksByVersion', () => {
  function blockRow(overrides: {
    version?: string;
    block_index?: string;
    block_label?: string;
    description?: string;
    ai_generated?: string;
    note?: string;
  }): string[] {
    return SHEET_HEADERS.ProtocolBlocks.map((key) => {
      const k = key as keyof typeof overrides;
      if (k in overrides) return overrides[k] ?? '';
      if (key === 'version') return '1';
      if (key === 'block_index') return '1';
      if (key === 'block_label') return 'Population';
      if (key === 'description') return '対象集団';
      if (key === 'ai_generated') return 'TRUE';
      return '';
    });
  }

  test('指定 version のブロックを block_index 昇順で返す', async () => {
    const d = deps([
      [...SHEET_HEADERS.ProtocolBlocks],
      blockRow({ version: '2', block_index: '2', block_label: 'Intervention', description: '介入' }),
      blockRow({ version: '2', block_index: '1', block_label: 'Population', description: '対象' }),
      blockRow({ version: '1', block_index: '1', block_label: 'Other', description: '別版' }),
    ]);
    const result = await getProtocolBlocksByVersion('sid', 2, d);
    expect(result).toHaveLength(2);
    expect(result[0]!.blockIndex).toBe(1);
    expect(result[0]!.blockLabel).toBe('Population');
    expect(result[1]!.blockIndex).toBe(2);
    expect(result[1]!.blockLabel).toBe('Intervention');
  });

  test('存在しない version は []', async () => {
    const d = deps([[...SHEET_HEADERS.ProtocolBlocks], blockRow({ version: '1' })]);
    await expect(getProtocolBlocksByVersion('sid', 99, d)).resolves.toEqual([]);
  });

  test('データ行が無ければ []', async () => {
    const d = deps([[...SHEET_HEADERS.ProtocolBlocks]]);
    await expect(getProtocolBlocksByVersion('sid', 1, d)).resolves.toEqual([]);
  });

  test('ai_generated が TRUE 文字列なら true、それ以外は false', async () => {
    const d = deps([
      [...SHEET_HEADERS.ProtocolBlocks],
      blockRow({ version: '3', block_index: '1', ai_generated: 'TRUE' }),
      blockRow({ version: '3', block_index: '2', ai_generated: 'FALSE' }),
    ]);
    const result = await getProtocolBlocksByVersion('sid', 3, d);
    expect(result[0]!.aiGenerated).toBe(true);
    expect(result[1]!.aiGenerated).toBe(false);
  });

  test('note が空文字なら null に変換される', async () => {
    const d = deps([
      [...SHEET_HEADERS.ProtocolBlocks],
      blockRow({ version: '1', note: '' }),
    ]);
    const result = await getProtocolBlocksByVersion('sid', 1, d);
    expect(result[0]!.note).toBeNull();
  });

  test('note に値があればそのまま返す', async () => {
    const d = deps([
      [...SHEET_HEADERS.ProtocolBlocks],
      blockRow({ version: '1', note: 'メモ' }),
    ]);
    const result = await getProtocolBlocksByVersion('sid', 1, d);
    expect(result[0]!.note).toBe('メモ');
  });
});
