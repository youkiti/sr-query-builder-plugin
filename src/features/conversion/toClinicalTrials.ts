import type { PubmedFormula } from '@/lib/search-formula-md';
import type { ConversionResult } from './types';

/**
 * PubMed 検索式を ClinicalTrials.gov 向けに変換する（MVP 版）。
 *
 * ClinicalTrials.gov は Essie 系の独自構文で、近接演算子や MeSH タグを
 * そのまま使えない。MVP ではフィールド分類（Condition / Intervention 等）
 * までは行わず、以下の共通前処理だけで "Other Terms" として出力する：
 *
 * - 全フィールドタグ（`[Mesh]` / `[tiab]` / `[Title]` / `[ad]` 等）を削除
 * - 近接演算子 `:~N` を AND に退化させ警告
 * - ワイルドカード `*` はそのまま残す（ClinicalTrials.gov は truncation を部分サポート）
 * - `#N` 参照は解決できない旨を警告として残す
 *
 * Condition / Intervention への振り分けは P1 以降で対応する（要件 §5）。
 */
export function convertToClinicalTrials(formula: PubmedFormula): ConversionResult {
  const warnings: string[] = [];
  const lines = formula.blocks.map((block) => {
    const { expression, warnings: w } = convertClinicalTrialsExpression(block.expression);
    for (const msg of w) {
      warnings.push(`#${block.id}: ${msg}`);
    }
    return `#${block.id} ${expression}`;
  });
  warnings.unshift(
    'Condition / Intervention / Title / Other Terms への振り分けは MVP では未対応です'
  );
  return {
    targetDb: 'clinicaltrials',
    convertedFormula: lines.join('\n'),
    warnings: dedupe(warnings),
  };
}

function convertClinicalTrialsExpression(src: string): { expression: string; warnings: string[] } {
  const warnings: string[] = [];
  let out = src;

  // 近接演算子 → AND に退化
  if (/\[(?:tiab|Title):~\d+\]/i.test(out)) {
    warnings.push('近接演算子は ClinicalTrials.gov で未対応のため AND に置換しました');
    out = out.replace(/"([^"]+)"\s*\[(?:tiab|Title):~\d+\]/gi, (_m, phrase: string) => {
      const tokens = phrase.split(/\s+/).filter(Boolean);
      return `(${tokens.join(' AND ')})`;
    });
  }

  // 全フィールドタグを削除（クォートは残す）
  out = out.replace(/\s*\[[A-Za-z][A-Za-z0-9:_ -]*\]/gi, '');

  if (/#[A-Za-z0-9]+/.test(out)) {
    warnings.push('#N 行参照は ClinicalTrials.gov のクエリでは解決できません。手動展開が必要です');
  }

  return { expression: out.trim(), warnings };
}

function dedupe(items: string[]): string[] {
  return Array.from(new Set(items));
}
