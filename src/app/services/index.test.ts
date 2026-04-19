import * as mod from './index';

describe('app/services index 再エクスポート', () => {
  test('factories と projectService の API が揃う', () => {
    expect(typeof mod.createChromeGoogleApiDeps).toBe('function');
    expect(typeof mod.createChromeRuntimeDeps).toBe('function');
    expect(typeof mod.createNewProject).toBe('function');
    expect(typeof mod.loadExistingProject).toBe('function');
  });
});
