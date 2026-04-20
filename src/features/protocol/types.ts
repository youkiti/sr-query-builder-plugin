/**
 * プロトコル入力（手入力 / md / docx）をパースした共通の結果型。
 * requirements.md §4.2 参照。
 *
 * - `plainText`: LLM の `extract-protocol` skill に渡すプレーンテキスト全文
 * - `preview`: Sheets の `raw_text_preview` 列に入れる先頭 500 文字
 *
 * プレビュー生成ロジック (`buildPreview` / `PREVIEW_MAX_LENGTH`) は
 * `utils/markdown.ts` に移動済み。後方互換のためここから再エクスポートする。
 */
export { PREVIEW_MAX_LENGTH, buildPreview } from '@/utils/markdown';

export interface ParsedProtocolFile {
  sourceType: 'manual' | 'markdown' | 'docx';
  sourceFilename: string;
  plainText: string;
  preview: string;
}
