import type { ConversionResult } from './types';

/**
 * 変換結果に残存した「PubMed 固有のフィールドタグ」を検出するユーティリティ。
 *
 * CENTRAL / Dialog 変換では `[tiab]` 等は各 DB 構文へ置換されるが、
 * `[pt]`（出版タイプ）/ `[sh]`（サブヘディング）/ `[mh]`（MeSH 主見出し）など
 * 一部の PubMed 固有タグは MVP では未対応で素通しになる。
 * その場合に正直に警告を出すための検出器。
 *
 * 検出対象は「語に **後置** される PubMed タグ」（例: `randomized controlled trial[pt]`）。
 * Cochrane CENTRAL の正しい構文 `[mh "Descriptor"]`（先頭に mh が付く形）は
 * **誤検出してはならない**。後置形 `xxx[mh]` と Cochrane 形 `[mh "xxx"]` を区別するため、
 * 「直前が空白・開きかっこ・行頭でない（＝語に密着している）」ものだけを残存タグとみなす。
 */

/**
 * 語に後置された PubMed タグを 1 つ捕捉する正規表現。
 *
 * - `(?<![\s([])` : 直前が空白 / `(` / `[` でない（語に密着している後置形のみ）。
 *   これにより Cochrane 形 `[mh "X"]`（直前が空白か行頭）は除外される。
 * - タグ名の後ろに任意で `:NoExp` / `:~N` などの修飾が付くケースも許容する。
 * - タグ名のみ（クォート付き記述子を含まない）を残存タグとみなすため、
 *   `[mh "X"]` のように `[` 直後に空白やクォートが続く形は除外する。
 */
const RESIDUAL_TAG_REGEX =
  /(?<![\s([])\[(pt|sh|mh|tiab|ti|ab|la|mesh|majr|tw|ad|dp|Date - Publication)(?::[^\]]*)?\]/gi;

/**
 * 文字列に残存している PubMed 固有タグの種類（`[pt]` など）を、出現順・重複排除で返す。
 */
export function detectResidualPubmedTags(text: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(RESIDUAL_TAG_REGEX)) {
    const raw = match[1];
    if (!raw) continue;
    // 表示は `[pt]` 形に正規化（`:NoExp` 等の修飾は落とす）。
    const normalized = `[${raw.toLowerCase()}]`;
    if (!seen.has(normalized)) {
      seen.add(normalized);
      found.push(normalized);
    }
  }
  return found;
}

/**
 * 変換結果に残存 PubMed タグがあれば、`dbLabel` 向けの日本語警告を 1 件追加する。
 * （副作用として `result.warnings` に push し、同じ result を返す。）
 */
export function appendResidualTagWarning(
  result: ConversionResult,
  dbLabel: string
): ConversionResult {
  const tags = detectResidualPubmedTags(result.convertedFormula);
  if (tags.length > 0) {
    result.warnings.push(
      `PubMed 固有タグ (${tags.join(', ')}) が変換されずに残っています。${dbLabel} の構文へ手動で置き換えてください`
    );
  }
  return result;
}
