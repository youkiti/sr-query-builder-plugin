import type { ChatMessage, LLMProvider } from '@/lib/llm';
import { designBlock } from './blockDesigner';

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

describe('designBlock', () => {
  test('概念骨格を構造化して返す', async () => {
    const json = JSON.stringify({
      concept_summary: 'Adults with type 2 diabetes',
      mesh_requirements: ['Diabetes Mellitus, Type 2'],
      freeword_requirements: ['type 2 diabetes', 'T2DM'],
      rationale: '成人 2 型糖尿病に絞るため両軸で拾う',
    });
    const { provider: p } = provider(json);
    const result = await designBlock(
      { blockLabel: 'Population', description: '成人 T2DM', researchQuestion: 'RQ' },
      p
    );
    expect(result).toEqual({
      conceptSummary: 'Adults with type 2 diabetes',
      meshRequirements: ['Diabetes Mellitus, Type 2'],
      freewordRequirements: ['type 2 diabetes', 'T2DM'],
      rationale: '成人 2 型糖尿病に絞るため両軸で拾う',
    });
  });

  test('プロンプトに RQ / label / description が埋め込まれる', async () => {
    const { provider: p, calls } = provider(
      JSON.stringify({ concept_summary: '', mesh_requirements: [], freeword_requirements: [] })
    );
    await designBlock(
      { blockLabel: 'Intervention', description: 'SGLT2', researchQuestion: 'A vs B' },
      p
    );
    const userMsg = calls[0]!.find((m) => m.role === 'user')?.content ?? '';
    expect(userMsg).toContain('Intervention');
    expect(userMsg).toContain('SGLT2');
    expect(userMsg).toContain('A vs B');
    expect(userMsg).not.toContain('{{RQ}}');
  });

  test('seedTitles はリストとして埋め込み、空なら (なし)', async () => {
    const { provider: withTitles, calls: titleCalls } = provider('{}');
    await designBlock(
      {
        blockLabel: 'P',
        description: 'd',
        researchQuestion: 'rq',
        seedTitles: ['Effect of sacubitril on heart failure', 'PARADIGM-HF trial'],
      },
      withTitles
    );
    const withMsg = titleCalls[0]!.find((m) => m.role === 'user')?.content ?? '';
    expect(withMsg).toContain('- Effect of sacubitril on heart failure');
    expect(withMsg).toContain('- PARADIGM-HF trial');
    expect(withMsg).not.toContain('{{SEED_TITLES}}');

    const { provider: noTitles, calls: noCalls } = provider('{}');
    await designBlock({ blockLabel: 'P', description: 'd', researchQuestion: 'rq' }, noTitles);
    const noMsg = noCalls[0]!.find((m) => m.role === 'user')?.content ?? '';
    expect(noMsg).toContain('(なし)');
  });

  test('欠落フィールドは安全な既定で埋める', async () => {
    const { provider: p } = provider('{}');
    const result = await designBlock(
      { blockLabel: '', description: '', researchQuestion: '' },
      p
    );
    expect(result).toEqual({
      conceptSummary: '',
      meshRequirements: [],
      freewordRequirements: [],
      rationale: '',
    });
  });
});
