import type { PubmedFormula } from '@/lib/search-formula-md';
import { checkSearchLines } from './checkSearchLines';

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

function makeFetch(counts: number[]): jest.Mock {
  let i = 0;
  return jest.fn(async () => {
    const count = counts[i] ?? 0;
    i += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ esearchresult: { count: String(count), idlist: [] } }),
      text: async () => '',
    } as Response;
  });
}

describe('checkSearchLines', () => {
  test('各ブロックの ヒット数を返す（#N は展開される）', async () => {
    const fetch = makeFetch([100, 200, 50]);
    const result = await checkSearchLines(
      formula([
        ['1', 'diabetes'],
        ['2', 'metformin'],
        ['3', '#1 AND #2', true],
      ]),
      { fetch }
    );
    expect(result.map((r) => r.hitCount)).toEqual([100, 200, 50]);
    expect(result[2]?.expandedQuery).toBe('(diabetes) AND (metformin)');
  });

  test('展開失敗（循環参照）はエラーとしてキャッチする', async () => {
    const fetch = makeFetch([0]);
    const result = await checkSearchLines(
      formula([
        ['1', '#2'],
        ['2', '#1'],
      ]),
      { fetch }
    );
    expect(result[0]?.error).toMatch(/循環/);
    expect(result[0]?.hitCount).toBe(0);
  });

  test('非 Error 例外もメッセージ文字列化される', async () => {
    const fetch = jest.fn(async () => {
      throw 'string error';
    });
    const result = await checkSearchLines(formula([['1', 'x']]), {
      fetch,
      maxRetries: 0,
      sleep: async () => undefined,
    });
    expect(result[0]?.error).toBe('string error');
  });

  test('NCBI の in-band 構文エラーは「0 件」ではなくブロックのエラーになる', async () => {
    // 不正な語を含む式は HTTP 200 + errorlist で返る（fix-plan 1-1）
    const fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        esearchresult: {
          count: '0',
          idlist: [],
          errorlist: { phrasesnotfound: ['xyzzy123'], fieldsnotfound: [] },
        },
      }),
      text: async () => '',
    }) as Response);
    const result = await checkSearchLines(formula([['1', 'xyzzy123[tiab]']]), {
      fetch,
      maxRetries: 3,
      sleep: async () => undefined,
    });
    expect(result[0]?.error).toContain('構文エラー');
    expect(result[0]?.error).toContain('xyzzy123');
    // 恒久エラーなのでリトライされない
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('空ブロック配列なら [] を返す', async () => {
    const result = await checkSearchLines(formula([]), { fetch: jest.fn() });
    expect(result).toEqual([]);
  });

  test('precomputed にあるブロックは再 esearch せず値を再利用する', async () => {
    // esearch は結合行 #3 の 1 回だけ呼ばれる（#1/#2 は precomputed 再利用）
    const fetch = makeFetch([777]);
    const precomputed = new Map<string, number>([
      ['1', 100],
      ['2', 200],
    ]);
    const result = await checkSearchLines(
      formula([
        ['1', 'diabetes'],
        ['2', 'metformin'],
        ['3', '#1 AND #2', true],
      ]),
      { fetch },
      undefined,
      precomputed
    );
    expect(result.map((r) => r.hitCount)).toEqual([100, 200, 777]);
    // 再利用ブロックでも expandedQuery は計算される
    expect(result[0]?.expandedQuery).toBe('diabetes');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
