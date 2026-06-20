import { zipSync, strToU8 } from 'fflate';
import { extractDocxText, fflateDocxExtractor } from './docxText';

/** テスト用に最小構成の `.docx`（zip + word/document.xml）を組み立てる。 */
function buildDocx(documentXml: string, extraEntries: Record<string, string> = {}): ArrayBuffer {
  const entries: Record<string, Uint8Array> = {
    'word/document.xml': strToU8(documentXml),
  };
  for (const [name, content] of Object.entries(extraEntries)) {
    entries[name] = strToU8(content);
  }
  const zipped = zipSync(entries);
  // 純粋な ArrayBuffer を返す（Uint8Array の backing buffer をそのまま渡すと
  // byteOffset がずれる可能性があるのでスライスする）
  return zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength) as ArrayBuffer;
}

const body = (inner: string): string =>
  `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${inner}</w:body></w:document>`;

describe('extractDocxText', () => {
  test('段落（<w:p>）境界を改行に変換する', () => {
    const xml = body('<w:p><w:r><w:t>一行目</w:t></w:r></w:p><w:p><w:r><w:t>二行目</w:t></w:r></w:p>');
    expect(extractDocxText(buildDocx(xml))).toBe('一行目\n二行目');
  });

  test('同一段落内の複数 run を連結する', () => {
    const xml = body('<w:p><w:r><w:t>前半</w:t></w:r><w:r><w:t>後半</w:t></w:r></w:p>');
    expect(extractDocxText(buildDocx(xml))).toBe('前半後半');
  });

  test('タブ（<w:tab/>）と改行（<w:br/>）を変換する', () => {
    const xml = body('<w:p><w:r><w:t>A</w:t><w:tab/><w:t>B</w:t><w:br/><w:t>C</w:t></w:r></w:p>');
    expect(extractDocxText(buildDocx(xml))).toBe('A\tB\nC');
  });

  test('xml:space="preserve" 等の属性付き <w:t> も拾う', () => {
    const xml = body('<w:p><w:r><w:t xml:space="preserve"> 空白保持 </w:t></w:r></w:p>');
    expect(extractDocxText(buildDocx(xml))).toBe('空白保持');
  });

  test('XML エンティティをデコードする', () => {
    const xml = body('<w:p><w:r><w:t>A &amp; B &lt;tag&gt; &quot;q&quot;</w:t></w:r></w:p>');
    expect(extractDocxText(buildDocx(xml))).toBe('A & B <tag> "q"');
  });

  test('連続する空段落は最大 2 改行に圧縮する', () => {
    const xml = body(
      '<w:p><w:r><w:t>上</w:t></w:r></w:p><w:p></w:p><w:p></w:p><w:p></w:p><w:p><w:r><w:t>下</w:t></w:r></w:p>'
    );
    expect(extractDocxText(buildDocx(xml))).toBe('上\n\n下');
  });

  test('zip でないバッファはエラー', () => {
    const notZip = strToU8('this is not a zip').buffer as ArrayBuffer;
    expect(() => extractDocxText(notZip)).toThrow(/展開できませんでした/);
  });

  test('word/document.xml が無い zip はエラー', () => {
    const zipped = zipSync({ 'foo.txt': strToU8('hello') });
    const buf = zipped.buffer.slice(
      zipped.byteOffset,
      zipped.byteOffset + zipped.byteLength
    ) as ArrayBuffer;
    expect(() => extractDocxText(buf)).toThrow(/見つかりませんでした/);
  });

  test('fflateDocxExtractor は DocxExtractor として Promise<string> を返す', async () => {
    const xml = body('<w:p><w:r><w:t>アダプタ経由</w:t></w:r></w:p>');
    await expect(fflateDocxExtractor(buildDocx(xml))).resolves.toBe('アダプタ経由');
  });
});
