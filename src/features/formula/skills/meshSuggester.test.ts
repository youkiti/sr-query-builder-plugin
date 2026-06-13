import type { ChatMessage, LLMProvider } from '@/lib/llm';
import type { SeedMeshSummary } from '@/features/validation';
import { suggestMesh, formatSeedMesh } from './meshSuggester';

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

const emptyMesh: SeedMeshSummary = { seedCount: 0, concepts: [], checkTags: [] };

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
        seedMesh: {
          seedCount: 5,
          concepts: [{ descriptor: 'Diabetes Mellitus', count: 5, majorCount: 0, qualifiers: [] }],
          checkTags: [],
        },
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
    await suggestMesh({ conceptSummary: 'x', meshRequirements: [], seedMesh: emptyMesh }, p);
    const userMsg = calls[0]!.find((m) => m.role === 'user')?.content ?? '';
    expect(userMsg).toContain('(なし)');
    expect(userMsg).toContain('(seed 論文の MeSH なし)');
  });

  test('seed MeSH ありはカバレッジつきで埋め込む', async () => {
    const { provider: p, calls } = provider('{"suggestions":[]}');
    await suggestMesh(
      {
        conceptSummary: 'c',
        meshRequirements: ['req'],
        seedMesh: {
          seedCount: 9,
          concepts: [
            {
              descriptor: 'Foo',
              count: 7,
              majorCount: 3,
              qualifiers: [{ name: 'drug therapy', count: 5 }],
            },
            { descriptor: 'Bar', count: 2, majorCount: 0, qualifiers: [] },
          ],
          checkTags: [{ descriptor: 'Humans', count: 9 }],
        },
      },
      p
    );
    const userMsg = calls[0]!.find((m) => m.role === 'user')?.content ?? '';
    expect(userMsg).toContain('- Foo* (7/9) [qualifiers: drug therapy ×5]');
    expect(userMsg).toContain('- Bar (2/9)');
    expect(userMsg).toContain('チェックタグ');
    expect(userMsg).toContain('Humans (9/9)');
  });

  test('suggestions が無い JSON でも空配列', async () => {
    const { provider: p } = provider('{}');
    await expect(
      suggestMesh({ conceptSummary: '', meshRequirements: [], seedMesh: emptyMesh }, p)
    ).resolves.toEqual([]);
  });

  test('suggestion 要素のフィールド欠落は空文字埋め', async () => {
    const { provider: p } = provider('{"suggestions":[{}]}');
    const result = await suggestMesh(
      { conceptSummary: '', meshRequirements: [], seedMesh: emptyMesh },
      p
    );
    expect(result[0]).toEqual({ descriptor: '', tagSyntax: '', rationale: '' });
  });
});

describe('formatSeedMesh', () => {
  test('seedCount 0 はプレースホルダ', () => {
    expect(formatSeedMesh(emptyMesh)).toBe('(seed 論文の MeSH なし)');
  });

  test('MajorTopic に * を付け、qualifier は先頭 3 件まで', () => {
    const text = formatSeedMesh({
      seedCount: 4,
      concepts: [
        {
          descriptor: 'Heart Failure',
          count: 4,
          majorCount: 2,
          qualifiers: [
            { name: 'drug therapy', count: 3 },
            { name: 'mortality', count: 2 },
            { name: 'physiopathology', count: 1 },
            { name: 'diagnosis', count: 1 },
          ],
        },
      ],
      checkTags: [],
    });
    expect(text).toContain(
      '- Heart Failure* (4/4) [qualifiers: drug therapy ×3, mortality ×2, physiopathology ×1]'
    );
    expect(text).not.toContain('diagnosis');
  });
});
