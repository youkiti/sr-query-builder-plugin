import { buildPreview, type ParsedProtocolFile } from './types';

/**
 * `.docx` ファイルから `mammoth.js` 等でプレーンテキストに変換する関数の型。
 * 実装は app 側で `mammoth.extractRawText` をラップしたアダプタを注入する。
 */
export type DocxExtractor = (buffer: ArrayBuffer) => Promise<string>;

export interface DocxFileInput {
  name: string;
  arrayBuffer: () => Promise<ArrayBuffer>;
}

/**
 * アップロードされた `.docx` ファイルをプレーンテキストに変換する。
 *
 * - 拡張子チェック
 * - `extract` に ArrayBuffer を渡してテキスト抽出
 * - プレビュー文字列（先頭 500 文字）を副産物として返す
 */
export async function parseDocxFile(
  file: DocxFileInput,
  extract: DocxExtractor
): Promise<ParsedProtocolFile> {
  if (!/\.docx$/i.test(file.name)) {
    throw new Error(`.docx ファイルの拡張子ではありません: ${file.name}`);
  }
  const buffer = await file.arrayBuffer();
  const plainText = await extract(buffer);
  return {
    sourceType: 'docx',
    sourceFilename: file.name,
    plainText,
    preview: buildPreview(plainText),
  };
}
