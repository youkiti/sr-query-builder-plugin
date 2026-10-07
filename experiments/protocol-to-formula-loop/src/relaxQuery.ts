import { splitTopLevel } from './formulaUnits';

export function relaxTags(expression: string, level: 1 | 2): string {
  return expression.replace(/"[^"]*(?:"|$)|\[([^\]]+)\]/g, (original: string, tag?: string) => {
    if (tag === undefined) return original;
    if (/^(majr|mesh:majr|mesh major topic)$/i.test(tag)) return '[Mesh]';
    if (/^(majr|mesh:majr):noexp$/i.test(tag)) return '[Mesh:NoExp]';
    if (level === 2) {
      if (/^(ti|title)$/i.test(tag)) return '[tiab]';
      const proximity = tag.match(/^(?:ti|title):~(\d+)$/i);
      if (proximity) return `[tiab:~${proximity[1]}]`;
    }
    return original;
  });
}

function topLevel(expression: string): ReturnType<typeof splitTopLevel> {
  let text = expression.trim(), parsed = splitTopLevel(text);
  while (parsed?.wrapped) {
    text = text.slice(1, -1).trim();
    parsed = splitTopLevel(text);
  }
  return parsed;
}

function publicationOnly(expression: string): boolean {
  // 引用符の中を伏せてから演算子と括弧で語に分け、すべての語が出版タイプのタグで終わるときだけ該当とする
  // （タグの無い語が混じる部分は、概念を含むかもしれないので外さない）。
  const operands = expression.replace(/"[^"]*(?:"|$)/g, (quoted) => 'x'.repeat(quoted.length))
    .split(/\b(?:AND|OR|NOT)\b|[()]/i).map((operand) => operand.trim()).filter(Boolean);
  return operands.length > 0 && operands.every((operand) => /\[\s*(?:pt|publication type)\s*\]$/i.test(operand));
}

export function relaxationLadder(query: string): string[] {
  const result: string[] = [], seen = new Set([query]);
  const add = (expression: string) => {
    if (!seen.has(expression)) { seen.add(expression); result.push(expression); }
  };
  add(relaxTags(query, 1));
  const second = relaxTags(query, 2);
  add(second);
  const parsed = topLevel(second);
  if (!parsed || !parsed.operators.length || parsed.operators.some((operator) => operator !== 'AND')) return result;
  let parts = parsed.parts;
  const remaining = parts.filter((part) => !publicationOnly(part));
  const and = (items: string[]) => items.map((part) => `(${part})`).join(' AND ');
  if (remaining.length && remaining.length !== parts.length) {
    parts = remaining;
    add(and(parts));
  }
  if (parts.length >= 3) add(parts.map((_, index) => `(${and(parts.filter((__, i) => i !== index))})`).join(' OR '));
  return result;
}
