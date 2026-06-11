import type { FormulaBlock, PubmedFormula } from '@/lib/search-formula-md';
import type { ConversionResult } from './types';
import { appendResidualTagWarning } from './residualPubmedTags';

/**
 * PubMed 検索式を Cochrane CENTRAL 向けに変換する。
 *
 * 主な変換（MVP）:
 * - `"X"[Mesh]` / `"X"[mesh]` → `[mh "X"]`
 * - `X[tiab]` → `X:ti,ab,kw`
 * - `"X"[Title]` → `"X":ti`
 * - `[ad]`（所属） → 削除 + 警告
 *
 * `#N` 行番号は CENTRAL でもそのまま使える。
 */
export function convertToCentral(formula: PubmedFormula): ConversionResult {
  const warnings: string[] = [];
  const lines = formula.blocks.map((block) => {
    const { expression, warnings: w } = convertCentralExpression(block.expression);
    for (const msg of w) {
      warnings.push(`#${block.id}: ${msg}`);
    }
    return formatBlock(block, expression);
  });
  const result: ConversionResult = {
    targetDb: 'central',
    convertedFormula: lines.join('\n'),
    warnings: dedupe(warnings),
  };
  // MVP では [pt]/[sh]/[mh] 等の PubMed 固有タグは未変換で残るため、残存していれば警告する。
  return appendResidualTagWarning(result, 'Cochrane CENTRAL');
}

function formatBlock(block: FormulaBlock, expression: string): string {
  return `#${block.id} ${expression}`;
}

function convertCentralExpression(src: string): { expression: string; warnings: string[] } {
  const warnings: string[] = [];
  let out = src;

  // "term"[Mesh] → [mh "term"]
  out = out.replace(/"([^"]+)"\s*\[Mesh(?::NoExp)?\]/gi, (_m, term: string) => `[mh "${term}"]`);
  // term[Mesh] bare → [mh term]
  out = out.replace(/([A-Za-z][A-Za-z0-9 -]*)\[Mesh(?::NoExp)?\]/g, (_m, term: string) => {
    return `[mh ${term.trim()}]`;
  });

  // "term"[Title] → "term":ti
  out = out.replace(/"([^"]+)"\s*\[Title\]/gi, (_m, term: string) => `"${term}":ti`);
  // term[Title] → term:ti
  out = out.replace(/([A-Za-z0-9*-]+)\[Title\]/g, (_m, term: string) => `${term}:ti`);

  // "phrase"[tiab] → "phrase":ti,ab,kw
  out = out.replace(/"([^"]+)"\s*\[tiab\]/gi, (_m, term: string) => `"${term}":ti,ab,kw`);
  // single-token[tiab] → token:ti,ab,kw
  out = out.replace(/([A-Za-z0-9*-]+)\[tiab\]/gi, (_m, term: string) => `${term}:ti,ab,kw`);

  // [ad]（所属）は CENTRAL に該当なし → 削除 + 警告
  if (/\[ad\]/i.test(out)) {
    warnings.push('所属フィールド [ad] は CENTRAL で未対応のため削除しました');
    out = out.replace(/([^\s]+)\[ad\]/gi, (_m, term: string) => term);
  }

  return { expression: out, warnings };
}

function dedupe(items: string[]): string[] {
  return Array.from(new Set(items));
}
