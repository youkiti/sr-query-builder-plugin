import type { PubmedFormula } from '@/lib/search-formula-md';
import type { ConversionResult } from './types';

/**
 * PubMed 検索式を ICTRP（WHO International Clinical Trials Registry Platform）向けに変換する。
 *
 * ICTRP の検索 UI は自由語のみ受け付け、MeSH / 近接演算子 / ワイルドカードは未対応。
 * MVP では以下の前処理を行う：
 *
 * - 全フィールドタグ（`[Mesh]` / `[tiab]` / `[Title]` / `[ad]` 等）を削除
 * - ワイルドカード `*` を削除
 * - 近接演算子 `:~N` を AND に退化させ警告
 * - `#N` 参照は解決できない旨の警告のみ残す
 */
export function convertToIctrp(formula: PubmedFormula): ConversionResult {
  const warnings: string[] = [];
  const lines = formula.blocks.map((block) => {
    const { expression, warnings: w } = convertIctrpExpression(block.expression);
    for (const msg of w) {
      warnings.push(`#${block.id}: ${msg}`);
    }
    return `#${block.id} ${expression}`;
  });
  return {
    targetDb: 'ictrp',
    convertedFormula: lines.join('\n'),
    warnings: dedupe(warnings),
  };
}

function convertIctrpExpression(src: string): { expression: string; warnings: string[] } {
  const warnings: string[] = [];
  let out = src;

  if (/\[(?:tiab|Title):~\d+\]/i.test(out)) {
    warnings.push('近接演算子は ICTRP で未対応のため AND に置換しました');
    out = out.replace(/"([^"]+)"\s*\[(?:tiab|Title):~\d+\]/gi, (_m, phrase: string) => {
      const tokens = phrase.split(/\s+/).filter(Boolean);
      return `(${tokens.join(' AND ')})`;
    });
  }

  // フィールドタグ除去
  out = out.replace(/\s*\[[A-Za-z][A-Za-z0-9:_ -]*\]/gi, '');
  // ワイルドカード除去
  if (/\*/.test(out)) {
    warnings.push('ワイルドカード `*` は ICTRP で未対応のため削除しました');
    out = out.replace(/\*/g, '');
  }

  if (/#[A-Za-z0-9]+/.test(out)) {
    warnings.push('#N 行参照は ICTRP UI では解決できません。手動展開が必要です');
  }

  return { expression: out.trim(), warnings };
}

function dedupe(items: string[]): string[] {
  return Array.from(new Set(items));
}
