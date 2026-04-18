import type { PubmedFormula } from '@/lib/search-formula-md';
import { expandFormula } from './expandFormula';

function f(blocks: Array<[string, string, boolean?]>): PubmedFormula {
  return {
    blocks: blocks.map(([id, expression, isCombination]) => ({
      id,
      expression,
      isCombination: isCombination ?? false,
    })),
    combinationExpression: null,
  };
}

describe('expandFormula', () => {
  test('combination を指定すると参照を括弧付きで展開する', () => {
    const out = expandFormula(
      f([
        ['1', 'foo[tiab]'],
        ['2', 'bar[tiab]'],
        ['3', '#1 AND #2', true],
      ])
    );
    expect(out).toBe('(foo[tiab]) AND (bar[tiab])');
  });

  test('targetBlockId を指定するとそのブロックを起点にする', () => {
    const out = expandFormula(
      f([
        ['1', 'foo'],
        ['2', 'bar'],
        ['3', '#1 AND #2', true],
      ]),
      '2'
    );
    expect(out).toBe('bar');
  });

  test('combination が無ければ最後のブロックを使う', () => {
    const out = expandFormula(
      f([
        ['1', 'foo'],
        ['2', 'bar'],
      ])
    );
    expect(out).toBe('bar');
  });

  test('空ブロックの場合は空文字', () => {
    const out = expandFormula(f([]));
    expect(out).toBe('');
  });

  test('既知でない #ID はそのまま残す（PubMed の [uid] 等との衝突回避）', () => {
    const out = expandFormula(f([['1', 'a #uid123 b']]));
    expect(out).toBe('a #uid123 b');
  });

  test('ネストした参照も展開する', () => {
    const out = expandFormula(
      f([
        ['1', 'a'],
        ['2', '#1 OR b'],
        ['3', '#2 AND c', true],
      ])
    );
    expect(out).toBe('((a) OR b) AND c');
  });

  test('循環参照は例外', () => {
    expect(() =>
      expandFormula(
        f([
          ['1', '#2'],
          ['2', '#1', true],
        ])
      )
    ).toThrow(/循環/);
  });

  test('未定義 ID を起点に指定すると例外', () => {
    expect(() => expandFormula(f([['1', 'x']]), '99')).toThrow(/未定義/);
  });
});
