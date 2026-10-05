import { expandFormula } from '../../../src/features/validation/expandFormula';
import type { FormulaBlock, PubmedFormula } from '../../../src/lib/search-formula-md/types';

type LineKind = 'concept' | 'filter';

export function classifyLine(block: Pick<FormulaBlock, 'expression'>, negative = false): LineKind {
  return negative || /\[\s*(?:pt|Publication Type|sh|Subheading|dp|Date - Publication|edat|crdt|pdat|la|Language)\s*\]/i.test(block.expression)
    ? 'filter' : 'concept';
}

export interface RequiredUnit { id: string; expression: string; negative: boolean }

// 引用符と括弧の外だけを区切り、PubMed の左からの評価順を保つ。
export function splitTopLevel(expression: string) {
  const parts: string[] = [];
  const operators: string[] = [];
  let depth = 0, quoted = false, start = 0, outerEnd = -1;
  for (let i = 0; i < expression.length; i++) {
    const char = expression[i];
    if (char === '"') quoted = !quoted;
    if (quoted) continue;
    if (char === '(') depth++;
    if (char === ')') { depth--; if (depth === 0 && outerEnd < 0) outerEnd = i; }
    if (depth < 0) return null;
    if (depth !== 0 || (i > 0 && /[\w#]/.test(expression[i - 1]!))) continue;
    const operator = expression.slice(i).match(/^(AND|OR|NOT)\b/i);
    if (!operator) continue;
    parts.push(expression.slice(start, i).trim());
    operators.push(operator[0].toUpperCase());
    i += operator[0].length - 1;
    start = i + 1;
  }
  parts.push(expression.slice(start).trim());
  if (quoted || depth || parts.some((part) => !part)) return null;
  return { parts, operators, wrapped: expression.startsWith('(') && outerEnd === expression.length - 1 };
}

export function requiredUnits(formula: PubmedFormula) {
  // src/features/validation/expandFormula.ts の chooseEntryBlockId と同じ起点選択。
  const entry = [...formula.blocks].reverse().find((block) => block.isCombination) ?? formula.blocks[formula.blocks.length - 1];
  const byId = new Map(formula.blocks.map((block) => [block.id, block]));
  const used = new Set<string>();
  const pending = entry ? [entry.id] : [];
  while (pending.length) {
    const id = pending.pop()!;
    if (used.has(id)) continue;
    used.add(id);
    for (const ref of byId.get(id)!.expression.matchAll(/#([A-Za-z0-9]+)/g)) {
      if (byId.has(ref[1]!)) pending.push(ref[1]!);
    }
  }
  const units: RequiredUnit[] = [];
  let inline = 0;
  const add = (expression: string, negative: boolean, id?: string) => {
    units.push({ id: id ?? `inline-${++inline}`, negative,
      expression: expression.replace(/#([A-Za-z0-9]+)/g, (_match, ref: string) => `(${expandFormula(formula, ref)})`) });
  };
  const visit = (expression: string, depth: number, root: boolean): boolean => {
    if (depth > 20) return false;
    const parsed = splitTopLevel(expression);
    if (!parsed) return false;
    if (parsed.wrapped) return visit(expression.slice(1, -1).trim(), depth + 1, root);
    if (parsed.operators.includes('OR')) {
      if (root) return false;
      add(expression, false);
      return true;
    }
    if (parsed.operators.length) {
      return parsed.parts.every((part, index) => {
        if (parsed.operators[index - 1] === 'NOT') {
          // 否定の複合式を分割すると除外集合が変わるため、右項全体を測る。
          const ref = part.match(/^#([A-Za-z0-9]+)$/);
          add(part, true, ref?.[1]);
          return true;
        }
        return visit(part, depth + 1, false);
      });
    }
    const ref = expression.match(/^#([A-Za-z0-9]+)$/);
    if (ref) {
      const block = byId.get(ref[1]!);
      if (!block) return false;
      if (block.isCombination) return visit(block.expression, depth + 1, root);
      add(block.expression, false, block.id);
    } else {
      add(expression, false);
    }
    return true;
  };
  const determined = entry ? visit(entry.expression, 0, true) : false;
  return { units: determined ? units : [], undetermined: !determined, unusedLines: formula.blocks.length - used.size };
}

