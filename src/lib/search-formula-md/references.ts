import type { PubmedFormula } from './types';

const REFERENCE_PATTERN = /#([A-Za-z0-9]+)/g;

/**
 * expression 中の `#ID` 参照のうち、`selfId` 以外で `knownIds` に含まれるものを、
 * 出現順・重複除去して返す。
 *
 * parse.ts の `containsOtherReference`（isCombination 判定）と editService.ts の
 * 参照整合性ガード（issue #88）の双方がこの関数を共有する。
 */
export function extractBlockReferences(
  expression: string,
  selfId: string,
  knownIds: ReadonlySet<string>
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const match of expression.matchAll(REFERENCE_PATTERN)) {
    // REFERENCE_PATTERN が 1 つのキャプチャを保証する
    const ref = match[1] as string;
    if (ref === selfId || !knownIds.has(ref)) {
      continue;
    }
    if (!seen.has(ref)) {
      seen.add(ref);
      result.push(ref);
    }
  }
  return result;
}

/**
 * 起点ブロック（`src/features/validation/expandFormula.ts` の `chooseEntryBlockId` と
 * 同じ選び方: 最後の `isCombination` ブロック、無ければ最後のブロック）から参照を
 * 再帰的に辿り、到達できないブロック ID を出現順（`formula.blocks` の並び順）で返す。
 *
 * 循環参照があっても、一度到達済みにしたブロックは再訪しない（訪問済み集合）ため
 * 無限ループしない。
 */
export function findUnreachableBlockIds(formula: PubmedFormula): string[] {
  if (formula.blocks.length === 0) {
    return [];
  }
  const knownIds = new Set(formula.blocks.map((b) => b.id));
  const byId = new Map(formula.blocks.map((b) => [b.id, b.expression]));
  const entry = chooseEntryBlockId(formula);
  if (entry === null) {
    return formula.blocks.map((b) => b.id);
  }

  const reached = new Set<string>([entry]);
  const stack: string[] = [entry];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    const expr = byId.get(id);
    if (expr === undefined) {
      continue;
    }
    for (const ref of extractBlockReferences(expr, id, knownIds)) {
      if (!reached.has(ref)) {
        reached.add(ref);
        stack.push(ref);
      }
    }
  }

  return formula.blocks.filter((b) => !reached.has(b.id)).map((b) => b.id);
}

/** expandFormula.ts の `chooseEntryBlockId`（target 未指定時）と同じ選び方。 */
function chooseEntryBlockId(formula: PubmedFormula): string | null {
  for (let i = formula.blocks.length - 1; i >= 0; i -= 1) {
    const block = formula.blocks[i];
    /* istanbul ignore next -- 添字は配列範囲内なので必ず defined */
    if (!block) continue;
    if (block.isCombination) return block.id;
  }
  const last = formula.blocks[formula.blocks.length - 1];
  return last ? last.id : null;
}
