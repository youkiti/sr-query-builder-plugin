import type { BlockDraft, BlocksDraft } from '../store';

/**
 * BlocksDraft を不変的に操作する純粋関数群。
 * blocksView から呼ばれ、store.setState の updater 内で使う。
 *
 * 制約（docs/ui-block-approval.md §3）:
 * - ブロック数は 1〜5
 * - 並び替えは隣接スワップのみ（drag は MVP では未実装）
 * - 統合は隣接ブロックの label / description を結合
 * - 削除はインデックス指定
 */

export const MIN_BLOCKS = 1;
export const MAX_BLOCKS = 5;

export function emptyBlock(): BlockDraft {
  return { blockLabel: '', description: '', aiGenerated: false, note: '' };
}

export function defaultCombination(count: number): string {
  return Array.from({ length: count }, (_, i) => `#${i + 1}`).join(' AND ');
}

export function addBlock(draft: BlocksDraft): BlocksDraft {
  if (draft.blocks.length >= MAX_BLOCKS) {
    return draft;
  }
  const blocks = [...draft.blocks, emptyBlock()];
  return { ...draft, blocks };
}

export function removeBlock(draft: BlocksDraft, index: number): BlocksDraft {
  if (draft.blocks.length <= MIN_BLOCKS) {
    return draft;
  }
  if (index < 0 || index >= draft.blocks.length) {
    return draft;
  }
  const blocks = draft.blocks.filter((_, i) => i !== index);
  return { ...draft, blocks };
}

export function moveBlock(draft: BlocksDraft, index: number, delta: number): BlocksDraft {
  const target = index + delta;
  if (target < 0 || target >= draft.blocks.length || delta === 0) {
    return draft;
  }
  const blocks = [...draft.blocks];
  const tmp = blocks[index] as BlockDraft;
  blocks[index] = blocks[target] as BlockDraft;
  blocks[target] = tmp;
  return { ...draft, blocks };
}

export function updateBlock(
  draft: BlocksDraft,
  index: number,
  patch: Partial<BlockDraft>
): BlocksDraft {
  if (index < 0 || index >= draft.blocks.length) {
    return draft;
  }
  const blocks = draft.blocks.map((b, i) => {
    if (i !== index) return b;
    return { ...b, ...patch, aiGenerated: false };
  });
  return { ...draft, blocks };
}

export function setCombinationExpression(draft: BlocksDraft, expression: string): BlocksDraft {
  return { ...draft, combinationExpression: expression };
}

export function resetCombinationToAllAnd(draft: BlocksDraft): BlocksDraft {
  return { ...draft, combinationExpression: defaultCombination(draft.blocks.length) };
}

/**
 * ブロック ID 集合（'1', '2', ...）を返す。combination_expression の参照検証に使う。
 */
export function blockIdsOf(draft: BlocksDraft): Set<string> {
  return new Set(draft.blocks.map((_, i) => String(i + 1)));
}
