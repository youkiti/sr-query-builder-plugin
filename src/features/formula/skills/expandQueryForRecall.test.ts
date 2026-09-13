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

  test.each([
    ['#1', '1'],
    [' # 2 ', '2'],
    [' 1 ', '1'],
  ])('応答 ID %s を %s に正規化して追加語を採用する', async (id, blockId) => {
    const additions = [{ term: 'new[tiab]', axis: 'freeword', rationale: '同義語' }];
    const { provider: p } = provider(JSON.stringify({ blocks: [{ id, additions }] }));
    const result = await expandQueryForRecall({ researchQuestion: 'RQ', blocks }, p);
    expect(result).toEqual([{ blockId, additions }]);
  });

  test.each(['#999', '##1'])('未知または # が重複した応答 ID %s は除外する', async (id) => {
    const additions = [{ term: 'new[tiab]', axis: 'freeword', rationale: '同義語' }];
    const { provider: p } = provider(JSON.stringify({ blocks: [{ id, additions }] }));
    expect(await expandQueryForRecall({ researchQuestion: 'RQ', blocks }, p)).toEqual([]);
  });

  test.each([['#1', '1'], ['1', '#1']])(
    '正規化後の ID が重複したら先の %s を採用し、後の %s は捨てる',
    async (firstId, secondId) => {
      const additions = [{ term: 'first[tiab]', axis: 'freeword', rationale: '先の提案' }];
      const { provider: p } = provider(JSON.stringify({
        blocks: [
          { id: firstId, additions },
          { id: secondId, additions: [{ term: 'later[tiab]', axis: 'freeword' }] },
        ],
      }));
      expect(await expandQueryForRecall({ researchQuestion: 'RQ', blocks }, p)).toEqual([
        { blockId: '1', additions },
      ]);
    }
  );

  test('最初の応答の追加語が空でも同じ ID の後続応答は捨てる', async () => {
    const { provider: p } = provider(JSON.stringify({
      blocks: [
        { id: '#1', additions: [] },
        { id: '1', additions: [{ term: 'later[tiab]', axis: 'freeword' }] },
      ],
    }));
    expect(await expandQueryForRecall({ researchQuestion: 'RQ', blocks }, p)).toEqual([]);
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
