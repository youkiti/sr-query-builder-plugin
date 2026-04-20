import * as mod from './index';

describe('app/services index 再エクスポート', () => {
  test('factories と projectService の API が揃う', () => {
    expect(typeof mod.createChromeGoogleApiDeps).toBe('function');
    expect(typeof mod.createChromeRuntimeDeps).toBe('function');
    expect(typeof mod.createNewProject).toBe('function');
    expect(typeof mod.loadExistingProject).toBe('function');
    expect(typeof mod.buildLlmProviderFactory).toBe('function');
    expect(typeof mod.getGeminiApiKey).toBe('function');
    expect(typeof mod.LlmApiKeyMissingError).toBe('function');
    expect(typeof mod.STORAGE_KEY_GEMINI).toBe('string');
    expect(typeof mod.submitProtocol).toBe('function');
    expect(typeof mod.approveBlocks).toBe('function');
    expect(typeof mod.generateDraft).toBe('function');
    expect(typeof mod.exportToAllDatabases).toBe('function');
    expect(typeof mod.toDownloadUrl).toBe('function');
    expect(typeof mod.suggestFileName).toBe('function');
    expect(typeof mod.ingestSeeds).toBe('function');
    expect(typeof mod.runValidation).toBe('function');
    expect(typeof mod.saveEditedFormula).toBe('function');
    expect(typeof mod.fetchBoundaryCandidates).toBe('function');
    expect(typeof mod.recordDecision).toBe('function');
  });
});
