/**
 * Markdown / プレーンテキストの小物ヘルパ。
 *
 * - `buildPreview`: Sheets セルに入れる 1 行プレビュー（空白を畳んで先頭 N 文字）。
 *   要件 §3.1 `raw_text_preview` 列（500 字上限）で使う。
 * - `buildCodeBlockPreview`: 検索式 Markdown などを「先頭 N 行」で切ったプレビュー。
 *   履歴ビュー等でコードブロックの雰囲気を保ちたいケースで使う。
 *
 * もとは `features/protocol/types.ts` と `app/views/historyView.ts` に 2 通りの
 * `buildPreview` が散らばっていたのを、utils/ に集約した（architecture.md §2 に
 * 「`utils/markdown.ts`」枠が最初から用意されていたが実体が無かったのを埋める形）。
 */

/** Sheets の raw_text_preview 列に入れる文字数の上限 */
export const PREVIEW_MAX_LENGTH = 500;

/**
 * 長いテキストから Sheets 用のプレビューを作る。
 * 空白（改行・タブ含む）は 1 つに畳んで 1 行にし、`maxLength` を超えた場合は
 * 末尾を `…` に置き換える。
 *
 * @param plainText 元テキスト（Markdown でも docx 抽出プレーンテキストでも可）
 * @param maxLength 上限文字数（既定 500）
 */
export function buildPreview(plainText: string, maxLength: number = PREVIEW_MAX_LENGTH): string {
  const collapsed = plainText.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLength) {
    return collapsed;
  }
  return `${collapsed.slice(0, maxLength - 1)}…`;
}

/**
 * コードブロック用の「先頭 N 行」プレビュー。
 * 検索式 Markdown をそのまま見せたいケース（履歴ビュー等）で、
 * 改行・インデントを保ちつつ長すぎる出力を抑えるために使う。
 *
 * @param md 元テキスト
 * @param maxLines 最大行数（既定 10）
 */
export function buildCodeBlockPreview(md: string, maxLines: number = 10): string {
  const lines = md.split('\n');
  const head = lines.slice(0, maxLines).join('\n');
  return lines.length > maxLines ? `${head}\n…` : head;
}
