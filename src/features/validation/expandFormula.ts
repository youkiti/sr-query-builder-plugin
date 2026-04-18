import type { PubmedFormula } from '@/lib/search-formula-md';

/**
 * 検索式内の `#N` 参照を再帰的に展開し、完全な PubMed クエリ文字列を得る。
 * 展開後の各参照は `( ... )` で包む。
 *
 * - 引数 `targetBlockId` が指定されていればそのブロックを起点にする
 * - 未指定の場合は combination ブロック（isCombination=true の最後）を、
 *   それも無ければ最後のブロックを起点にする
 *
 * @throws {Error} 参照が循環している、または未定義の ID を参照している場合
 */
export function expandFormula(formula: PubmedFormula, targetBlockId?: string): string {
  const byId = new Map(formula.blocks.map((b) => [b.id, b.expression]));
  const entry = chooseEntryBlockId(formula, targetBlockId);
  if (entry === null) {
    return '';
  }
  return expand(entry, byId, new Set());
}

function chooseEntryBlockId(formula: PubmedFormula, target?: string): string | null {
  if (target !== undefined) {
    return target;
  }
  for (let i = formula.blocks.length - 1; i >= 0; i -= 1) {
    const block = formula.blocks[i];
    /* istanbul ignore next -- 添字は配列範囲内なので必ず defined */
    if (!block) continue;
    if (block.isCombination) return block.id;
  }
  const last = formula.blocks[formula.blocks.length - 1];
  return last ? last.id : null;
}

function expand(id: string, byId: ReadonlyMap<string, string>, stack: Set<string>): string {
  if (stack.has(id)) {
    throw new Error(`検索式ブロックの参照が循環しています: #${id}`);
  }
  const expr = byId.get(id);
  if (expr === undefined) {
    throw new Error(`未定義のブロック ID が参照されました: #${id}`);
  }
  stack.add(id);
  const replaced = expr.replace(/#([A-Za-z0-9]+)/g, (_m, ref: string) => {
    if (!byId.has(ref)) {
      // 他ブロックの ID でない場合は置換せずそのまま残す（PubMed の `[uid]` 等と衝突しないようにするため）
      return `#${ref}`;
    }
    return `(${expand(ref, byId, stack)})`;
  });
  stack.delete(id);
  return replaced;
}
