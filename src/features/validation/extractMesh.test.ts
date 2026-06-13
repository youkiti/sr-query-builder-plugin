import {
  aggregateMeshFrequency,
  extractMeshForSeeds,
  isMeshCheckTag,
  summarizeSeedMesh,
  type MeshForSeed,
} from './extractMesh';

const sampleXml = `<?xml version="1.0"?>
<PubmedArticleSet>
  <PubmedArticle><MedlineCitation><PMID>1</PMID><Article><ArticleTitle>A</ArticleTitle></Article>
    <MeshHeadingList>
      <MeshHeading><DescriptorName MajorTopicYN="Y">Diabetes Mellitus</DescriptorName><QualifierName MajorTopicYN="N">drug therapy</QualifierName></MeshHeading>
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

  test('PMID を渡して MeSH を構造化情報つきで取得できる', async () => {
    const fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => sampleXml,
    } as Response);
    const result = await extractMeshForSeeds(['1', '2'], { fetch });
    expect(result).toEqual([
      {
        pmid: '1',
        title: 'A',
        meshHeadings: ['Diabetes Mellitus', 'Metformin'],
        meshDetails: [
          {
            descriptor: 'Diabetes Mellitus',
            majorTopic: true,
            qualifiers: [{ name: 'drug therapy', majorTopic: false }],
          },
          { descriptor: 'Metformin', majorTopic: false, qualifiers: [] },
        ],
      },
      {
        pmid: '2',
        title: 'B',
        meshHeadings: ['Diabetes Mellitus'],
        meshDetails: [{ descriptor: 'Diabetes Mellitus', majorTopic: false, qualifiers: [] }],
      },
    ]);
  });
});

/** meshDetails を簡潔に組み立てるテストヘルパ。 */
function rec(
  pmid: string,
  details: Array<{
    descriptor: string;
    majorTopic?: boolean;
    qualifiers?: Array<{ name: string; majorTopic?: boolean }>;
  }>
): MeshForSeed {
  return {
    pmid,
    title: null,
    meshHeadings: details.map((d) => d.descriptor),
    meshDetails: details.map((d) => ({
      descriptor: d.descriptor,
      majorTopic: d.majorTopic ?? false,
      qualifiers: (d.qualifiers ?? []).map((q) => ({
        name: q.name,
        majorTopic: q.majorTopic ?? false,
      })),
    })),
  };
}

describe('aggregateMeshFrequency', () => {
  test('件数で降順、同数は記述子名昇順', () => {
    const result = aggregateMeshFrequency([
      rec('1', [{ descriptor: 'A' }, { descriptor: 'B' }]),
      rec('2', [{ descriptor: 'A' }, { descriptor: 'C' }]),
      rec('3', [{ descriptor: 'C' }]),
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

describe('isMeshCheckTag', () => {
  test('チェックタグを判定する', () => {
    expect(isMeshCheckTag('Humans')).toBe(true);
    expect(isMeshCheckTag('Aged, 80 and over')).toBe(true);
    expect(isMeshCheckTag('Diabetes Mellitus')).toBe(false);
  });
});

describe('summarizeSeedMesh', () => {
  test('カバレッジ・MajorTopic・qualifier を集計し、チェックタグを分離する', () => {
    const records = [
      rec('1', [
        { descriptor: 'Heart Failure', majorTopic: true, qualifiers: [{ name: 'drug therapy' }] },
        { descriptor: 'Sacubitril' },
        { descriptor: 'Humans' },
      ]),
      rec('2', [
        { descriptor: 'Heart Failure', qualifiers: [{ name: 'drug therapy' }, { name: 'mortality' }] },
        { descriptor: 'Humans' },
        { descriptor: 'Aged' },
      ]),
    ];
    const summary = summarizeSeedMesh(records, 2);
    expect(summary.seedCount).toBe(2);
    expect(summary.concepts).toEqual([
      {
        descriptor: 'Heart Failure',
        count: 2,
        majorCount: 1,
        qualifiers: [
          { name: 'drug therapy', count: 2 },
          { name: 'mortality', count: 1 },
        ],
      },
      { descriptor: 'Sacubitril', count: 1, majorCount: 0, qualifiers: [] },
    ]);
    expect(summary.checkTags).toEqual([
      { descriptor: 'Humans', count: 2 },
      { descriptor: 'Aged', count: 1 },
    ]);
  });

  test('1 論文内の重複 descriptor はカバレッジ 1 と数え、major を優先する', () => {
    const records = [
      rec('1', [
        { descriptor: 'Stroke', majorTopic: false },
        { descriptor: 'Stroke', majorTopic: true },
      ]),
    ];
    const summary = summarizeSeedMesh(records, 1);
    expect(summary.concepts).toEqual([
      { descriptor: 'Stroke', count: 1, majorCount: 1, qualifiers: [] },
    ]);
  });

  test('空配列なら空の要約', () => {
    expect(summarizeSeedMesh([], 0)).toEqual({ seedCount: 0, concepts: [], checkTags: [] });
  });
});
