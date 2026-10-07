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
  const expression = unwrap(inner);
  if (expression === null) return { determined: false, parts: [] };
  const parsed = splitTopLevel(expression)!;
  const parts = parsed.operators.includes('OR') ? [expression] : parsed.parts;
  return { determined: true, parts: parts.map((expression, index) => {
    const negative = !parsed.operators.includes('OR') && parsed.operators[index - 1] === 'NOT';
    return { expression, negative, kind: classifyLine({ expression }, negative) };
  }) };
}
