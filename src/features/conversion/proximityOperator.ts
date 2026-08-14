/**
 * PubMed の近接演算子 `"term1 term2"[field:~N]` を検出・分解する共通ユーティリティ。
 *
 * 移植元: search-formula-developper/scripts/conversion/search_converter.py の
 * `proximity_pattern`（CENTRAL: 13 行 / Dialog: 161 行）。CENTRAL と Dialog で
 * 検出パターン自体は共通だが、変換後の書式（フィールド名・NEAR 系演算子の綴り）は
 * DB ごとに異なるため、検出だけをここへ共通化し、書式化は呼び出し側（DB ごとの
 * フォーマッタ関数）に委ねる。
 */

/** 近接演算子として認識するフィールドタグ（PubMed 側の綴りそのまま）。 */
const PROXIMITY_PATTERN =
  /"([^"]+)"\s*\[(ti|tiab|ad|title|title\/abstract|affiliation):~(\d+)\]/gi;

export interface ProximityMatch {
  /** クォート内の語をスペース区切りで分割したもの（例: `["term1", "term2"]`） */
  terms: string[];
  /** フィールド名（小文字化済み。例: `tiab` / `title/abstract`） */
  field: string;
  /** `:~N` の N（近接語数） */
  distance: number;
}

/**
 * 文字列中の近接演算子をすべて検出し、`format` で DB 固有の構文へ書き換える。
 * マッチが無ければ入力をそのまま返す。
 */
export function replaceProximityOperators(
  src: string,
  format: (match: ProximityMatch) => string
): string {
  return src.replace(
    PROXIMITY_PATTERN,
    (_full: string, phrase: string, field: string, distanceRaw: string) => {
      const terms = phrase.split(/\s+/).filter(Boolean);
      const distance = Number(distanceRaw);
      return format({ terms, field: field.toLowerCase(), distance });
    }
  );
}
