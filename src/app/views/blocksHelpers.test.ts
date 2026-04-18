import {
  MAX_BLOCKS,
  MIN_BLOCKS,
  addBlock,
  blockIdsOf,
  defaultCombination,
  emptyBlock,
  moveBlock,
  removeBlock,
  resetCombinationToAllAnd,
  setCombinationExpression,
  updateBlock,
} from './blocksHelpers';
import type { BlocksDraft } from '../store';

function draftOf(count: number, combination = '#1'): BlocksDraft {
  return {
    blocks: Array.from({ length: count }, (_, i) => ({
      blockLabel: `L${i}`,
      description: `D${i}`,
      aiGenerated: true,
      note: '',
    })),
    combinationExpression: combination,
  };
}

describe('emptyBlock / defaultCombination', () => {
  test('emptyBlock は全フィールド空 + aiGenerated=false', () => {
    expect(emptyBlock()).toEqual({
      blockLabel: '',
      description: '',
      aiGenerated: false,
      note: '',
    });
  });

  test('defaultCombination は #1 AND #2 AND ... 形式', () => {
    expect(defaultCombination(3)).toBe('#1 AND #2 AND #3');
    expect(defaultCombination(1)).toBe('#1');
  });
});

describe('addBlock', () => {
  test('末尾に空ブロックを追加', () => {
    const next = addBlock(draftOf(2));
    expect(next.blocks).toHaveLength(3);
    expect(next.blocks[2]).toEqual(emptyBlock());
  });

  test(`MAX_BLOCKS=${MAX_BLOCKS} に達すると追加しない`, () => {
    const draft = draftOf(MAX_BLOCKS);
    const next = addBlock(draft);
    expect(next).toBe(draft);
  });
});

describe('removeBlock', () => {
  test('指定 index を削除', () => {
    const next = removeBlock(draftOf(3), 1);
    expect(next.blocks).toHaveLength(2);
    expect(next.blocks.map((b) => b.blockLabel)).toEqual(['L0', 'L2']);
  });

  test('削除時に combination_expression の参照を詰める', () => {
    const next = removeBlock(draftOf(3, '(#1 AND #2) OR #3'), 1);
    expect(next.combinationExpression).toBe('#1 OR #2');
  });

  test('削除対象だけを参照していた NOT 式は既定の全 AND に戻す', () => {
    const next = removeBlock(draftOf(2, 'NOT #2'), 1);
    expect(next.combinationExpression).toBe('#1');
  });

  test('削除対象ではない NOT 式はリインデックスされる', () => {
    const next = removeBlock(draftOf(2, 'NOT #2'), 0);
    expect(next.combinationExpression).toBe('NOT #1');
  });

  test('削除対象が左オペランドでも残りの式を保つ', () => {
    const next = removeBlock(draftOf(3, '#2 OR #3'), 1);
    expect(next.combinationExpression).toBe('#2');
  });

  test('不正な combination_expression は削除時にそのまま残す', () => {
    const next = removeBlock(draftOf(3, '#1 AND OR #2'), 1);
    expect(next.combinationExpression).toBe('#1 AND OR #2');
  });

  test('トークン化できない combination_expression も削除時にそのまま残す', () => {
    const next = removeBlock(draftOf(3, '#1 @ #2'), 1);
    expect(next.combinationExpression).toBe('#1 @ #2');
  });

  test(`MIN_BLOCKS=${MIN_BLOCKS} を割り込むなら削除しない`, () => {
    const draft = draftOf(1);
    expect(removeBlock(draft, 0)).toBe(draft);
  });

  test('範囲外 index は無視', () => {
    const draft = draftOf(2);
    expect(removeBlock(draft, -1)).toBe(draft);
    expect(removeBlock(draft, 99)).toBe(draft);
  });
});

describe('moveBlock', () => {
  test('上下隣接スワップ', () => {
    const next = moveBlock(draftOf(3), 1, -1);
    expect(next.blocks.map((b) => b.blockLabel)).toEqual(['L1', 'L0', 'L2']);
  });

  test('並び替え時に combination_expression の参照を新 index に合わせる', () => {
    const next = moveBlock(draftOf(3, '(#1 AND #2) OR #3'), 2, -1);
    expect(next.combinationExpression).toBe('#1 AND #3 OR #2');
  });

  test('下方向への移動でも named block を保ったまま参照を書き換える', () => {
    const next = moveBlock(draftOf(2, '#RCTfilter AND #1'), 0, 1);
    expect(next.combinationExpression).toBe('#RCTfilter AND #2');
  });

  test('未知の数値参照はそのまま残しつつ既知参照だけを並び替える', () => {
    const next = moveBlock(draftOf(2, '#99 AND #1'), 0, 1);
    expect(next.combinationExpression).toBe('#99 AND #2');
  });

  test('NOT 式の参照も並び替えに追従する', () => {
    const next = moveBlock(draftOf(2, 'NOT #1'), 0, 1);
    expect(next.combinationExpression).toBe('NOT #2');
  });

  test('優先順位が変わる場合は括弧を維持する', () => {
    const next = moveBlock(draftOf(3, '#1 AND (#2 OR #3)'), 0, 1);
    expect(next.combinationExpression).toBe('#2 AND (#1 OR #3)');
  });

  test('不正な combination_expression は移動時にそのまま残す', () => {
    const next = moveBlock(draftOf(3, '#1 AND OR #2'), 1, -1);
    expect(next.combinationExpression).toBe('#1 AND OR #2');
  });

  test('範囲外への移動は無視', () => {
    const draft = draftOf(3);
    expect(moveBlock(draft, 0, -1)).toBe(draft);
    expect(moveBlock(draft, 2, 1)).toBe(draft);
  });

  test('delta=0 は無視', () => {
    const draft = draftOf(3);
    expect(moveBlock(draft, 1, 0)).toBe(draft);
  });
});

describe('updateBlock', () => {
  test('label を更新すると aiGenerated=false になる', () => {
    const next = updateBlock(draftOf(2), 0, { blockLabel: 'New' });
    expect(next.blocks[0]).toMatchObject({ blockLabel: 'New', aiGenerated: false });
    expect(next.blocks[1]?.aiGenerated).toBe(true);
  });

  test('範囲外 index は無視', () => {
    const draft = draftOf(2);
    expect(updateBlock(draft, 99, { blockLabel: 'X' })).toBe(draft);
  });
});

describe('combinationExpression helpers', () => {
  test('setCombinationExpression は値を入れ替える', () => {
    const next = setCombinationExpression(draftOf(2), '#1 OR #2');
    expect(next.combinationExpression).toBe('#1 OR #2');
  });

  test('resetCombinationToAllAnd でブロック数に応じた AND 結合', () => {
    const next = resetCombinationToAllAnd(draftOf(3, 'old'));
    expect(next.combinationExpression).toBe('#1 AND #2 AND #3');
  });
});

describe('blockIdsOf', () => {
  test('ブロック数に応じて 1..N の文字列集合を返す', () => {
    expect(Array.from(blockIdsOf(draftOf(3))).sort()).toEqual(['1', '2', '3']);
  });
});
