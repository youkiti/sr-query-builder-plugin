import * as mod from './index';

describe('lib/ncbi index 再エクスポート', () => {
  test('主要 API が揃っている', () => {
    expect(typeof mod.esearch).toBe('function');
    expect(typeof mod.efetchArticles).toBe('function');
    expect(typeof mod.parsePubmedXml).toBe('function');
    expect(typeof mod.resolvePmidByDoi).toBe('function');
    expect(typeof mod.buildPubmedSearchUrl).toBe('function');
    expect(typeof mod.exponentialBackoff).toBe('function');
    expect(typeof mod.retryWithBackoff).toBe('function');
    expect(typeof mod.EutilsError).toBe('function');
    expect(typeof mod.fetchMeshTreeNumbers).toBe('function');
    expect(typeof mod.parseMeshTreeXml).toBe('function');
  });
});
