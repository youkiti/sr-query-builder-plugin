import { buildPreview, type ParsedProtocolFile } from './types';

/**
 * アップロードされた Markdown ファイルをプレーンテキストとして読み込む。
 * Markdown の整形はそのまま保持し（LLM 側で解釈）、プレビュー用に
 * 空白を畳んだ先頭 500 文字だけを別途返す。
 */
export interface MarkdownFileInput {
  name: string;
  text: () => Promise<string>;
}

export async function parseMarkdownFile(file: MarkdownFileInput): Promise<ParsedProtocolFile> {
  if (!isLikelyMarkdown(file.name)) {
    throw new Error(`Markdown ファイルの拡張子ではありません: ${file.name}`);
  }
  const plainText = await file.text();
  return {
    sourceType: 'markdown',
    sourceFilename: file.name,
    plainText,
    preview: buildPreview(plainText),
  };
}

function isLikelyMarkdown(name: string): boolean {
  return /\.(md|markdown)$/i.test(name);
}
