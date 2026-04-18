import { SkillResponseError, parseSkillJson } from './parseSkillJson';

describe('parseSkillJson', () => {
  test('プレーン JSON をパースする', () => {
    expect(parseSkillJson<{ a: number }>('{"a": 1}', 'test')).toEqual({ a: 1 });
  });

  test('```json ... ``` フェンスを剥がす', () => {
    const text = '```json\n{"a": 2}\n```';
    expect(parseSkillJson<{ a: number }>(text, 'test')).toEqual({ a: 2 });
  });

  test('``` だけのフェンスでも剥がす', () => {
    const text = '```\n{"a": 3}\n```';
    expect(parseSkillJson<{ a: number }>(text, 'test')).toEqual({ a: 3 });
  });

  test('空文字は SkillResponseError', () => {
    expect(() => parseSkillJson('', 'test')).toThrow(SkillResponseError);
  });

  test('空白だけも空扱いで SkillResponseError', () => {
    expect(() => parseSkillJson('   \n  ', 'test')).toThrow(/空/);
  });

  test('壊れた JSON は SkillResponseError', () => {
    try {
      parseSkillJson('{not json', 'my-skill');
    } catch (err) {
      expect(err).toBeInstanceOf(SkillResponseError);
      const e = err as SkillResponseError;
      expect(e.skillName).toBe('my-skill');
      expect(e.rawText).toBe('{not json');
      expect(e.name).toBe('SkillResponseError');
      return;
    }
    throw new Error('should have thrown');
  });
});
