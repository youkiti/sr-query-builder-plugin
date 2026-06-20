import { unzipSync, strFromU8 } from 'fflate';
import type { DocxExtractor } from './parseDocx';

/**
 * `.docx`（OOXML）から本文プレーンテキストを抽出する軽量実装。
 *
 * `.docx` は実体が zip で、本文は `word/document.xml` の `<w:t>` テキストノードに入る。
 * mammoth 等の重量級ライブラリは書式・テーブル・画像変換まで担うが、本拡張では
 * 抽出したテキストを LLM（extract-protocol skill）へ渡すだけなので、
 * fflate での unzip + XML タグ走査で十分。バンドルも桁違いに軽い。
 *
 * 段落（`<w:p>`）・タブ（`<w:tab>`）・改行（`<w:br>` / `<w:cr>`）の境界のみ
 * 改行・タブへ変換し、それ以外のタグは捨てる。脚注やテーブルのセル順は厳密でないが、
 * 後段が LLM なので許容する。
 */
export function extractDocxText(buffer: ArrayBuffer): string {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(buffer));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`.docx ファイルを展開できませんでした（zip 形式ではない可能性があります）: ${reason}`);
  }

  const documentXml = files['word/document.xml'];
  if (!documentXml) {
    throw new Error('.docx の本文（word/document.xml）が見つかりませんでした');
  }

  return parseDocumentXml(strFromU8(documentXml));
}

/** `DocxExtractor` 型に適合する具体アダプタ。app 層の配線で `parseDocxFile` に注入する。 */
export const fflateDocxExtractor: DocxExtractor = (buffer) =>
  Promise.resolve(extractDocxText(buffer));

/**
 * `word/document.xml` を線形に走査し、構造境界を保ったままテキストを連結する。
 * グローバルな一括抽出だと段落順を失うため、出現順にトークン化する。
 */
function parseDocumentXml(xml: string): string {
  const tokens: string[] = [];
  const re =
    /<\/w:p>|<w:tab\b[^>]*\/?>|<w:br\b[^>]*\/?>|<w:cr\b[^>]*\/?>|<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    const tag = match[0];
    if (match[1] !== undefined) {
      tokens.push(decodeXmlEntities(match[1]));
    } else if (tag.startsWith('<w:tab')) {
      tokens.push('\t');
    } else if (tag.startsWith('<w:br') || tag.startsWith('<w:cr')) {
      tokens.push('\n');
    } else {
      // </w:p>: 段落の区切り
      tokens.push('\n');
    }
  }
  return tokens
    .join('')
    .replace(/[ \t]+\n/g, '\n') // 行末の余分な空白を除去
    .replace(/\n{3,}/g, '\n\n') // 連続改行を最大 2 行に圧縮
    .trim();
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
