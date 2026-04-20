import * as mod from './index';

describe('features/formula/skills index 再エクスポート', () => {
  test('全 skill 関数とプロンプト定数が揃っている', () => {
    expect(typeof mod.extractProtocol).toBe('function');
    expect(typeof mod.designBlock).toBe('function');
    expect(typeof mod.suggestMesh).toBe('function');
    expect(typeof mod.designFreewords).toBe('function');
    expect(typeof mod.designDefaultFilters).toBe('function');
    expect(typeof mod.proposeExcessFilters).toBe('function');
    expect(typeof mod.pickBoundaryCases).toBe('function');
    expect(typeof mod.parseSkillJson).toBe('function');
    expect(typeof mod.SkillResponseError).toBe('function');
    expect(typeof mod.HIT_THRESHOLD).toBe('number');
    expect(typeof mod.COCHRANE_HSSS_2024_PUBMED).toBe('string');
    expect(mod.EXTRACT_PROTOCOL_SYSTEM_PROMPT.length).toBeGreaterThan(0);
    expect(mod.BLOCK_DESIGNER_SYSTEM_PROMPT.length).toBeGreaterThan(0);
    expect(mod.MESH_SUGGESTER_SYSTEM_PROMPT.length).toBeGreaterThan(0);
    expect(mod.FREEWORD_DESIGNER_SYSTEM_PROMPT.length).toBeGreaterThan(0);
    expect(mod.EXCESS_FILTER_SYSTEM_PROMPT.length).toBeGreaterThan(0);
    expect(mod.PICK_BOUNDARY_SYSTEM_PROMPT.length).toBeGreaterThan(0);
  });

  test('SkillResponseError がインスタンス化できる', () => {
    const err = new mod.SkillResponseError('msg', 'skill', 'raw');
    expect(err.skillName).toBe('skill');
    expect(err.rawText).toBe('raw');
    expect(err.name).toBe('SkillResponseError');
  });

  test('parseSkillJson が JSON を返す', () => {
    expect(mod.parseSkillJson<{ a: number }>('{"a": 1}', 'index')).toEqual({ a: 1 });
  });

  test('全ユーザープロンプトテンプレートが空文字でない', () => {
    expect(mod.EXTRACT_PROTOCOL_USER_PROMPT_TEMPLATE.length).toBeGreaterThan(0);
    expect(mod.BLOCK_DESIGNER_USER_PROMPT_TEMPLATE.length).toBeGreaterThan(0);
    expect(mod.MESH_SUGGESTER_USER_PROMPT_TEMPLATE.length).toBeGreaterThan(0);
    expect(mod.FREEWORD_DESIGNER_USER_PROMPT_TEMPLATE.length).toBeGreaterThan(0);
    expect(mod.EXCESS_FILTER_USER_PROMPT_TEMPLATE.length).toBeGreaterThan(0);
    expect(mod.PICK_BOUNDARY_USER_PROMPT_TEMPLATE.length).toBeGreaterThan(0);
  });
});
