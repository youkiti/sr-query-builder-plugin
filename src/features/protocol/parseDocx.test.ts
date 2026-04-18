import { parseDocxFile } from './parseDocx';

describe('parseDocxFile', () => {
  test('注入された extractor で plainText を取得する', async () => {
    const buffer = new ArrayBuffer(4);
    const extract = jest.fn().mockResolvedValue('抽出されたテキスト');
    const result = await parseDocxFile(
      {
        name: 'プロトコル.docx',
        arrayBuffer: async () => buffer,
      },
      extract
    );
    expect(extract).toHaveBeenCalledWith(buffer);
    expect(result).toEqual({
      sourceType: 'docx',
      sourceFilename: 'プロトコル.docx',
      plainText: '抽出されたテキスト',
      preview: '抽出されたテキスト',
    });
  });

  test('大文字拡張子 .DOCX も許可する', async () => {
    const result = await parseDocxFile(
      { name: 'P.DOCX', arrayBuffer: async () => new ArrayBuffer(0) },
      async () => 'x'
    );
    expect(result.sourceType).toBe('docx');
  });

  test('.docx でない拡張子はエラー', async () => {
    await expect(
      parseDocxFile({ name: 'foo.pdf', arrayBuffer: async () => new ArrayBuffer(0) }, async () => '')
    ).rejects.toThrow(/拡張子/);
  });
});
