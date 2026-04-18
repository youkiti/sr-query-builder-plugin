import { parseMarkdownFile } from './parseMarkdown';

describe('parseMarkdownFile', () => {
  test('.md ファイルを読み込み、plainText / preview / sourceType を返す', async () => {
    const content = '# Title\n\n本文です。';
    const result = await parseMarkdownFile({
      name: 'protocol.md',
      text: async () => content,
    });
    expect(result).toEqual({
      sourceType: 'markdown',
      sourceFilename: 'protocol.md',
      plainText: content,
      preview: '# Title 本文です。',
    });
  });

  test('.markdown 拡張子も許可する', async () => {
    const result = await parseMarkdownFile({
      name: 'README.markdown',
      text: async () => 'hi',
    });
    expect(result.sourceFilename).toBe('README.markdown');
  });

  test('Markdown でない拡張子はエラー', async () => {
    await expect(
      parseMarkdownFile({
        name: 'protocol.txt',
        text: async () => 'x',
      })
    ).rejects.toThrow(/拡張子/);
  });
});
