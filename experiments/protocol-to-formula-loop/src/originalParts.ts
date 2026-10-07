import { classifyLine, splitTopLevel } from './formulaUnits';

function unwrap(expression: string): string | null {
  let inner = expression.trim();
  for (;;) {
    const parsed = splitTopLevel(inner);
    if (!parsed) return null;
    if (!parsed.wrapped) return inner;
    inner = inner.slice(1, -1).trim();
  }
}

export function stripDateRange(query: string): string | null {
  const inner = unwrap(query);
  if (inner === null) return null;
  const parsed = splitTopLevel(inner)!;
  if (parsed.operators.length !== 1 || parsed.operators[0] !== 'AND'
    || !/\[\s*(?:edat|Date - Entry)\s*\]/i.test(parsed.parts[1]!)) return null;
  return unwrap(parsed.parts[0]!);
}

export function originalRequiredParts(inner: string): {
  determined: boolean; parts: { expression: string; negative: boolean; kind: 'concept' | 'filter' }[];
} {
  const parts: { expression: string; negative: boolean; kind: 'concept' | 'filter' }[] = [];
  const add = (expression: string, negative: boolean) => {
    parts.push({ expression, negative, kind: classifyLine({ expression }, negative) });
  };
  // 肯定の AND は、括弧が入れ子になっていても必須の単位まで分ける（AI の式の requiredUnits と同じ数え方にする）。
  // OR を含む部分と、NOT の右側は、それ以上分けない（分けると集合が変わるため）。
  const visit = (text: string, depth: number): boolean => {
    if (depth > 20) return false;
    const expression = unwrap(text);
    if (expression === null) return false;
    const parsed = splitTopLevel(expression)!;
    if (!parsed.operators.length || parsed.operators.includes('OR')) { add(expression, false); return true; }
    return parsed.parts.every((part, index) => {
      if (parsed.operators[index - 1] === 'NOT') { add(part, true); return true; }
      return visit(part, depth + 1);
    });
  };
  return visit(inner, 0) ? { determined: true, parts } : { determined: false, parts: [] };
}
