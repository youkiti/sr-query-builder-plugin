import type { ChatMessage, LLMProvider } from '@/lib/llm';
import {
  EXTRACT_PROTOCOL_SYSTEM_PROMPT,
  EXTRACT_PROTOCOL_AGENT_SYSTEM_PROMPT,
  EXTRACT_PROTOCOL_USER_PROMPT_TEMPLATE,
  extractProtocol,
} from './extractProtocol';
import { SkillResponseError } from './parseSkillJson';
import { PREDEFINED_FILTER_DEFS } from './filterDesigner';
import type { ChatOptions } from '@/lib/llm';

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

  // issue #94: 「小児の肺炎」のように P が独立概念の AND で構成されるとき、
  // 既定の P/I 2 ブロックに押し込まれて P 内が全部 OR になる回帰を防ぐ。
  test('system prompt はブロック数をフレームワーク要素数に固定せず、AND 概念の分割を指示する', () => {
    expect(EXTRACT_PROTOCOL_SYSTEM_PROMPT).toContain('フレームワークの要素数とブロック数は一致しなくてよい');
    expect(EXTRACT_PROTOCOL_SYSTEM_PROMPT).toContain('概念ごとに別ブロックへ分ける');
    expect(EXTRACT_PROTOCOL_SYSTEM_PROMPT).toContain('小児の肺炎');
    expect(EXTRACT_PROTOCOL_SYSTEM_PROMPT).not.toContain('最小限にする');
    expect(EXTRACT_PROTOCOL_SYSTEM_PROMPT).not.toContain('P/I の 2 ブロック');
  });

  test('P を 2 概念に分割した 3 ブロックの出力を受け入れ、結合式は全 AND になる', async () => {
    const json = JSON.stringify({
      framework_type: 'pico',
      research_question: '小児の肺炎に対する抗菌薬 X の有効性',
      blocks: [
        { block_label: 'Children', description: '小児' },
        { block_label: 'Pneumonia', description: '肺炎' },
        { block_label: 'Intervention', description: '抗菌薬 X' },
      ],
    });
    const { provider: p } = provider(json);
    const result = await extractProtocol('プロトコル本文', p);
    expect(result.blocks.map((b) => b.blockLabel)).toEqual(['Children', 'Pneumonia', 'Intervention']);
    expect(result.combinationExpression).toBe('#1 AND #2 AND #3');
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

test('Anthropic 専用の指示と strict スキーマで抽出し、不明 ID と重複を除く', async () => {
  const chat = jest.fn().mockResolvedValue({ text: JSON.stringify({ blocks: [{ block_label: 'P', description: '対象' }], suggested_filter_ids: ['RCTfilter', 'unknown', 'RCTfilter', 'SRfilter'] }) });
  const result = await extractProtocol('本文', { providerId: 'anthropic', model: 'fake', chat });
  expect(result.suggestedFilterIds).toEqual(['RCTfilter', 'SRfilter']);
  const [messages, options] = chat.mock.calls[0]!;
  expect(messages[0].content).toBe(EXTRACT_PROTOCOL_AGENT_SYSTEM_PROMPT);
  expect(messages[1].content).toContain('"suggested_filter_ids"');
  for (const def of PREDEFINED_FILTER_DEFS) expect(messages[0].content).toContain(`  - ${def.id}: ${def.description}`);
  expect(options.responseSchema).toMatchObject({ additionalProperties: false,
    properties: { suggested_filter_ids: { type: 'array', items: { type: 'string', enum: PREDEFINED_FILTER_DEFS.map((d) => d.id) } },
      blocks: { items: { additionalProperties: false } } } });
  expect(options.responseSchema.required).toContain('suggested_filter_ids');
});

test('Gemini と OpenRouter の要求は同一で、提案フィールドを足さない', async () => {
  const requests: unknown[] = [];
  for (const providerId of ['gemini', 'openrouter'] as const) {
    const chat = jest.fn().mockResolvedValue({ text: JSON.stringify({ blocks: [{}], suggested_filter_ids: ['RCTfilter'] }) });
    const result = await extractProtocol('本文', { providerId, model: 'fake', chat });
    const [messages, options] = chat.mock.calls[0]! as [ChatMessage[], ChatOptions];
    expect(messages).toEqual([{ role: 'system', content: EXTRACT_PROTOCOL_SYSTEM_PROMPT },
      { role: 'user', content: EXTRACT_PROTOCOL_USER_PROMPT_TEMPLATE.replace('{{PROTOCOL}}', '本文') }]);
    expect(options.responseSchema?.properties).not.toHaveProperty('suggested_filter_ids');
    expect(result).not.toHaveProperty('suggestedFilterIds');
    requests.push(chat.mock.calls[0]);
  }
  expect(requests[0]).toEqual(requests[1]);
});

test('Anthropic の空本文は呼び出しも提案フィールドも無い', async () => {
  const chat = jest.fn();
  expect(await extractProtocol('', { providerId: 'anthropic', model: 'fake', chat })).not.toHaveProperty('suggestedFilterIds');
  expect(chat).not.toHaveBeenCalled();
});
