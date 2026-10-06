import { classifyLine, requiredUnits } from './formulaUnits';
import { validateFormulaMd } from './submission';

export type UnusableReason = 'invalid' | 'query_mismatch' | 'undetermined' | 'no_concept' | 'too_many_concepts';
export interface Filter { expression: string; negative: boolean }
export type SourceAnalysis = { usable: false; reason: UnusableReason }
  | { usable: true; concepts: string[]; filters: Filter[]; signature: string };

export function analyzeSource(md: string, submittedQuery: string, maxConcepts: number): SourceAnalysis {
  const validated = validateFormulaMd(md);
  if (!validated.ok) return { usable: false, reason: 'invalid' };
  if (validated.query !== submittedQuery) return { usable: false, reason: 'query_mismatch' };
  const { units, undetermined } = requiredUnits(validated.formula);
  if (undetermined) return { usable: false, reason: 'undetermined' };
  const concepts: string[] = [], filters: Filter[] = [];
  for (const unit of units) {
    if (classifyLine({ expression: unit.expression }, unit.negative) === 'concept') concepts.push(unit.expression);
    else filters.push({ expression: unit.expression, negative: unit.negative });
  }
  if (!concepts.length) return { usable: false, reason: 'no_concept' };
  if (concepts.length > maxConcepts) return { usable: false, reason: 'too_many_concepts' };
  const normalized = filters.map((filter) => JSON.stringify([filter.negative, filter.expression.trim().replace(/\s+/g, ' ').toLowerCase()]));
  return { usable: true, concepts, filters, signature: JSON.stringify([concepts.length, [...new Set(normalized)].sort()]) };
}

export function chooseAssignment(matrix: number[][], options: { minOverlap: number; minMargin: number }) {
  const n = matrix.length;
  if (n < 1 || n > 4 || matrix.some((row) => row.length !== n || row.some((v) => !Number.isFinite(v) || v < 0 || v > 1))) {
    throw new Error('重なり係数の行列が不正です');
  }
  const choices: { permutation: number[]; score: number; minPair: number }[] = [];
  const visit = (permutation: number[]) => {
    if (permutation.length === n) {
      const pairs = permutation.map((j, i) => matrix[i]![j]!);
      choices.push({ permutation, score: pairs.reduce((a, b) => a + b, 0) / n, minPair: Math.min(...pairs) });
    } else for (let j = 0; j < n; j++) if (!permutation.includes(j)) visit([...permutation, j]);
  };
  visit([]);
  choices.sort((a, b) => b.score - a.score);
  const best = choices[0]!;
  const margin = n === 1 ? null : best.score - choices[1]!.score;
  return { accepted: best.minPair >= options.minOverlap && (margin === null || margin >= options.minMargin), ...best, margin };
}

export function overlapCoefficient(a: number, b: number, both: number): number {
  if ([a, b, both].some((n) => !Number.isInteger(n) || n < 0) || both > Math.min(a, b)) throw new Error('件数の関係が不正です');
  return Math.min(a, b) === 0 ? 0 : both / Math.min(a, b);
}

export interface MergeGroup { concepts: string[][]; filters: Filter[] }
export function mergedQuery(groups: MergeGroup[], leftovers: string[]): string {
  const queries = groups.map(({ concepts, filters }) => [
    ...concepts.map((expressions) => `(${[...new Set(expressions)].map((expression) => `(${expression})`).join(' OR ')})`),
    ...filters.filter((filter) => !filter.negative).map((filter) => `(${filter.expression})`),
  ].join(' AND ') + filters.filter((filter) => filter.negative).map((filter) => ` NOT (${filter.expression})`).join(''));
  return [...new Set([...queries, ...leftovers])].map((query) => `(${query})`).join(' OR ');
}
