import { isValidIso, nowIso } from './iso8601';

describe('nowIso', () => {
  test('引数なしで現在時刻の ISO 文字列を返す', () => {
    const iso = nowIso();
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  test('任意の Date を渡すとその ISO 表現を返す', () => {
    const fixed = new Date('2026-04-17T12:34:56.789Z');
    expect(nowIso(fixed)).toBe('2026-04-17T12:34:56.789Z');
  });
});

describe('isValidIso', () => {
  test('正しい ISO 文字列は true', () => {
    expect(isValidIso('2026-04-17T00:00:00.000Z')).toBe(true);
  });

  test('空文字 / 非文字列 / パース失敗は false', () => {
    expect(isValidIso('')).toBe(false);
    expect(isValidIso('not-a-date')).toBe(false);
    // @ts-expect-error 意図的に型違反
    expect(isValidIso(null)).toBe(false);
  });

  test('ラウンドトリップできない文字列は false（タイムゾーン省略等）', () => {
    expect(isValidIso('2026-04-17T00:00:00')).toBe(false);
  });
});
