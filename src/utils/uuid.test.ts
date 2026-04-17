import { newUuid, shortUuid } from './uuid';

describe('newUuid', () => {
  test('RFC 4122 v4 形式の UUID を返す', () => {
    const id = newUuid();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test('呼び出しごとに異なる値を返す', () => {
    expect(newUuid()).not.toBe(newUuid());
  });
});

describe('shortUuid', () => {
  test('先頭 8 文字を返す', () => {
    expect(shortUuid('12345678-abcd-4ef0-8abc-1234567890ab')).toBe('12345678');
  });

  test('8 文字未満でも落ちない', () => {
    expect(shortUuid('abc')).toBe('abc');
  });
});
