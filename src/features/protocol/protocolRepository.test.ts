import { SHEET_HEADERS } from '@/domain/sheetsSchema';
import {
  appendProtocol,
  appendProtocolBlocks,
  getNextProtocolVersion,
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
