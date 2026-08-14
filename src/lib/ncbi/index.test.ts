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
    expect(typeof mod.parseMeshSummaryJson).toBe('function');
    expect(typeof mod.fetchMeshChildren).toBe('function');
    expect(typeof mod.fetchMeshLabels).toBe('function');
  });

  test('レートリミッタ関連 API が揃っている（issue #59）', () => {
    expect(typeof mod.TokenBucket).toBe('function');
    expect(typeof mod.sharedEutilsRateLimiters.withoutApiKey.acquire).toBe('function');
    expect(typeof mod.sharedEutilsRateLimiters.withApiKey.acquire).toBe('function');
    expect(mod.NCBI_RATE_LIMIT_WITHOUT_API_KEY).toBe(3);
    expect(mod.NCBI_RATE_LIMIT_WITH_API_KEY).toBe(10);
  });
});
