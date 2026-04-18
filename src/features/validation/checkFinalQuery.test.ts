import type { PubmedFormula } from '@/lib/search-formula-md';
import { checkFinalQuery } from './checkFinalQuery';

function formula(blocks: Array<[string, string, boolean?]>): PubmedFormula {
  return {
    blocks: blocks.map(([id, expression, isCombination]) => ({
      id,
      expression,
      isCombination: isCombination ?? false,
    })),
    combinationExpression: null,
  };
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe('checkFinalQuery', () => {
  const f = formula([
    ['1', 'diabetes'],
    ['2', 'metformin'],
    ['3', '#1 AND #2', true],
  ]);

  test('seed 全捕捉で captureRate=1.0', async () => {
    const fetch = jest
      .fn()
      // total hits
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '5000', idlist: [] } }))
      // captured
      .mockResolvedValueOnce(
        jsonResponse({
          esearchresult: { count: '3', idlist: ['111', '222', '333'] },
        })
      );
    const result = await checkFinalQuery(f, ['111', '222', '333'], { fetch });
    expect(result).toEqual({
      finalQuery: '(diabetes) AND (metformin)',
      totalHits: 5000,
      captureRate: 1,
      capturedPmids: ['111', '222', '333'],
      missedPmids: [],
    });
  });

  test('一部取りこぼしの captureRate と missedPmids', async () => {
    const fetch = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '5000', idlist: [] } }))
      .mockResolvedValueOnce(
        jsonResponse({ esearchresult: { count: '1', idlist: ['111'] } })
      );
    const result = await checkFinalQuery(f, ['111', '222'], { fetch });
    expect(result.captureRate).toBe(0.5);
    expect(result.capturedPmids).toEqual(['111']);
    expect(result.missedPmids).toEqual(['222']);
  });

  test('seedPmids が空なら capturedQuery の esearch を呼ばない', async () => {
    const fetch = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '1000', idlist: [] } }));
    const result = await checkFinalQuery(f, [], { fetch });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      finalQuery: '(diabetes) AND (metformin)',
      totalHits: 1000,
      captureRate: 0,
      capturedPmids: [],
      missedPmids: [],
    });
  });

  test('capturedQuery には seed PMID が [uid] 形式で入る', async () => {
    const fetch = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '0', idlist: [] } }))
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '0', idlist: [] } }));
    await checkFinalQuery(f, ['111', '222'], { fetch });
    const secondUrl = (fetch as jest.Mock).mock.calls[1][0] as string;
    expect(secondUrl).toContain('term=%28%28diabetes%29+AND+%28metformin%29%29+AND+%28111%5Buid%5D+OR+222%5Buid%5D%29');
  });
});
