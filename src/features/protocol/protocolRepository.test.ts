import { SHEET_HEADERS } from '@/domain/sheetsSchema';
import {
  appendProtocol,
  appendProtocolBlocks,
  getNextProtocolVersion,
  getLatestProtocol,
  getProtocolByVersion,
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
