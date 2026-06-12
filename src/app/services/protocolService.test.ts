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
  test('inlineText を LLM に渡し、blocksDraft / protocolDraft を更新', async () => {
    const { provider, calls } = fakeProvider(skillResponse);
    const store = createStore();
    const { blocksDraft, protocolDraft, parsed } = await submitProtocol(
      { sourceType: 'manual', inlineText: '本文' },
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
    // RQ / 組入 / 除外基準は LLM 抽出結果がそのまま protocolDraft に入る
    expect(protocolDraft.researchQuestion).toBe('RQ');
    expect(protocolDraft.inclusionCriteria).toBe('inc');
    expect(protocolDraft.exclusionCriteria).toBe('exc');
    expect(store.getState().blocksDraft).toEqual(blocksDraft);

    const userMsg = calls[0]!.find((m) => m.role === 'user')?.content ?? '';
    expect(userMsg).toContain('本文');
  });

  // §4.2: 確定済みプロトコルを改訂した直後は「未承認の新 draft」になるため、
  // persisted を false に戻す（approveBlocks が true へ戻す）
  test('persisted=true の状態から再送信すると protocolDraftPersisted が false に戻る', async () => {
    const { provider } = fakeProvider(skillResponse);
    const store = createStore({ ...createStore().getState(), protocolDraftPersisted: true });
    await submitProtocol({ sourceType: 'manual', inlineText: '改訂後の本文' }, { store, provider });
    expect(store.getState().protocolDraftPersisted).toBe(false);
  });

  test('空入力でもクラッシュしない（extract-protocol が空入力で empty draft を返す）', async () => {
    const { provider } = fakeProvider(''); // 呼ばれないはず
    const store = createStore();
    const result = await submitProtocol({ sourceType: 'manual' }, { store, provider });
    expect(result.blocksDraft.blocks).toHaveLength(1);
    expect(result.blocksDraft.blocks[0]?.blockLabel).toBe('');
    // §4.2: 空ドラフトは combination '#1'、aiGenerated=true の空ブロック 1 件
    expect(result.blocksDraft.combinationExpression).toBe('#1');
    expect(store.getState().blocksDraft?.blocks).toHaveLength(1);
  });

  test('inlineText="" でも空ドラフト経路を通る', async () => {
    const { provider } = fakeProvider('');
    const store = createStore();
    const result = await submitProtocol(
      { sourceType: 'manual', inlineText: '' },
      { store, provider }
    );
    expect(result.blocksDraft.blocks).toHaveLength(1);
    expect(result.blocksDraft.combinationExpression).toBe('#1');
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
