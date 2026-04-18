import { aggregateMeshFrequency, extractMeshForSeeds } from './extractMesh';

const sampleXml = `<?xml version="1.0"?>
<PubmedArticleSet>
  <PubmedArticle><MedlineCitation><PMID>1</PMID><Article><ArticleTitle>A</ArticleTitle></Article>
    <MeshHeadingList>
      <MeshHeading><DescriptorName>Diabetes Mellitus</DescriptorName></MeshHeading>
      <MeshHeading><DescriptorName>Metformin</DescriptorName></MeshHeading>
    </MeshHeadingList>
  </MedlineCitation></PubmedArticle>
  <PubmedArticle><MedlineCitation><PMID>2</PMID><Article><ArticleTitle>B</ArticleTitle></Article>
    <MeshHeadingList>
      <MeshHeading><DescriptorName>Diabetes Mellitus</DescriptorName></MeshHeading>
    </MeshHeadingList>
  </MedlineCitation></PubmedArticle>
</PubmedArticleSet>`;

describe('extractMeshForSeeds', () => {
  test('空配列なら fetch を呼ばない', async () => {
    const fetch = jest.fn();
    await expect(extractMeshForSeeds([], { fetch })).resolves.toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('PMID を渡して MeSH を取得できる', async () => {
    const fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => sampleXml,
    } as Response);
    const result = await extractMeshForSeeds(['1', '2'], { fetch });
    expect(result).toEqual([
      { pmid: '1', title: 'A', meshHeadings: ['Diabetes Mellitus', 'Metformin'] },
      { pmid: '2', title: 'B', meshHeadings: ['Diabetes Mellitus'] },
    ]);
  });
});

describe('aggregateMeshFrequency', () => {
  test('件数で降順、同数は記述子名昇順', () => {
    const result = aggregateMeshFrequency([
      { pmid: '1', title: null, meshHeadings: ['A', 'B'] },
      { pmid: '2', title: null, meshHeadings: ['A', 'C'] },
      { pmid: '3', title: null, meshHeadings: ['C'] },
    ]);
    expect(result).toEqual([
      { descriptor: 'A', count: 2 },
      { descriptor: 'C', count: 2 },
      { descriptor: 'B', count: 1 },
    ]);
  });

  test('空配列なら []', () => {
    expect(aggregateMeshFrequency([])).toEqual([]);
  });
});
