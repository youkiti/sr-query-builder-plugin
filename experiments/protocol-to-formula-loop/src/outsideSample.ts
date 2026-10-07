import { classifyLine, type RequiredUnit } from './formulaUnits';

export function narrowExpression(expression: string): string {
  // 引用部分を先に消費し、その外にあるタグだけを書き換える。
  return expression.replace(/"[^"]*(?:"|$)|\[([^\]]+)\]/g, (original: string, tag?: string) => {
    if (tag === undefined) return original;
    if (/^(tiab|title\/abstract|tw|text word)$/i.test(tag)) return '[ti]';
    const proximity = tag.match(/^(?:tiab|title\/abstract):~(\d+)$/i);
    if (proximity) return `[ti:~${proximity[1]}]`;
    if (/^(mesh|mh|mesh terms)$/i.test(tag)) return '[majr]';
    if (/^(mesh|mh|mesh terms):noexp$/i.test(tag)) return '[majr:noexp]';
    return original;
  });
}

export function outsideQueries(units: RequiredUnit[], targetId: string, bundledQuery: string) {
  const target = units.find((unit) => unit.id === targetId);
  if (!target || target.negative) return null;
  const remaining = units.filter((unit) => unit.id !== target.id);
  if (!remaining.some((unit) => !unit.negative)
    || !remaining.some((unit) => !unit.negative && classifyLine(unit, false) === 'concept')) return null;
  const build = (narrow: boolean) => remaining.filter((unit) => !unit.negative)
    .map((unit) => narrow && classifyLine(unit, false) === 'concept'
      ? `((${narrowExpression(unit.expression)}) AND (${unit.expression}))` : `(${unit.expression})`).join(' AND ')
    + remaining.filter((unit) => unit.negative).map((unit) => ` NOT (${unit.expression})`).join('')
    + ` NOT (${target.expression})`;
  const current = build(false), narrowed = build(true);
  return { current, narrowed, narrowedBeyondBundle: narrowed + ` NOT (${bundledQuery})` };
}

export function diversify(candidates: { pmid: string; majorHeadings: string[] }[], size: number): string[] {
  const selected = new Set<string>(), headings = new Set<string>();
  for (const candidate of candidates) {
    if (selected.size >= size) break;
    if (!candidate.majorHeadings.some((heading) => !headings.has(heading))) continue;
    selected.add(candidate.pmid);
    candidate.majorHeadings.forEach((heading) => headings.add(heading));
  }
  for (const candidate of candidates) {
    if (selected.size >= size) break;
    selected.add(candidate.pmid);
  }
  return [...selected];
}
