import { sanitizeSecret } from './sanitizeSecret';

describe('sanitizeSecret', () => {
  test.each([
    [null, '(empty)'],
    [undefined, '(empty)'],
    ['', '(empty)'],
  ])('%p は (empty) を返す', (input, expected) => {
    expect(sanitizeSecret(input)).toBe(expected);
  });

  test('12 文字未満は (too-short) を返す', () => {
    expect(sanitizeSecret('short')).toBe('(too-short)');
    expect(sanitizeSecret('12345678901')).toBe('(too-short)');
  });

  test('12 文字以上は先頭 8 文字 + ... を返す', () => {
    expect(sanitizeSecret('abcdefghijkl')).toBe('abcdefgh...');
    expect(sanitizeSecret('AIzaSyAbCdEfGhIjKlMnOpQrStUv')).toBe('AIzaSyAb...');
  });
});
