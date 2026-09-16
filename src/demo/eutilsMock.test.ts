import { resolveMeshDescriptors } from '@/lib/ncbi/mesh';
import { efetchArticles, esearch, fetchMeshTreeNumbers, type EutilsDeps } from '@/lib/ncbi';
import { handleEutilsRequest } from './eutilsMock';
import { demoFetch } from './fetchMock';
import { buildBlockExpressions } from './scenario';
import { SEED_PMIDS } from './corpus';

/**
 * eutilsMock.ts を本番の `esearch` / `efetchArticles` / `fetchMeshTreeNumbers` から
 * 呼んだときに正しく応答するかを検証する（llmFixtures.test.ts と同じ方針）。
 */
function makeDeps(): EutilsDeps {
  const fetchImpl = (async (input: RequestInfo | URL) =>
    handleEutilsRequest(String(input))) as unknown as typeof fetch;
  return { fetch: fetchImpl };
}

describe('esearch モック', () => {
  it('長い検索式の POST を demoFetch 経由で評価し、本文のページ指定を使う', async () => {
    const term = Array(100).fill('90000001[uid] OR 90000002[uid]').join(' OR ');
    const result = await esearch(term, { fetch: demoFetch }, { retmax: 1, retstart: 1 });
    expect(result).toEqual({ count: 2, pmids: ['90000002'] });
  });

  it('POST 本文の db と term から MeSH を検索する', async () => {
    const res = handleEutilsRequest(
      'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi', 'POST',
      new URLSearchParams({ db: 'mesh', term: 'Respiratory Distress Syndrome[mh]' }).toString()
    );
    const getRes = handleEutilsRequest(
      'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=mesh&term=Respiratory+Distress+Syndrome%5Bmh%5D'
    );
    expect(await res.json()).toEqual(await getRes.json());
  });

  it('#1(ARDS) のヒット数はコーパス評価結果と一致する', async () => {
    const v1 = buildBlockExpressions();
    const result = await esearch(v1.ards, makeDeps(), { retmax: 0 });
    expect(result.count).toBe(8);
    expect(result.pmids).toEqual([]);
  });

  it('retmax を指定すると PMID を返す', async () => {
    const result = await esearch('90000001[uid]', makeDeps(), { retmax: 5 });
    expect(result.count).toBe(1);
    expect(result.pmids).toEqual(['90000001']);
  });

  it('未対応の db は目立つエラーを投げる（黙って空を返さない）', () => {
    expect(() =>
      handleEutilsRequest(
        'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=nucleotide&term=x'
      )
    ).toThrow();
  });

  it('未対応のエンドポイントは目立つエラーを投げる', () => {
    expect(() =>
      handleEutilsRequest('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/einfo.fcgi')
    ).toThrow();
  });
});

describe('efetch モック', () => {
  it('シード論文の書誌を返す', async () => {
    const articles = await efetchArticles([...SEED_PMIDS], makeDeps());
    expect(articles).toHaveLength(SEED_PMIDS.length);
    const first = articles.find((a) => a.pmid === '90000001');
    expect(first?.title).toContain('extracorporeal membrane oxygenation');
    expect(first?.meshHeadings).toContain('Respiratory Distress Syndrome');
  });

  it('存在しない PMID は結果から除外される（実 API と同じ挙動）', async () => {
    const articles = await efetchArticles(['99999999'], makeDeps());
    expect(articles).toHaveLength(0);
  });
});

describe('db=mesh モック（MeSH 階層）', () => {
  it('Respiratory Distress Syndrome / Extracorporeal Membrane Oxygenation の tree number を解決する', async () => {
    const treeMap = await fetchMeshTreeNumbers(
      ['Respiratory Distress Syndrome', 'Extracorporeal Membrane Oxygenation'],
      makeDeps()
    );
    expect(treeMap.trees.get('Respiratory Distress Syndrome')).toEqual(['C08.618.248']);
    expect(treeMap.trees.get('Extracorporeal Membrane Oxygenation')).toEqual(['E04.100.400']);
  });
});


test('引用符付きの辞書確認と引用符なしの既存検索を両立する', async () => {
  const result = await resolveMeshDescriptors(['Respiratory Distress Syndrome', 'Diabetic Retinopathy, Proliferative'], makeDeps());
  expect([...result]).toEqual([['Respiratory Distress Syndrome', { status: 'resolved', headings: ['Respiratory Distress Syndrome'] }], ['Diabetic Retinopathy, Proliferative', { status: 'missing' }]]);
});
