import {
  EutilsError,
  efetchArticles,
  esearch,
  parsePubmedXml,
  resolvePmidByDoi,
} from './eutils';

function makeJsonResponse(body: unknown, init: { status?: number } = {}): Response {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function makeXmlResponse(body: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(body),
    text: async () => body,
  } as Response;
}

function makeErrorResponse(status: number): Response {
  return {
    ok: false,
    status,
    json: async () => ({}),
    text: async () => '',
  } as Response;
}

describe('esearch', () => {
  test('成功レスポンスから count と pmids を抽出する', async () => {
    const fetch = jest
      .fn()
      .mockResolvedValue(
        makeJsonResponse({ esearchresult: { count: '2', idlist: ['111', '222'] } })
      );
    const result = await esearch('diabetes', { fetch });
    expect(result.count).toBe(2);
    expect(result.pmids).toEqual(['111', '222']);
    const calledUrl = (fetch as jest.Mock).mock.calls[0][0] as string;
    expect(calledUrl).toContain('db=pubmed');
    expect(calledUrl).toContain('term=diabetes');
    expect(calledUrl).toContain('tool=sr-query-builder-plugin');
  });

  test('apiKey / email / tool がパラメータに含まれる', async () => {
    const fetch = jest.fn().mockResolvedValue(makeJsonResponse({ esearchresult: { count: '0', idlist: [] } }));
    await esearch('x', { fetch, apiKey: 'secret', email: 'me@example.com', tool: 'mytool' });
    const calledUrl = (fetch as jest.Mock).mock.calls[0][0] as string;
    expect(calledUrl).toContain('api_key=secret');
    expect(calledUrl).toContain('email=me%40example.com');
    expect(calledUrl).toContain('tool=mytool');
  });

  test('retmax / retstart オプションが URL に反映される', async () => {
    const fetch = jest.fn().mockResolvedValue(makeJsonResponse({ esearchresult: { count: '0', idlist: [] } }));
    await esearch('x', { fetch }, { retmax: 50, retstart: 100 });
    const calledUrl = (fetch as jest.Mock).mock.calls[0][0] as string;
    expect(calledUrl).toContain('retmax=50');
    expect(calledUrl).toContain('retstart=100');
  });

  test('HTTP エラーは EutilsError を throw', async () => {
    const fetch = jest.fn().mockResolvedValue(makeErrorResponse(500));
    await expect(
      esearch('x', { fetch, maxRetries: 0, sleep: async () => undefined })
    ).rejects.toBeInstanceOf(EutilsError);
  });

  test('esearchresult が欠けていても 0 件として扱う', async () => {
    const fetch = jest.fn().mockResolvedValue(makeJsonResponse({}));
    const result = await esearch('x', { fetch });
    expect(result).toEqual({ count: 0, pmids: [] });
  });

  test('count に数値化できない値が来ても 0 として扱う', async () => {
    const fetch = jest
      .fn()
      .mockResolvedValue(makeJsonResponse({ esearchresult: { count: 'NaN' } }));
    const result = await esearch('x', { fetch });
    expect(result.count).toBe(0);
  });

  test('一時的な失敗の後に成功するとリトライする', async () => {
    const fetch = jest
      .fn()
      .mockResolvedValueOnce(makeErrorResponse(503))
      .mockResolvedValueOnce(makeJsonResponse({ esearchresult: { count: '1', idlist: ['9'] } }));
    const sleep = jest.fn().mockResolvedValue(undefined);
    const result = await esearch('x', { fetch, sleep, maxRetries: 3 });
    expect(result.pmids).toEqual(['9']);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('parsePubmedXml / efetchArticles', () => {
  const sampleXml = `<?xml version="1.0"?>
<PubmedArticleSet>
  <PubmedArticle>
    <MedlineCitation>
      <PMID Version="1">123</PMID>
      <Article>
        <ArticleTitle>Study of A</ArticleTitle>
        <Journal>
          <Title>The Lancet</Title>
          <JournalIssue>
            <Volume>395</Volume>
            <Issue>10222</Issue>
            <PubDate><Year>2020</Year></PubDate>
          </JournalIssue>
        </Journal>
        <Pagination><MedlinePgn>123-130</MedlinePgn></Pagination>
        <Abstract>
          <AbstractText Label="BACKGROUND">Diabetes is common.</AbstractText>
          <AbstractText Label="METHODS">RCT of metformin.</AbstractText>
        </Abstract>
        <AuthorList>
          <Author><LastName>Smith</LastName><ForeName>John</ForeName><Initials>J</Initials></Author>
          <Author><LastName>Doe</LastName><Initials>JA</Initials></Author>
        </AuthorList>
        <ELocationID EIdType="doi" ValidYN="Y">10.1016/abc</ELocationID>
      </Article>
      <MeshHeadingList>
        <MeshHeading>
          <DescriptorName MajorTopicYN="Y">Diabetes Mellitus</DescriptorName>
        </MeshHeading>
        <MeshHeading>
          <DescriptorName>Metformin</DescriptorName>
        </MeshHeading>
      </MeshHeadingList>
    </MedlineCitation>
    <PubmedData>
      <ArticleIdList>
        <ArticleId IdType="pubmed">123</ArticleId>
        <ArticleId IdType="doi">10.1016/abc</ArticleId>
      </ArticleIdList>
    </PubmedData>
  </PubmedArticle>
  <PubmedArticle>
    <MedlineCitation>
      <PMID Version="1">456</PMID>
      <Article>
        <ArticleTitle>Study of B</ArticleTitle>
        <Journal>
          <ISOAbbreviation>J Med</ISOAbbreviation>
          <JournalIssue>
            <PubDate><MedlineDate>2019 Fall</MedlineDate></PubDate>
          </JournalIssue>
        </Journal>
      </Article>
    </MedlineCitation>
  </PubmedArticle>
</PubmedArticleSet>`;

  test('title / year / MeSH / abstract / 著者 / 雑誌 / 巻号頁 / DOI を抽出できる', () => {
    const articles = parsePubmedXml(sampleXml);
    expect(articles).toHaveLength(2);
    expect(articles[0]).toEqual({
      pmid: '123',
      title: 'Study of A',
      year: 2020,
      meshHeadings: ['Diabetes Mellitus', 'Metformin'],
      meshDetails: [
        { descriptor: 'Diabetes Mellitus', majorTopic: true, qualifiers: [] },
        { descriptor: 'Metformin', majorTopic: false, qualifiers: [] },
      ],
      abstract: 'BACKGROUND: Diabetes is common.\n\nMETHODS: RCT of metformin.',
      journal: 'The Lancet',
      authors: ['Smith J', 'Doe JA'],
      volume: '395',
      issue: '10222',
      pages: '123-130',
      doi: '10.1016/abc',
    });
    expect(articles[1]).toEqual({
      pmid: '456',
      title: 'Study of B',
      year: 2019,
      meshHeadings: [],
      meshDetails: [],
      abstract: null,
      journal: 'J Med',
      authors: [],
      volume: null,
      issue: null,
      pages: null,
      doi: null,
    });
  });

  test('AbstractText に Label が無い場合はラベル無しで連結', () => {
    const xml = `<?xml version="1.0"?><PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>9</PMID><Article><Abstract><AbstractText>One.</AbstractText><AbstractText>Two.</AbstractText></Abstract></Article></MedlineCitation></PubmedArticle></PubmedArticleSet>`;
    expect(parsePubmedXml(xml)[0]?.abstract).toBe('One.\n\nTwo.');
  });

  test('CollectiveName 著者は単独で採用される', () => {
    const xml = `<?xml version="1.0"?><PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>9</PMID><Article><AuthorList><Author><CollectiveName>WHO Study Group</CollectiveName></Author></AuthorList></Article></MedlineCitation></PubmedArticle></PubmedArticleSet>`;
    expect(parsePubmedXml(xml)[0]?.authors).toEqual(['WHO Study Group']);
  });

  test('Initials が無く ForeName だけの著者も採用される', () => {
    const xml = `<?xml version="1.0"?><PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>9</PMID><Article><AuthorList><Author><LastName>Smith</LastName><ForeName>John</ForeName></Author><Author><LastName>OnlyLast</LastName></Author></AuthorList></Article></MedlineCitation></PubmedArticle></PubmedArticleSet>`;
    expect(parsePubmedXml(xml)[0]?.authors).toEqual(['Smith John', 'OnlyLast']);
  });

  test('PubmedData の ArticleId からも DOI を拾える', () => {
    const xml = `<?xml version="1.0"?><PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>9</PMID><Article><ArticleTitle>X</ArticleTitle></Article></MedlineCitation><PubmedData><ArticleIdList><ArticleId IdType="pubmed">9</ArticleId><ArticleId IdType="doi">10.9/xyz</ArticleId></ArticleIdList></PubmedData></PubmedArticle></PubmedArticleSet>`;
    expect(parsePubmedXml(xml)[0]?.doi).toBe('10.9/xyz');
  });

  test('PMID が欠けた article は無視する', () => {
    const xml = `<?xml version="1.0"?><PubmedArticleSet><PubmedArticle><MedlineCitation><Article><ArticleTitle>X</ArticleTitle></Article></MedlineCitation></PubmedArticle></PubmedArticleSet>`;
    expect(parsePubmedXml(xml)).toEqual([]);
  });

  test('year が数字でないと null', () => {
    const xml = `<?xml version="1.0"?><PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>9</PMID><Article><Journal><JournalIssue><PubDate><Year>unknown</Year></PubDate></JournalIssue></Journal></Article></MedlineCitation></PubmedArticle></PubmedArticleSet>`;
    expect(parsePubmedXml(xml)[0]?.year).toBeNull();
  });

  test('空の MeshHeading（DescriptorName 空）は無視', () => {
    const xml = `<?xml version="1.0"?><PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>9</PMID><Article><ArticleTitle>X</ArticleTitle></Article><MeshHeadingList><MeshHeading><DescriptorName></DescriptorName></MeshHeading></MeshHeadingList></MedlineCitation></PubmedArticle></PubmedArticleSet>`;
    expect(parsePubmedXml(xml)[0]?.meshHeadings).toEqual([]);
  });

  test('efetchArticles は pmids が空ならネットワークを叩かず [] を返す', async () => {
    const fetch = jest.fn();
    await expect(efetchArticles([], { fetch })).resolves.toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('efetchArticles は XML を取得してパースする', async () => {
    const fetch = jest.fn().mockResolvedValue(makeXmlResponse(sampleXml));
    const articles = await efetchArticles(['123', '456'], { fetch });
    expect(articles).toHaveLength(2);
    expect(articles[0]?.title).toBe('Study of A');
    const calledUrl = (fetch as jest.Mock).mock.calls[0][0] as string;
    expect(calledUrl).toContain('id=123%2C456');
  });

  test('efetchArticles で HTTP エラーは EutilsError', async () => {
    const fetch = jest.fn().mockResolvedValue(makeErrorResponse(500));
    await expect(
      efetchArticles(['1'], { fetch, maxRetries: 0, sleep: async () => undefined })
    ).rejects.toBeInstanceOf(EutilsError);
  });
});

describe('resolvePmidByDoi', () => {
  test('1 件だけヒットすれば PMID を返す', async () => {
    const fetch = jest
      .fn()
      .mockResolvedValue(makeJsonResponse({ esearchresult: { count: '1', idlist: ['777'] } }));
    await expect(resolvePmidByDoi('10.1234/abc', { fetch })).resolves.toBe('777');
    const calledUrl = (fetch as jest.Mock).mock.calls[0][0] as string;
    expect(calledUrl).toContain('term=10.1234%2Fabc%5Baid%5D');
  });

  test('0 件 / 2 件以上なら null', async () => {
    const fetch = jest
      .fn()
      .mockResolvedValueOnce(makeJsonResponse({ esearchresult: { count: '0', idlist: [] } }))
      .mockResolvedValueOnce(
        makeJsonResponse({ esearchresult: { count: '2', idlist: ['1', '2'] } })
      );
    await expect(resolvePmidByDoi('x', { fetch })).resolves.toBeNull();
    await expect(resolvePmidByDoi('y', { fetch })).resolves.toBeNull();
  });
});

describe('EutilsError', () => {
  test('status プロパティを保持する', () => {
    const err = new EutilsError('boom', 503);
    expect(err.status).toBe(503);
    expect(err.name).toBe('EutilsError');
  });
});
