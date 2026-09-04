import type { ChatMessage, LLMProvider } from '@/lib/llm';
import { designSpecificQuery } from './designSpecificQuery';
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

const baseInput = {
  researchQuestion: 'ARDS 成人に対する ECMO は死亡率を下げるか',
  inclusionCriteria: '成人 ARDS / ECMO / RCT',
  exclusionCriteria: '小児',
  studyDesign: 'RCT',
  blocks: [
    { id: '1', expression: '"Respiratory Distress Syndrome"[Mesh] OR ARDS[tiab]' },
    { id: '2', expression: '"Extracorporeal Membrane Oxygenation"[Mesh] OR ECMO[tiab]' },
  ],
};

describe('designSpecificQuery', () => {
  test('specific_query と rationale を返し、プロンプトに RQ・基準・ブロック・研究デザインを載せる', async () => {
    const json = JSON.stringify({
      specific_query:
        '("Respiratory Distress Syndrome"[Majr]) AND ("Extracorporeal Membrane Oxygenation"[Majr]) AND "Randomized Controlled Trial"[pt]',
      rationale: 'MeSH を Major Topic に絞り、RCT の Publication Type で限定した。',
    });
    const { provider: p, calls } = provider(json);
    const result = await designSpecificQuery(baseInput, p);
    expect(result.query).toBe(
      '("Respiratory Distress Syndrome"[Majr]) AND ("Extracorporeal Membrane Oxygenation"[Majr]) AND "Randomized Controlled Trial"[pt]'
    );
    expect(result.rationale).toContain('Major Topic');
    const user = calls[0]?.[1]?.content ?? '';
    expect(user).toContain('ARDS 成人に対する ECMO');
    expect(user).toContain('成人 ARDS / ECMO / RCT');
    expect(user).toContain('小児');
    expect(user).toContain('研究デザイン: RCT');
    expect(user).toContain('#1 "Respiratory Distress Syndrome"[Mesh] OR ARDS[tiab]');
    expect(user).toContain('#2 "Extracorporeal Membrane Oxygenation"[Mesh]');
    // 判別キー（E2E の Gemini スタブが skill を見分けるために使う）がプロンプトに載っている
    expect(user).toContain('"specific_query"');
  });

  test('基準・研究デザイン・ブロックが空でもプレースホルダで埋めて呼び出せる', async () => {
    const json = JSON.stringify({ specific_query: 'ecmo[ti]', rationale: '' });
    const { provider: p, calls } = provider(json);
    const result = await designSpecificQuery(
      { researchQuestion: 'RQ', inclusionCriteria: '', exclusionCriteria: '', blocks: [] },
      p
    );
    expect(result).toEqual({ query: 'ecmo[ti]', rationale: '' });
    const user = calls[0]?.[1]?.content ?? '';
    expect(user).toContain('(未記載)');
    expect(user).toContain('研究デザイン: (未指定)');
    expect(user).toContain('(なし)');
  });

  test('改行・コードフェンス・バッククォートを剥がして 1 行に正規化する', async () => {
    const json = JSON.stringify({
      specific_query: '```\n(a[Majr])\n  AND\n(b[ti])\n```',
      rationale: ' 理由 ',
    });
    const { provider: p } = provider(json);
    const result = await designSpecificQuery(baseInput, p);
    expect(result.query).toBe('(a[Majr]) AND (b[ti])');
    expect(result.rationale).toBe('理由');

    const backticked = JSON.stringify({ specific_query: '`x[ti] AND y[ti]`' });
    const result2 = await designSpecificQuery(baseInput, provider(backticked).provider);
    expect(result2.query).toBe('x[ti] AND y[ti]');
  });

  test('specific_query が空 / 欠落なら SkillResponseError', async () => {
    await expect(
      designSpecificQuery(baseInput, provider(JSON.stringify({ specific_query: '   ' })).provider)
    ).rejects.toBeInstanceOf(SkillResponseError);
    await expect(
      designSpecificQuery(baseInput, provider(JSON.stringify({ rationale: 'only' })).provider)
    ).rejects.toBeInstanceOf(SkillResponseError);
  });

  test('括弧が対応していない式は SkillResponseError', async () => {
    await expect(
      designSpecificQuery(
        baseInput,
        provider(JSON.stringify({ specific_query: '(a[ti] AND b[ti]' })).provider
      )
    ).rejects.toBeInstanceOf(SkillResponseError);
    await expect(
      designSpecificQuery(
        baseInput,
        provider(JSON.stringify({ specific_query: 'a[ti]) AND (b[ti]' })).provider
      )
    ).rejects.toBeInstanceOf(SkillResponseError);
  });

  test('JSON として壊れた応答は SkillResponseError', async () => {
    await expect(designSpecificQuery(baseInput, provider('not json').provider)).rejects.toBeInstanceOf(
      SkillResponseError
    );
  });
});
