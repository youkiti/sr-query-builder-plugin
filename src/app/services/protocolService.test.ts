import type { ChatMessage, LLMProvider } from '@/lib/llm';
import { createStore } from '../store';
import { submitProtocol } from './protocolService';

function fakeProvider(text: string): { provider: LLMProvider; calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  return {
    calls,
    provider: {
      providerId: 'gemini',
      model: 'test',
      chat: async (messages) => {
        calls.push([...messages]);
        return { text, tokensIn: null, tokensOut: null, raw: {} };
      },
    },
  };
}

const skillResponse = JSON.stringify({
  framework_type: 'pico',
  research_question: 'RQ',
  inclusion_criteria: 'inc',
  exclusion_criteria: 'exc',
  study_design: 'RCT',
  blocks: [
    { block_label: 'Population', description: '対象' },
    { block_label: 'Intervention', description: '介入' },
  ],
  combination_expression: '#1 AND #2',
});

describe('submitProtocol - manual', () => {
  test('inline + RQ + inclusion + exclusion を結合して LLM に渡し、blocksDraft を更新', async () => {
    const { provider, calls } = fakeProvider(skillResponse);
    const store = createStore();
    const { blocksDraft, parsed } = await submitProtocol(
      {
        sourceType: 'manual',
        researchQuestion: 'rq text',
        inclusionCriteria: 'inc text',
        exclusionCriteria: 'exc text',
        inlineText: '本文',
      },
      { store, provider }
    );
    expect(parsed.sourceType).toBe('manual');
    expect(blocksDraft.blocks).toHaveLength(2);
    expect(blocksDraft.blocks[0]).toEqual({
      blockLabel: 'Population',
      description: '対象',
      aiGenerated: true,
      note: '',
    });
    expect(blocksDraft.combinationExpression).toBe('#1 AND #2');
    expect(store.getState().blocksDraft).toEqual(blocksDraft);

    const userMsg = calls[0]!.find((m) => m.role === 'user')?.content ?? '';
    expect(userMsg).toContain('rq text');
    expect(userMsg).toContain('inc text');
    expect(userMsg).toContain('exc text');
    expect(userMsg).toContain('本文');
  });

  test('空文字フィールドは合体テキストから除外される', async () => {
    const { provider, calls } = fakeProvider(skillResponse);
    const store = createStore();
    await submitProtocol(
      { sourceType: 'manual', inlineText: '本文だけ', researchQuestion: '   ' },
      { store, provider }
    );
    const userMsg = calls[0]!.find((m) => m.role === 'user')?.content ?? '';
    expect(userMsg).toContain('本文だけ');
    expect(userMsg).not.toContain('Research Question');
  });

  test('全フィールド空でもクラッシュしない（extract-protocol が空入力で empty draft を返す）', async () => {
    const { provider } = fakeProvider(''); // 呼ばれないはず
    const store = createStore();
    const result = await submitProtocol({ sourceType: 'manual' }, { store, provider });
    expect(result.blocksDraft.blocks).toHaveLength(1);
    expect(result.blocksDraft.blocks[0]?.blockLabel).toBe('');
  });
});

describe('submitProtocol - markdown', () => {
  test('.md ファイルをパースして LLM に渡す', async () => {
    const { provider, calls } = fakeProvider(skillResponse);
    const store = createStore();
    const result = await submitProtocol(
      {
        sourceType: 'markdown',
        markdownFile: { name: 'protocol.md', text: async () => '# 本文' },
      },
      { store, provider }
    );
    expect(result.parsed.sourceType).toBe('markdown');
    const userMsg = calls[0]!.find((m) => m.role === 'user')?.content ?? '';
    expect(userMsg).toContain('# 本文');
  });

  test('ファイル未指定はエラー', async () => {
    const { provider } = fakeProvider(skillResponse);
    const store = createStore();
    await expect(
      submitProtocol({ sourceType: 'markdown' }, { store, provider })
    ).rejects.toThrow(/markdown/);
  });
});

describe('submitProtocol - docx', () => {
  test('extractor 経由で plainText を取得して LLM に渡す', async () => {
    const { provider, calls } = fakeProvider(skillResponse);
    const store = createStore();
    const buffer = new ArrayBuffer(0);
    const result = await submitProtocol(
      {
        sourceType: 'docx',
        docxFile: { name: 'p.docx', arrayBuffer: async () => buffer },
        docxExtractor: async () => 'docx 本文',
      },
      { store, provider }
    );
    expect(result.parsed.sourceType).toBe('docx');
    const userMsg = calls[0]!.find((m) => m.role === 'user')?.content ?? '';
    expect(userMsg).toContain('docx 本文');
  });

  test('docxFile 未指定はエラー', async () => {
    const { provider } = fakeProvider(skillResponse);
    const store = createStore();
    await expect(
      submitProtocol(
        { sourceType: 'docx', docxExtractor: async () => '' },
        { store, provider }
      )
    ).rejects.toThrow(/\.docx ファイル/);
  });

  test('docxExtractor 未指定はエラー', async () => {
    const { provider } = fakeProvider(skillResponse);
    const store = createStore();
    await expect(
      submitProtocol(
        {
          sourceType: 'docx',
          docxFile: { name: 'p.docx', arrayBuffer: async () => new ArrayBuffer(0) },
        },
        { store, provider }
      )
    ).rejects.toThrow(/DocxExtractor/);
  });
});
