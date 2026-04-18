import * as mod from './index';

describe('features/project index 再エクスポート', () => {
  test('主要 API が揃っている', () => {
    expect(typeof mod.createProject).toBe('function');
    expect(typeof mod.loadProjectMeta).toBe('function');
    expect(typeof mod.ProjectSchemaError).toBe('function');
    expect(typeof mod.setCurrentProject).toBe('function');
    expect(typeof mod.getCurrentProject).toBe('function');
    expect(typeof mod.getRecentProjects).toBe('function');
    expect(typeof mod.clearCurrentProject).toBe('function');
    expect(typeof mod.createChromeStoreDeps).toBe('function');
  });
});
