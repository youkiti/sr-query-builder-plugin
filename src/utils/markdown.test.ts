import { PREVIEW_MAX_LENGTH, buildCodeBlockPreview, buildPreview } from './markdown';

describe('buildPreview', () => {
  test('空白を 1 つに畳んで 1 行化する', () => {
    expect(buildPreview('hello  world\nfoo')).toBe('hello world foo');
  });

  test('先頭末尾の空白を trim する', () => {
    expect(buildPreview('  leading and trailing   ')).toBe('leading and trailing');
  });

  test('空文字はそのまま空文字を返す', () => {
    expect(buildPreview('')).toBe('');
  });

  test('既定の上限（500 文字）を超えたら末尾を … で置き換える', () => {
    const src = 'a'.repeat(PREVIEW_MAX_LENGTH + 100);
    const out = buildPreview(src);
    expect(out).toHaveLength(PREVIEW_MAX_LENGTH);
    expect(out.endsWith('…')).toBe(true);
  });

  test('ちょうど上限と同じ長さならそのまま返す', () => {
    const src = 'a'.repeat(PREVIEW_MAX_LENGTH);
    const out = buildPreview(src);
    expect(out).toBe(src);
  });

  test('maxLength を引数で上書きできる', () => {
    const out = buildPreview('0123456789', 5);
    expect(out).toHaveLength(5);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('buildCodeBlockPreview', () => {
  test('10 行以内ならそのまま返す（改行保持）', () => {
    const src = ['a', 'b', 'c'].join('\n');
    expect(buildCodeBlockPreview(src)).toBe(src);
  });

  test('既定の 10 行を超えたら末尾に … を追加', () => {
    const src = Array.from({ length: 15 }, (_, i) => `L${i}`).join('\n');
    const out = buildCodeBlockPreview(src);
    const lines = out.split('\n');
    expect(lines).toHaveLength(11); // 10 + '…'
    expect(lines[10]).toBe('…');
    expect(lines.slice(0, 10)).toEqual(Array.from({ length: 10 }, (_, i) => `L${i}`));
  });

  test('maxLines を引数で変えられる', () => {
    const src = 'a\nb\nc\nd';
    expect(buildCodeBlockPreview(src, 2)).toBe('a\nb\n…');
  });

  test('ちょうど maxLines と同じ行数なら … を付けない', () => {
    const src = 'a\nb\nc';
    expect(buildCodeBlockPreview(src, 3)).toBe('a\nb\nc');
  });
});
