import {
  extractBlockReferences,
  findUnreachableBlockIds,
  wouldCreateReferenceCycle,
} from './references';
import type { PubmedFormula } from './types';

/** テスト用の PubmedFormula ビルダー（expandFormula.test.ts と同じ形）。 */
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

describe('extractBlockReferences', () => {
  test('自身以外・既知 ID のみを出現順で返す', () => {
    const knownIds = new Set(['1', '2', '3']);
    expect(extractBlockReferences('#1 AND #2', '3', knownIds)).toEqual(['1', '2']);
  });

  test('自己参照は除外する', () => {
    const knownIds = new Set(['1']);
    expect(extractBlockReferences('#1 OR #1', '1', knownIds)).toEqual([]);
  });

  test('未知の ID（[uid] 等と衝突しうるもの）は除外する', () => {
    const knownIds = new Set(['1']);
    expect(extractBlockReferences('#1 AND #99', '2', knownIds)).toEqual(['1']);
  });

  test('重複参照は初出のみを残す', () => {
    const knownIds = new Set(['1', '2']);
    expect(extractBlockReferences('#1 AND #2 AND #1', '3', knownIds)).toEqual(['1', '2']);
  });

  test('参照が無ければ空配列', () => {
    const knownIds = new Set(['1']);
    expect(extractBlockReferences('asthma[tiab]', '1', knownIds)).toEqual([]);
  });

  test('出現順を保つ（#2 が先に出ても #1 が先ならその順）', () => {
    const knownIds = new Set(['1', '2', '3']);
    expect(extractBlockReferences('#2 OR #1 OR #3', '4', knownIds)).toEqual(['2', '1', '3']);
  });
});

describe('findUnreachableBlockIds', () => {
  test('全ブロックが結合行から到達できれば空配列', () => {
    const formula = f([
      ['1', 'foo[tiab]'],
      ['2', 'bar[tiab]'],
      ['3', '#1 AND #2', true],
    ]);
    expect(findUnreachableBlockIds(formula)).toEqual([]);
  });

  test('結合行から参照されないブロックを検出する', () => {
    const formula = f([
      ['1', 'foo[tiab]'],
      ['2', 'bar[tiab]'],
      ['3', '#1', true],
    ]);
    expect(findUnreachableBlockIds(formula)).toEqual(['2']);
  });

  test('結合行が無ければ最後のブロックが起点になり、それ以外は全て未到達', () => {
    const formula = f([
      ['1', 'foo[tiab]'],
      ['2', 'bar[tiab]'],
    ]);
    expect(findUnreachableBlockIds(formula)).toEqual(['1']);
  });

  test('ネストした参照も辿って到達判定する', () => {
    const formula = f([
      ['1', 'a'],
      ['2', '#1 OR b'],
      ['3', '#2 AND c', true],
    ]);
    expect(findUnreachableBlockIds(formula)).toEqual([]);
  });

  test('循環参照があっても無限ループせず、到達可能な範囲だけ返す', () => {
    const formula = f([
      ['1', '#2'],
      ['2', '#1', true],
    ]);
    expect(findUnreachableBlockIds(formula)).toEqual([]);
  });

  test('循環の外側にある孤立ブロックは未到達として検出する', () => {
    const formula = f([
      ['1', '#2'],
      ['2', '#1', true],
      ['orphan', 'isolated[tiab]'],
    ]);
    expect(findUnreachableBlockIds(formula)).toEqual(['orphan']);
  });

  test('空のブロック一覧は空配列', () => {
    expect(findUnreachableBlockIds({ blocks: [], combinationExpression: null })).toEqual([]);
  });

  test('未到達ブロックは formula.blocks の出現順で返す', () => {
    const formula = f([
      ['a', 'x[tiab]'],
      ['b', 'y[tiab]'],
      ['3', '#a', true],
    ]);
    // b のみ未到達（3 は自分自身なので対象外）
    expect(findUnreachableBlockIds(formula)).toEqual(['b']);
  });
});

describe('wouldCreateReferenceCycle（issue #92 B-1）', () => {
  test('間接的な循環（#3 を書き換えると #4 経由で自分に戻る）を検出する', () => {
    const formula = f([
      ['1', 'foo[tiab]'],
      ['2', 'bar[tiab]'],
      ['3', '#1 AND #2', true],
      ['4', '#3 AND #Filter1', true],
      ['Filter1', 'humans[mh]'],
    ]);
    // #3 を「#1 AND #4」に書き換えると #3 → #4 → #3 という経路ができる。
    expect(wouldCreateReferenceCycle(formula, '3', '#1 AND #4')).toBe(true);
  });

  test('循環を作らない書き換えは false', () => {
    const formula = f([
      ['1', 'foo[tiab]'],
      ['2', 'bar[tiab]'],
      ['3', '#1 AND #2', true],
      ['4', '#3 AND #Filter1', true],
      ['Filter1', 'humans[mh]'],
    ]);
    expect(wouldCreateReferenceCycle(formula, '3', '#1 OR #2')).toBe(false);
  });

  test('自分を直接参照しない限り、無関係な参照だけでは循環にならない', () => {
    const formula = f([
      ['1', 'foo[tiab]'],
      ['2', '#1'],
      ['3', '#2', true],
    ]);
    expect(wouldCreateReferenceCycle(formula, '2', '#1')).toBe(false);
  });

  test('3 段以上のネストした循環も検出する', () => {
    const formula = f([
      ['1', '#2'],
      ['2', '#3'],
      ['3', 'x[tiab]', true],
    ]);
    // #3 を #1 に依存させると 3 → 1 → 2 → 3 の循環になる。
    expect(wouldCreateReferenceCycle(formula, '3', '#1')).toBe(true);
  });
});
