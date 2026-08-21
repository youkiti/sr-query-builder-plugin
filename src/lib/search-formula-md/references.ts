import type { FormulaBlock, PubmedFormula } from './types';

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

/**
 * blockId の式を newExpression に差し替えたと仮定したとき、参照グラフに blockId 自身へ
 * 戻る経路（循環）ができるかを判定する（issue #92 B-1）。
 *
 * 例: `#3 #1 AND #2`、`#4 #3 AND #Filter1` がある状態で #3 を `#1 AND #4` に書き換えると、
 * #3 → #4 → #3 という経路ができる（#4 が #3 を参照しているため）。この式は
 * `validateCombinationExpression`（構文）も `assertReferenceIntegrity`（参照が非空か）も
 * 通ってしまい、`findUnreachableBlockIds` は起点からの到達判定に訪問済み集合を使う
 * （無限ループ防止のため既訪問はスキップする設計）ため循環そのものを許容してしまう。
 * 保存前のバリデーションには「起点から到達できるか」ではなく「自分から辿って自分に
 * 戻れるか」を直接見るこの専用関数が要る。
 *
 * blockId 自身からの直接の自己参照（`newExpression` 中の `#blockId`）は
 * {@link extractBlockReferences} が selfId として除外するため、ここでの判定対象にはならない
 * （呼び出し元の `validateCombinationExpression` が knownIds から blockId 自身を除いているため、
 * そもそも構文検証の時点で「未定義のブロック ID」として弾かれる）。
 */
export function wouldCreateReferenceCycle(
  formula: PubmedFormula,
  blockId: string,
  newExpression: string
): boolean {
  const knownIds = new Set(formula.blocks.map((b) => b.id));
  const byId = new Map(formula.blocks.map((b) => [b.id, b.expression]));
  byId.set(blockId, newExpression);

  const visited = new Set<string>();
  const stack: string[] = extractBlockReferences(newExpression, blockId, knownIds);
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (id === blockId) {
      return true;
    }
    if (visited.has(id)) {
      continue;
    }
    visited.add(id);
    const expr = byId.get(id);
    if (expr === undefined) {
      continue;
    }
    for (const ref of extractBlockReferences(expr, id, knownIds)) {
      stack.push(ref);
    }
  }
  return false;
}

/**
 * expandFormula.ts の `chooseEntryBlockId`（target 未指定時）と同じ選び方。
 *
 * 呼び出し元 findUnreachableBlockIds が formula.blocks.length === 0 を早期 return で
 * 弾いてから呼ぶ前提（このファイルの唯一の呼び出し元）なので、ここに到達する時点で
 * blocks は必ず非空 → 戻り値は必ず string（旧実装は string | null で「起点が無い」
 * 分岐を呼び出し側に持っていたが、その分岐は非空ガードにより決して実行されない
 * 到達不能コードだった。issue #92 C-7）。
 */
function chooseEntryBlockId(formula: PubmedFormula): string {
  for (let i = formula.blocks.length - 1; i >= 0; i -= 1) {
    const block = formula.blocks[i];
    /* istanbul ignore next -- 添字は配列範囲内なので必ず defined */
    if (!block) continue;
    if (block.isCombination) return block.id;
  }
  // 呼び出し元の非空ガードにより、この添字アクセスは必ず defined。
  const last = formula.blocks[formula.blocks.length - 1] as FormulaBlock;
  return last.id;
}
