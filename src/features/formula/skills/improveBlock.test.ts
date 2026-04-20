import type { ChatMessage, LLMProvider } from '@/lib/llm';
import { improveBlockExpression } from './improveBlock';

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

describe('improveBlockExpression', () => {
  test('提案 expression と rationale を返す（前後空白を trim）', async () => {
    const json = JSON.stringify({
      proposed_expression: '  "diabetes mellitus"[Mesh] OR diabetic*[tiab]  ',
      rationale: '子孫 MeSH を吸収するため階層上位を採用',
    });
    const { provider: p } = provider(json);
    const result = await improveBlockExpression(
      {
        currentExpression: 'diabetes[tiab]',
        blockLabel: 'Population',
        blockDescription: '糖尿病',
        researchQuestion: 'RQ',
      },
      p
    );
    expect(result).toEqual({
      proposedExpression: '"diabetes mellitus"[Mesh] OR diabetic*[tiab]',
      rationale: '子孫 MeSH を吸収するため階層上位を採用',
    });
  });

  test('プロンプトに現式 / label / description / RQ が埋め込まれる', async () => {
    const { provider: p, calls } = provider(JSON.stringify({}));
    await improveBlockExpression(
      {
        currentExpression: 'metformin[tiab]',
        blockLabel: 'Intervention',
        blockDescription: '経口糖尿病薬',
        researchQuestion: 'Metformin vs sulfonylurea',
      },
      p
    );
    const userMsg = calls[0]!.find((m) => m.role === 'user')?.content ?? '';
    expect(userMsg).toContain('metformin[tiab]');
    expect(userMsg).toContain('Intervention');
    expect(userMsg).toContain('経口糖尿病薬');
    expect(userMsg).toContain('Metformin vs sulfonylurea');
    expect(userMsg).not.toContain('{{CURRENT}}');
  });

  test('空の description は「(不明)」で補完される', async () => {
    const { provider: p, calls } = provider(JSON.stringify({}));
    await improveBlockExpression(
      {
        currentExpression: 'x',
        blockLabel: '',
        blockDescription: '',
        researchQuestion: '',
      },
      p
    );
    const userMsg = calls[0]!.find((m) => m.role === 'user')?.content ?? '';
    expect(userMsg).toContain('(不明)');
  });

  test('欠落フィールドは空文字で埋める', async () => {
    const { provider: p } = provider('{}');
    const result = await improveBlockExpression(
      {
        currentExpression: 'x',
        blockLabel: 'L',
        blockDescription: 'D',
        researchQuestion: 'RQ',
      },
      p
    );
    expect(result).toEqual({ proposedExpression: '', rationale: '' });
  });
});
