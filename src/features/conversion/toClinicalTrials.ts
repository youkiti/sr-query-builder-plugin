import type { PubmedFormula } from '@/lib/search-formula-md';
import type { ConversionResult } from './types';
import { detectResidualFieldTagBrackets, stripKnownPubmedFieldTags } from './pubmedFieldTags';

/**
 * PubMed 検索式を ClinicalTrials.gov 向けに変換する（MVP 版）。
 *
 * ClinicalTrials.gov は Essie 系の独自構文で、近接演算子や MeSH タグを
 * そのまま使えない。MVP ではフィールド分類（Condition / Intervention 等）
 * までは行わず、以下の共通前処理だけで **全フィールドを無差別に 1 つの
 * "Other Terms" 相当の文字列としてそのまま出力する**（Python 版の
 * `ClinicalTrialsConverter` のようなフィールドごとの振り分けは行わない）：
 *
 * - 全フィールドタグ（`[Mesh]` / `[tiab]` / `[Title]` / `[ad]` 等）を削除
 * - 近接演算子 `:~N` を AND に退化させ警告
 * - ワイルドカード `*` はそのまま残す（ClinicalTrials.gov は truncation を部分サポート）
 * - `#N` 参照は解決できない旨を警告として残す
 *
 * **既知の限界**: Condition / Intervention / Title / Other Terms への
 * フィールド振り分けは MVP では未対応。ClinicalTrials.gov の Advanced Search UI
 * には Condition / Intervention 等の入力欄が分かれているが、本変換はそれを
 * 一切判定せず、削除しきれなかった構造情報も含めて丸ごと 1 本の文字列を返す。
 * 利用者は出力を見ながら手動でフィールドへ振り分ける必要がある（要件 §5、P1 以降で対応）。
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
    'Condition / Intervention / Title / Other Terms への自動振り分けは未対応です' +
      '（全フィールドをタグなしの Other Terms 相当としてそのまま出力しています）'
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

  // 全フィールドタグを削除（クォートは残す）。既知タグのみを対象にし、
  // 見た目が似ているだけの未知のブラケット表記まで誤って削除しないようにする。
  out = stripKnownPubmedFieldTags(out);

  // 既知タグ除去後もブラケット表記が残っていれば、取りこぼしたタグとして警告する。
  // PubMed 検索式の文法上 `[...]` はフィールドタグにしか使われないため、
  // ここに残るものは「ホワイトリストに無かった実在タグ」か「未知の表記」のどちらか。
  // 黙って削除も黙って残しもせず、目視で気づけるようにする（issue #60 のレビュー指摘）。
  const residualTags = detectResidualFieldTagBrackets(out);
  if (residualTags.length > 0) {
    warnings.push(
      `変換できなかったフィールドタグが残っています: ${residualTags.join(', ')}。手動で確認してください`
    );
  }

  if (/#[A-Za-z0-9]+/.test(out)) {
    warnings.push('#N 行参照は ClinicalTrials.gov のクエリでは解決できません。手動展開が必要です');
  }

  return { expression: out.trim(), warnings };
}

function dedupe(items: string[]): string[] {
  return Array.from(new Set(items));
}
