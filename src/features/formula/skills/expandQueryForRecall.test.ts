import type { ChatMessage, LLMProvider } from '@/lib/llm';
import { expandQueryForRecall } from './expandQueryForRecall';

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

const blocks = [
  { id: '1', expression: 'asthma[tiab]' },
  { id: '2', expression: 'children[tiab]' },
];

describe('expandQueryForRecall', () => {
  test('ブロックが 0 件なら LLM を呼ばず空配列を返す', async () => {
    const { provider: p, calls } = provider('{}');
    const result = await expandQueryForRecall({ researchQuestion: 'RQ', blocks: [] }, p);
    expect(result).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  test('axis を正規化し、blockId・term・rationale を返す', async () => {
    const json = JSON.stringify({
      blocks: [
        {
          id: '1',
          additions: [
            { term: '"Lung Diseases"[Mesh]', axis: 'mesh', rationale: '親概念' },
            { term: '"wheez*"[tiab]', axis: 'freeword', rationale: '同義' },
          ],
        },
      ],
    });
    const { provider: p } = provider(json);
    const result = await expandQueryForRecall({ researchQuestion: 'RQ', blocks }, p);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ blockId: '1' });
    expect(result[0]?.additions).toHaveLength(2);
    expect(result[0]?.additions[0]).toMatchObject({ axis: 'mesh', term: '"Lung Diseases"[Mesh]' });
  });

  test('未知の axis・空 term・未知ブロック ID は除外する', async () => {
    const json = JSON.stringify({
      blocks: [
        {
          id: '1',
          additions: [
            { term: 'good[tiab]', axis: 'freeword', rationale: 'ok' },
            { term: '', axis: 'mesh', rationale: '空' },
            { term: 'bad[tiab]', axis: 'unknown', rationale: '不正 axis' },
          ],
        },
        { id: '999', additions: [{ term: 'x[tiab]', axis: 'freeword', rationale: 'no block' }] },
      ],
    });
    const { provider: p } = provider(json);
    const result = await expandQueryForRecall({ researchQuestion: 'RQ', blocks }, p);
    expect(result).toHaveLength(1);
    expect(result[0]?.blockId).toBe('1');
    expect(result[0]?.additions).toEqual([
      { term: 'good[tiab]', axis: 'freeword', rationale: 'ok' },
    ]);
  });

  test('additions が空になったブロックは結果に含めない', async () => {
    const json = JSON.stringify({
      blocks: [{ id: '1', additions: [] }],
    });
    const { provider: p } = provider(json);
    const result = await expandQueryForRecall({ researchQuestion: 'RQ', blocks }, p);
    expect(result).toEqual([]);
  });

  test('perBlockLimit で 1 ブロックの追加語数を制限する', async () => {
    const json = JSON.stringify({
      blocks: [
        {
          id: '1',
          additions: [
            { term: 'a[tiab]', axis: 'freeword', rationale: '1' },
            { term: 'b[tiab]', axis: 'freeword', rationale: '2' },
            { term: 'c[tiab]', axis: 'freeword', rationale: '3' },
          ],
        },
      ],
    });
    const { provider: p } = provider(json);
    const result = await expandQueryForRecall(
      { researchQuestion: 'RQ', blocks, perBlockLimit: 2 },
      p
    );
    expect(result[0]?.additions).toHaveLength(2);
  });
});
