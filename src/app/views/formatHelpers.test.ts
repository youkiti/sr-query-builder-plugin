import { formatFormulaVersionShort } from './formatHelpers';

describe('formatFormulaVersionShort', () => {
  test('null はそのまま null', () => {
    expect(formatFormulaVersionShort(null)).toBeNull();
  });

  test('空文字 / 空白のみも null 扱い', () => {
    expect(formatFormulaVersionShort('')).toBeNull();
    expect(formatFormulaVersionShort('   ')).toBeNull();
  });

  test('8 文字以下はそのまま返す', () => {
    expect(formatFormulaVersionShort('abc')).toBe('abc');
    expect(formatFormulaVersionShort('12345678')).toBe('12345678');
  });

  test('9 文字以上は先頭 8 文字に切り詰める', () => {
    expect(formatFormulaVersionShort('12345678-aaaa-bbbb-cccc-000000000000')).toBe('12345678');
    expect(formatFormulaVersionShort('  deadbeef-cafe  ')).toBe('deadbeef');
  });
});
