/**
 * プロトコル入力（手入力 / md / docx）をパースした共通の結果型。
 * requirements.md §4.2 参照。
 *
 * - `plainText`: LLM の `extract-protocol` skill に渡すプレーンテキスト全文
 * - `preview`: Sheets の `raw_text_preview` 列に入れる先頭 500 文字
 */
export interface ParsedProtocolFile {
  sourceType: 'manual' | 'markdown' | 'docx';
  sourceFilename: string;
  plainText: string;
  preview: string;
}

/** Sheets の raw_text_preview 列に入れる文字数の上限 */
export const PREVIEW_MAX_LENGTH = 500;

/**
 * 長いテキストから Sheets 用のプレビュー（先頭 500 文字）を作る。
 * 改行は空白に畳んで 1 行にする。
 */
export function buildPreview(plainText: string): string {
  const collapsed = plainText.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= PREVIEW_MAX_LENGTH) {
    return collapsed;
  }
  return `${collapsed.slice(0, PREVIEW_MAX_LENGTH - 1)}…`;
}
