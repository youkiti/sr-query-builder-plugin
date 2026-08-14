import type { FormulaBlock, PubmedFormula } from '@/lib/search-formula-md';
import type { ConversionResult } from './types';
import { appendResidualTagWarning } from './residualPubmedTags';
import { replaceProximityOperators } from './proximityOperator';

/**
 * PubMed 検索式を Cochrane CENTRAL 向けに変換する。
 *
 * 主な変換（MVP）:
 * - `"X"[Mesh]` / `"X"[mesh]` → `[mh "X"]`
 * - `X[tiab]` → `X:ti,ab,kw`
 * - `"X"[Title]` → `"X":ti`
 * - `[ad]`（所属） → 削除 + 警告
 * - `"X Y"[tiab:~N]` 等の近接演算子 → `("X" NEAR/N "Y"):ti,ab,kw` 等
 *   （移植元: search_converter.py の `convert_line_to_central` 12-47 行）
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

  // 近接演算子 "term1 term2"[field:~N] → ("term1" NEAR/N "term2"):field 等
  // （後続の Mesh/Title/tiab 変換より先に処理し、二重変換を防ぐ）
  out = replaceProximityOperators(out, ({ terms, field, distance }) => {
    const centralField = centralProximityField(field);
    if (distance === 0) {
      // 隣接（間に単語なし） → NEXT
      const quoted = terms.map((term) => `"${term}"`);
      return `(${quoted.join(' NEXT ')})${centralField}`;
    }
    if (terms.length === 2) {
      // N 語以内の近接（現在の PubMed では 2 単語のみサポート） → NEAR/N
      return `("${terms[0]}" NEAR/${distance} "${terms[1]}")${centralField}`;
    }
    // 3 語以上は NEAR/NEXT に対応する構文が無いため AND で結合する
    const quoted = terms.map((term) => `"${term}"`);
    return `(${quoted.join(' AND ')})${centralField}`;
  });

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

/**
 * 近接演算子のフィールドを CENTRAL のフィールド修飾子へ写像する。
 * 移植元: search_converter.py `convert_line_to_central` 20-28 行。
 */
function centralProximityField(field: string): string {
  if (field === 'ti' || field === 'title') {
    return ':ti';
  }
  if (field === 'tiab' || field === 'title/abstract') {
    return ':ti,ab,kw';
  }
  if (field === 'ad' || field === 'affiliation') {
    // CENTRAL には所属機関に対応するフィールドが無い
    return '';
  }
  return ':ti,ab,kw';
}

function dedupe(items: string[]): string[] {
  return Array.from(new Set(items));
}
