import { zipSync, strToU8, unzipSync } from 'fflate';
import { extractDocxText, fflateDocxExtractor } from './docxText';

// unzipSync だけ jest.fn でラップする（他のテストは実装をそのまま通す）。
// ts-jest の ES module 出力は named export が読み取り専用プロパティになり
// jest.spyOn では上書きできないため、jest.mock のファクトリで差し替える。
jest.mock('fflate', () => {
  const actual = jest.requireActual('fflate');
  return { ...actual, unzipSync: jest.fn(actual.unzipSync) };
});

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

  test('非 Error 例外もメッセージ文字列化される', () => {
    const mockUnzipSync = unzipSync as jest.Mock;
    mockUnzipSync.mockImplementationOnce(() => {
      throw 'not an Error object';
    });
    expect(() => extractDocxText(new ArrayBuffer(0))).toThrow(/展開できませんでした/);
  });

  test('埋め込み画像等の他エントリを含んでいても本文だけを正しく抽出する', () => {
    const xml = body('<w:p><w:r><w:t>本文</w:t></w:r></w:p>');
    const docx = buildDocx(xml, {
      'word/media/image1.png': '\x89PNG-binary-ish-content',
      'word/fontTable.xml': '<w:fonts/>',
    });
    expect(extractDocxText(docx)).toBe('本文');

    // 不要エントリ（埋め込み画像等）を展開しないよう filter が渡されていることも確認する。
    const mockUnzipSync = unzipSync as jest.Mock;
    const lastCall = mockUnzipSync.mock.calls[mockUnzipSync.mock.calls.length - 1];
    const filter = lastCall?.[1]?.filter as ((f: { name: string }) => boolean) | undefined;
    expect(filter?.({ name: 'word/document.xml' })).toBe(true);
    expect(filter?.({ name: 'word/media/image1.png' })).toBe(false);
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
