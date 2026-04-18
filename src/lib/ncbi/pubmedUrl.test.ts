import { buildPubmedSearchUrl } from './pubmedUrl';

describe('buildPubmedSearchUrl', () => {
  test('PubMed の検索 URL を正しく組み立てる', () => {
    const url = buildPubmedSearchUrl('diabetes AND metformin');
    expect(url).toBe('https://pubmed.ncbi.nlm.nih.gov/?term=diabetes+AND+metformin');
  });

  test('特殊文字をエンコードする', () => {
    const url = buildPubmedSearchUrl('"heart failure"[tiab]');
    expect(url).toContain('term=%22heart+failure%22%5Btiab%5D');
  });
});
