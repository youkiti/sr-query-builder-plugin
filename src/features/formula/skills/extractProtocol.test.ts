import type { ChatMessage, LLMProvider } from '@/lib/llm';
import {
  EXTRACT_PROTOCOL_USER_PROMPT_TEMPLATE,
  extractProtocol,
} from './extractProtocol';
import { SkillResponseError } from './parseSkillJson';

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

describe('extractProtocol', () => {
  test('空入力なら LLM を呼ばず empty draft を返す', async () => {
    const { provider: p, calls } = provider('');
    const result = await extractProtocol('   \n  ', p);
    expect(calls).toHaveLength(0);
    expect(result.frameworkType).toBe('custom');
    expect(result.blocks).toEqual([{ blockLabel: '', description: '' }]);
    expect(result.combinationExpression).toBe('#1');
  });

  test('正常な JSON を構造化して返す', async () => {
    const json = JSON.stringify({
      framework_type: 'PICO',
      research_question: 'RQ',
      inclusion_criteria: 'inc',
      exclusion_criteria: 'exc',
      study_design: 'RCT',
      blocks: [
        { block_label: 'Population', description: 'pop' },
        { block_label: 'Intervention', description: 'int' },
      ],
      combination_expression: '#1 AND #2',
    });
    const { provider: p } = provider(json);
    const result = await extractProtocol('プロトコル本文', p);
    expect(result).toEqual({
      frameworkType: 'pico',
      researchQuestion: 'RQ',
      inclusionCriteria: 'inc',
      exclusionCriteria: 'exc',
      studyDesign: 'RCT',
      blocks: [
        { blockLabel: 'Population', description: 'pop' },
        { blockLabel: 'Intervention', description: 'int' },
      ],
      combinationExpression: '#1 AND #2',
    });
  });

  test('combination_expression が無ければ全 AND を生成', async () => {
    const json = JSON.stringify({
      framework_type: 'pico',
      blocks: [
        { block_label: 'A', description: 'a' },
        { block_label: 'B', description: 'b' },
        { block_label: 'C', description: 'c' },
      ],
    });
    const { provider: p } = provider(json);
    const result = await extractProtocol('x', p);
    expect(result.combinationExpression).toBe('#1 AND #2 AND #3');
  });

  test('framework_type が想定外なら SkillResponseError', async () => {
    const { provider: p } = provider(JSON.stringify({ framework_type: 'wrong', blocks: [{}] }));
    await expect(extractProtocol('x', p)).rejects.toBeInstanceOf(SkillResponseError);
  });

  test('blocks が 0 個 / 6 個でもエラー', async () => {
    const empty = JSON.stringify({ framework_type: 'pico', blocks: [] });
    await expect(extractProtocol('x', provider(empty).provider)).rejects.toThrow(/1〜5/);
    const tooMany = JSON.stringify({
      framework_type: 'pico',
      blocks: Array.from({ length: 6 }, () => ({ block_label: 'X', description: 'x' })),
    });
    await expect(extractProtocol('x', provider(tooMany).provider)).rejects.toThrow(/1〜5/);
  });

  test('プロンプトに本文が埋め込まれる', async () => {
    const { provider: p, calls } = provider(
      JSON.stringify({ framework_type: 'pico', blocks: [{ block_label: 'X', description: 'x' }] })
    );
    await extractProtocol('SAMPLE PROTOCOL', p);
    const userMsg = calls[0]!.find((m) => m.role === 'user');
    expect(userMsg?.content).toContain('SAMPLE PROTOCOL');
    expect(userMsg?.content).not.toContain('{{PROTOCOL}}');
  });

  test('プロンプトテンプレートにプレースホルダが定義されている', () => {
    expect(EXTRACT_PROTOCOL_USER_PROMPT_TEMPLATE).toContain('{{PROTOCOL}}');
  });

  test('blocks 要素のフィールドが欠けていても空文字で埋める', async () => {
    const { provider: p } = provider(JSON.stringify({ framework_type: 'pico', blocks: [{}] }));
    const result = await extractProtocol('x', p);
    expect(result.blocks[0]).toEqual({ blockLabel: '', description: '' });
  });

  test('framework_type と blocks の両方が省略されたレスポンスはエラー', async () => {
    // framework_type 省略 → custom にフォールバック → blocks 省略 → blocks 0 個 → 1〜5 違反
    const { provider: p } = provider('{}');
    await expect(extractProtocol('x', p)).rejects.toThrow(/1〜5/);
  });
});
