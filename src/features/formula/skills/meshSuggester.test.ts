import type { ChatMessage, LLMProvider } from '@/lib/llm';
import { suggestMesh } from './meshSuggester';

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

describe('suggestMesh', () => {
  test('提案配列を返す', async () => {
    const json = JSON.stringify({
      suggestions: [
        {
          descriptor: 'Diabetes Mellitus',
          tag_syntax: '"Diabetes Mellitus"[Mesh]',
          rationale: '上位語 Explode',
        },
      ],
    });
    const { provider: p } = provider(json);
    const result = await suggestMesh(
      {
        conceptSummary: 'Diabetes',
        meshRequirements: ['hyperglycemia 上位'],
        seedMeshFrequency: [{ descriptor: 'Diabetes Mellitus', count: 5 }],
      },
      p
    );
    expect(result).toEqual([
      {
        descriptor: 'Diabetes Mellitus',
        tagSyntax: '"Diabetes Mellitus"[Mesh]',
        rationale: '上位語 Explode',
      },
    ]);
  });

  test('seed MeSH 空・要件空でもプロンプトに埋め込む', async () => {
    const { provider: p, calls } = provider('{"suggestions":[]}');
    await suggestMesh(
      { conceptSummary: 'x', meshRequirements: [], seedMeshFrequency: [] },
      p
    );
    const userMsg = calls[0]!.find((m) => m.role === 'user')?.content ?? '';
    expect(userMsg).toContain('(なし)');
    expect(userMsg).toContain('(seed 論文の MeSH なし)');
  });

  test('seed MeSH ありはリストとして埋め込む', async () => {
    const { provider: p, calls } = provider('{"suggestions":[]}');
    await suggestMesh(
      {
        conceptSummary: 'c',
        meshRequirements: ['req'],
        seedMeshFrequency: [
          { descriptor: 'Foo', count: 3 },
          { descriptor: 'Bar', count: 2 },
        ],
      },
      p
    );
    const userMsg = calls[0]!.find((m) => m.role === 'user')?.content ?? '';
    expect(userMsg).toContain('- Foo (×3)');
    expect(userMsg).toContain('- Bar (×2)');
  });

  test('suggestions が無い JSON でも空配列', async () => {
    const { provider: p } = provider('{}');
    await expect(
      suggestMesh({ conceptSummary: '', meshRequirements: [], seedMeshFrequency: [] }, p)
    ).resolves.toEqual([]);
  });

  test('suggestion 要素のフィールド欠落は空文字埋め', async () => {
    const { provider: p } = provider('{"suggestions":[{}]}');
    const result = await suggestMesh(
      { conceptSummary: '', meshRequirements: [], seedMeshFrequency: [] },
      p
    );
    expect(result[0]).toEqual({ descriptor: '', tagSyntax: '', rationale: '' });
  });
});
