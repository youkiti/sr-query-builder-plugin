import {
  tokenizeCombination,
  validateGrammar,
  validateParens,
  type CombinationToken,
} from '@/lib/combination-expression';
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
  return {
    ...draft,
    blocks,
    combinationExpression: rewriteAfterRemoval(draft.combinationExpression, draft.blocks.length, index),
  };
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
  return {
    ...draft,
    blocks,
    combinationExpression: rewriteAfterMove(draft.combinationExpression, draft.blocks.length, index, target),
  };
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

type CombinationAst =
  | { kind: 'ref'; id: string }
  | { kind: 'not'; operand: CombinationAst }
  | { kind: 'and' | 'or'; left: CombinationAst; right: CombinationAst };

function rewriteAfterMove(
  expression: string,
  count: number,
  fromIndex: number,
  toIndex: number
): string {
  const ast = parseCombinationAst(expression);
  if (ast === null) {
    return expression;
  }
  const refMap = new Map<string, string>();
  for (let i = 0; i < count; i += 1) {
    refMap.set(String(i + 1), String(movedIndexOf(i, fromIndex, toIndex) + 1));
  }
  return renderAst(remapRefs(ast, refMap));
}

function rewriteAfterRemoval(expression: string, count: number, removedIndex: number): string {
  const ast = parseCombinationAst(expression);
  if (ast === null) {
    return expression;
  }
  const refMap = new Map<string, string>();
  for (let i = 0; i < count; i += 1) {
    if (i === removedIndex) {
      continue;
    }
    const nextIndex = i < removedIndex ? i : i - 1;
    refMap.set(String(i + 1), String(nextIndex + 1));
  }
  const nextAst = pruneRemovedRef(ast, String(removedIndex + 1), refMap);
  return nextAst === null ? defaultCombination(count - 1) : renderAst(nextAst);
}

function movedIndexOf(index: number, fromIndex: number, toIndex: number): number {
  if (index === fromIndex) {
    return toIndex;
  }
  if (fromIndex < toIndex && index > fromIndex && index <= toIndex) {
    return index - 1;
  }
  if (toIndex < fromIndex && index >= toIndex && index < fromIndex) {
    return index + 1;
  }
  return index;
}

function parseCombinationAst(expression: string): CombinationAst | null {
  const tokenized = tokenizeCombination(expression);
  if (tokenized.errors.length > 0) {
    return null;
  }
  if (validateParens(tokenized.tokens).length > 0 || validateGrammar(tokenized.tokens).length > 0) {
    return null;
  }

  let cursor = 0;
  const hasOp = (expected: 'AND' | 'OR'): boolean => {
    const tok = tokenized.tokens[cursor];
    return tok?.kind === 'op' && tok.op === expected;
  };
  const parseOr = (): CombinationAst => {
    let left = parseAnd();
    while (hasOp('OR')) {
      cursor += 1;
      const right = parseAnd();
      left = { kind: 'or', left, right };
    }
    return left;
  };

  const parseAnd = (): CombinationAst => {
    let left = parseUnary();
    while (hasOp('AND')) {
      cursor += 1;
      const right = parseUnary();
      left = { kind: 'and', left, right };
    }
    return left;
  };

  const parseUnary = (): CombinationAst => {
    const tok = tokenized.tokens[cursor];
    if (tok?.kind === 'op' && tok.op === 'NOT') {
      cursor += 1;
      return { kind: 'not', operand: parseUnary() };
    }
    return parsePrimary();
  };

  const parsePrimary = (): CombinationAst => {
    const tok = tokenized.tokens[cursor] as CombinationToken;
    if (tok.kind === 'ref') {
      cursor += 1;
      return { kind: 'ref', id: tok.id };
    }
    cursor += 1;
    const inner = parseOr();
    cursor += 1;
    return inner;
  };

  return parseOr();
}

function remapRefs(ast: CombinationAst, refMap: ReadonlyMap<string, string>): CombinationAst {
  switch (ast.kind) {
    case 'ref':
      return { kind: 'ref', id: remapRefId(ast.id, refMap) };
    case 'not':
      return { kind: 'not', operand: remapRefs(ast.operand, refMap) };
    case 'and':
    case 'or':
      return {
        kind: ast.kind,
        left: remapRefs(ast.left, refMap),
        right: remapRefs(ast.right, refMap),
      };
  }
}

function pruneRemovedRef(
  ast: CombinationAst,
  removedId: string,
  refMap: ReadonlyMap<string, string>
): CombinationAst | null {
  switch (ast.kind) {
    case 'ref':
      if (ast.id === removedId) {
        return null;
      }
      return { kind: 'ref', id: remapRefId(ast.id, refMap) };
    case 'not': {
      const operand = pruneRemovedRef(ast.operand, removedId, refMap);
      return operand === null ? null : { kind: 'not', operand };
    }
    case 'and':
    case 'or': {
      const left = pruneRemovedRef(ast.left, removedId, refMap);
      const right = pruneRemovedRef(ast.right, removedId, refMap);
      if (left === null) {
        return right;
      }
      if (right === null) {
        return left;
      }
      return { kind: ast.kind, left, right };
    }
  }
}

function remapRefId(id: string, refMap: ReadonlyMap<string, string>): string {
  return /^\d+$/.test(id) ? (refMap.get(id) ?? id) : id;
}

function renderAst(ast: CombinationAst, parentPrecedence = 0): string {
  const precedence = precedenceOf(ast);
  let rendered: string;
  switch (ast.kind) {
    case 'ref':
      rendered = `#${ast.id}`;
      break;
    case 'not':
      rendered = `NOT ${renderAst(ast.operand, precedence)}`;
      break;
    case 'and':
      rendered = `${renderAst(ast.left, precedence)} AND ${renderAst(ast.right, precedence)}`;
      break;
    case 'or':
      rendered = `${renderAst(ast.left, precedence)} OR ${renderAst(ast.right, precedence)}`;
      break;
  }
  return precedence < parentPrecedence ? `(${rendered})` : rendered;
}

function precedenceOf(ast: CombinationAst): number {
  switch (ast.kind) {
    case 'ref':
      return 4;
    case 'not':
      return 3;
    case 'and':
      return 2;
    case 'or':
      return 1;
  }
}
