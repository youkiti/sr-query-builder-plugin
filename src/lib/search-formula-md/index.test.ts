import * as indexExports from './index';

describe('index.ts 再エクスポート', () => {
  test('主要 API が全てエクスポートされている', () => {
    expect(typeof indexExports.parsePubmedFormulaMd).toBe('function');
    expect(typeof indexExports.serializePubmedFormulaMd).toBe('function');
    expect(typeof indexExports.FormulaParseError).toBe('function');
    expect(typeof indexExports.FormulaSerializeError).toBe('function');
    expect(indexExports.BLOCK_ID_PATTERN).toBeInstanceOf(RegExp);
    expect(indexExports.PUBMED_HEADING_PATTERN).toBeInstanceOf(RegExp);
  });
});
