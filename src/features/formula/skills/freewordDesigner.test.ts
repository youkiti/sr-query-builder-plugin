import type { ChatMessage, LLMProvider } from '@/lib/llm';
import { designFreewords } from './freewordDesigner';

function provider(text: string): { provider: LLMProvider; calls: ChatMessage[][] } {
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

describe('designFreewords', () => {
  test('フリーワード提案を返す', async () => {
    const json = JSON.stringify({
      freewords: [
        { query: '"heart failure"[tiab]', rationale: '主要句' },
        { query: 'cardiac failure[tiab]', rationale: '同義句' },
      ],
    });
    const { provider: p } = provider(json);
    const result = await designFreewords(
      {
        conceptSummary: 'Heart failure',
        freewordRequirements: ['同義語'],
        meshSuggestions: [{ descriptor: 'Heart Failure' }],
      },
      p
    );
    expect(result).toEqual([
      { query: '"heart failure"[tiab]', rationale: '主要句' },
      { query: 'cardiac failure[tiab]', rationale: '同義句' },
    ]);
  });

  test('MeSH なし / 要件なしも (なし) として埋め込む', async () => {
    const { provider: p, calls } = provider('{"freewords":[]}');
    await designFreewords(
      { conceptSummary: 'x', freewordRequirements: [], meshSuggestions: [] },
      p
    );
    const userMsg = calls[0]!.find((m) => m.role === 'user')?.content ?? '';
    expect(userMsg).toContain('(なし)');
    expect(userMsg).toContain('(MeSH なし)');
  });

  test('MeSH と要件ありはリスト整形して埋め込む', async () => {
    const { provider: p, calls } = provider('{"freewords":[]}');
    await designFreewords(
      {
        conceptSummary: 'x',
        freewordRequirements: ['drug names'],
        meshSuggestions: [{ descriptor: 'Foo' }, { descriptor: 'Bar' }],
      },
      p
    );
    const userMsg = calls[0]!.find((m) => m.role === 'user')?.content ?? '';
    expect(userMsg).toContain('- drug names');
    expect(userMsg).toContain('- Foo');
    expect(userMsg).toContain('- Bar');
  });

  test('freewords が無いと空配列', async () => {
    const { provider: p } = provider('{}');
    await expect(
      designFreewords(
        { conceptSummary: '', freewordRequirements: [], meshSuggestions: [] },
        p
      )
    ).resolves.toEqual([]);
  });

  test('フリーワード要素のフィールド欠落は空文字埋め', async () => {
    const { provider: p } = provider('{"freewords":[{}]}');
    const result = await designFreewords(
      { conceptSummary: '', freewordRequirements: [], meshSuggestions: [] },
      p
    );
    expect(result[0]).toEqual({ query: '', rationale: '' });
  });
});
