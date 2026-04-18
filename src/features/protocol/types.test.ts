import { PREVIEW_MAX_LENGTH, buildPreview } from './types';

describe('buildPreview', () => {
  test('500 文字以内はそのまま（ただし連続空白は畳まれる）', () => {
    expect(buildPreview('hello  world\nfoo')).toBe('hello world foo');
  });

  test('前後の空白は trim される', () => {
    expect(buildPreview('  leading and trailing   ')).toBe('leading and trailing');
  });

  test('空文字は空文字を返す', () => {
    expect(buildPreview('')).toBe('');
  });

  test('501 文字以上は 499 文字 + … に切り詰められる', () => {
    const src = 'a'.repeat(600);
    const out = buildPreview(src);
    expect(out).toHaveLength(PREVIEW_MAX_LENGTH);
    expect(out.endsWith('…')).toBe(true);
    expect(out.startsWith('a'.repeat(PREVIEW_MAX_LENGTH - 1))).toBe(true);
  });

  test('ちょうど 500 文字はそのまま', () => {
    const src = 'b'.repeat(PREVIEW_MAX_LENGTH);
    const out = buildPreview(src);
    expect(out).toBe(src);
    expect(out.endsWith('…')).toBe(false);
  });
});
