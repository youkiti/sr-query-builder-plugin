import {
  EutilsError,
  NCBI_RATE_LIMIT_WITHOUT_API_KEY,
  NCBI_RATE_LIMIT_WITH_API_KEY,
  efetchArticles,
  esearch,
  parsePubmedXml,
  resolvePmidByDoi,
  sharedEutilsRateLimiters,
} from './eutils';
import { TokenBucket, type RateLimiter } from './rateLimit';

// テストごとに満タンへ戻す。issue #59 のトークンバケットはプロセス共有（モジュールスコープの
// シングルトン）なので、リセットしないと直前のテストで消費したトークンが持ち越されて
// 実タイマーでの待機が発生してしまう（本ファイルは 1 テストあたり高々数回しか fetch しないが、
// 積算するとバケット容量を超える）。
beforeEach(() => {
  sharedEutilsRateLimiters.withoutApiKey.reset();
  sharedEutilsRateLimiters.withApiKey.reset();
});

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

  test('errorlist.phrasesnotfound は permanent な EutilsError（リトライしない）', async () => {
    // NCBI は不正な語を含む式でも HTTP 200 + count 付きで返す（in-band エラー）
    const fetch = jest.fn().mockResolvedValue(
      makeJsonResponse({
        esearchresult: {
          count: '0',
          idlist: [],
          errorlist: { phrasesnotfound: ['nonexistentterm123'], fieldsnotfound: [] },
        },
      })
    );
    const sleep = jest.fn().mockResolvedValue(undefined);
    const promise = esearch('x', { fetch, sleep, maxRetries: 3 });
    await expect(promise).rejects.toBeInstanceOf(EutilsError);
    await expect(promise).rejects.toMatchObject({
      permanent: true,
      message: expect.stringContaining('"nonexistentterm123"'),
    });
    // 恒久エラーはリトライ対象外（fetch 1 回で打ち切り）
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  test('errorlist.fieldsnotfound は不明なタグとしてエラーになる', async () => {
    const fetch = jest.fn().mockResolvedValue(
      makeJsonResponse({
        esearchresult: {
          count: '123',
          idlist: [],
          errorlist: { phrasesnotfound: [], fieldsnotfound: ['tiabb'] },
        },
      })
    );
    await expect(esearch('x', { fetch, maxRetries: 0 })).rejects.toMatchObject({
      permanent: true,
      message: expect.stringContaining('[tiabb]'),
    });
  });

  test('esearchresult.ERROR は permanent な EutilsError になる', async () => {
    const fetch = jest.fn().mockResolvedValue(
      makeJsonResponse({ esearchresult: { ERROR: 'Empty term and query_key - nothing todo' } })
    );
    const sleep = jest.fn().mockResolvedValue(undefined);
    await expect(esearch('', { fetch, sleep, maxRetries: 3 })).rejects.toMatchObject({
      permanent: true,
      message: expect.stringContaining('Empty term'),
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('トップレベル error（rate limit 等）は一時エラーとしてリトライされる', async () => {
    const fetch = jest
      .fn()
      .mockResolvedValueOnce(makeJsonResponse({ error: 'API rate limit exceeded' }))
      .mockResolvedValueOnce(makeJsonResponse({ esearchresult: { count: '1', idlist: ['9'] } }));
    const sleep = jest.fn().mockResolvedValue(undefined);
    const result = await esearch('x', { fetch, sleep, maxRetries: 3 });
    expect(result.count).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test('warninglist（stopword 無視等）はエラーにしない', async () => {
    const fetch = jest.fn().mockResolvedValue(
      makeJsonResponse({
        esearchresult: {
          count: '5',
          idlist: ['1'],
          warninglist: { phrasesignored: ['the'], quotedphrasesnotfound: [], outputmessages: [] },
        },
      })
    );
    const result = await esearch('x', { fetch });
    expect(result.count).toBe(5);
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

describe('レートリミッタ（issue #59）', () => {
  test('NCBI のレート定数は仕様どおり（キー無し 3 req/s、キー有り 10 req/s）', () => {
    expect(NCBI_RATE_LIMIT_WITHOUT_API_KEY).toBe(3);
    expect(NCBI_RATE_LIMIT_WITH_API_KEY).toBe(10);
  });

  test('esearch は fetch 前に rateLimiter.acquire() を呼ぶ', async () => {
    const calls: string[] = [];
    const fetch = jest.fn(async () => {
      calls.push('fetch');
      return makeJsonResponse({ esearchresult: { count: '0', idlist: [] } });
    });
    const rateLimiter: RateLimiter = {
      acquire: jest.fn(async () => {
        calls.push('acquire');
      }),
    };
    await esearch('x', { fetch, rateLimiter });
    expect(calls).toEqual(['acquire', 'fetch']);
  });

  test('efetchArticles は fetch 前に rateLimiter.acquire() を呼ぶ', async () => {
    const calls: string[] = [];
    const fetch = jest.fn(async () => {
      calls.push('fetch');
      return makeXmlResponse('<?xml version="1.0"?><PubmedArticleSet></PubmedArticleSet>');
    });
    const rateLimiter: RateLimiter = {
      acquire: jest.fn(async () => {
        calls.push('acquire');
      }),
    };
    await efetchArticles(['1'], { fetch, rateLimiter });
    expect(calls).toEqual(['acquire', 'fetch']);
  });

  test('efetchArticles は pmids が空なら acquire() すら呼ばない（HTTP リクエストが無いため）', async () => {
    const rateLimiter: RateLimiter = { acquire: jest.fn().mockResolvedValue(undefined) };
    await efetchArticles([], { fetch: jest.fn(), rateLimiter });
    expect(rateLimiter.acquire).not.toHaveBeenCalled();
  });

  test('deps.rateLimiter を渡すと、共有バケットではなくそちらが使われる', async () => {
    const fetch = jest
      .fn()
      .mockResolvedValue(makeJsonResponse({ esearchresult: { count: '0', idlist: [] } }));
    const acquire = jest.fn().mockResolvedValue(undefined);
    const withoutApiKeySpy = jest.spyOn(sharedEutilsRateLimiters.withoutApiKey, 'acquire');
    await esearch('x', { fetch, rateLimiter: { acquire } });
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(withoutApiKeySpy).not.toHaveBeenCalled();
    withoutApiKeySpy.mockRestore();
  });

  test('apiKey 無しは共有 withoutApiKey バケットを、apiKey 有りは共有 withApiKey バケットを使う', async () => {
    const fetch = jest
      .fn()
      .mockResolvedValue(makeJsonResponse({ esearchresult: { count: '0', idlist: [] } }));
    const withoutApiKeySpy = jest.spyOn(sharedEutilsRateLimiters.withoutApiKey, 'acquire');
    const withApiKeySpy = jest.spyOn(sharedEutilsRateLimiters.withApiKey, 'acquire');

    await esearch('x', { fetch });
    expect(withoutApiKeySpy).toHaveBeenCalledTimes(1);
    expect(withApiKeySpy).not.toHaveBeenCalled();

    await esearch('x', { fetch, apiKey: 'secret' });
    expect(withApiKeySpy).toHaveBeenCalledTimes(1);
    expect(withoutApiKeySpy).toHaveBeenCalledTimes(1); // 増えていない

    withoutApiKeySpy.mockRestore();
    withApiKeySpy.mockRestore();
  });

  test('リトライの度に acquire() を呼び直す（発行される HTTP リクエストの数だけ枠を消費する）', async () => {
    const acquire = jest.fn().mockResolvedValue(undefined);
    const fetch = jest
      .fn()
      .mockResolvedValueOnce(makeErrorResponse(503))
      .mockResolvedValueOnce(makeJsonResponse({ esearchresult: { count: '1', idlist: ['9'] } }));
    const sleep = jest.fn().mockResolvedValue(undefined);
    const result = await esearch('x', {
      fetch,
      sleep,
      rateLimiter: { acquire },
      maxRetries: 3,
    });
    expect(result.pmids).toEqual(['9']);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(acquire).toHaveBeenCalledTimes(2);
  });

  test('容量を超えるバーストは不足分だけ待たされ、レート（3 req/s）を超えて fetch されない', async () => {
    // 実タイマーは使わず、now / sleep を注入した TokenBucket で決定的に検証する
    // （sleep は「時間を進める」だけの偽実装で、実際には待たない）。
    let clockMs = 0;
    const sleep = jest.fn(async (ms: number) => {
      clockMs += ms;
    });
    const rateLimiter = new TokenBucket({ ratePerSecond: 3, now: () => clockMs, sleep });
    const fetch = jest
      .fn()
      .mockResolvedValue(makeJsonResponse({ esearchresult: { count: '0', idlist: [] } }));

    for (let i = 0; i < 4; i += 1) {
      await esearch('x', { fetch, rateLimiter });
    }

    expect(fetch).toHaveBeenCalledTimes(4);
    // capacity=3 の初期バーストは待たず、4 回目だけ不足分（1/3 秒）だけ待つ
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls[0]?.[0]).toBeCloseTo(1000 / 3, 5);
  });

  // sharedEutilsRateLimiters は capacity を省略せず 1 を明示している（無バーストの要件）。
  // capacity が誤って ratePerSecond と同値（旧実装のバグ）に戻ると、reset() 直後に
  // 複数回連続で即時 acquire() できてしまう。reset() 直後に 2 回 acquire() を呼び、
  // 1 回目は即時、2 回目は実時間の待機（補充待ち）が必要になることを固定するヘルパー。
  // このバケットはモジュールスコープの実インスタンスで now/sleep を注入できないため、
  // 実タイマーで検証するが、待つのは「まだ解決していないこと」の確認用に短い猶予
  // （補充間隔より確実に短い時間）だけで、それを超えて待つのは片付け（2 回目の完了待ち）
  // の 1 回だけに留める。
  async function expectBucketDoesNotBurst(
    bucket: TokenBucket,
    graceMs: number
  ): Promise<void> {
    bucket.reset();

    await bucket.acquire(); // 1 回目: 満タンの 1 個を即時消費（待機なし）

    let secondResolved = false;
    const second = bucket.acquire().then(() => {
      secondResolved = true;
    });

    // 実時間を短く進めるだけ。capacity=1 なら 2 回目の補充に補充間隔ぶんかかるため、
    // graceMs 時点ではまだ解決していないはず（capacity=ratePerSecond のバグ実装なら即時解決してしまう）。
    await new Promise((resolve) => setTimeout(resolve, graceMs));
    expect(secondResolved).toBe(false);

    await second; // タイマーを残さないよう完了まで待ってから後片付け
    expect(secondResolved).toBe(true);
  }

  test('sharedEutilsRateLimiters.withoutApiKey はバーストしない（capacity: 1 の固定回帰テスト）', async () => {
    // 3 req/s → 補充間隔 約 333ms。50ms の猶予は十分に短い。
    await expectBucketDoesNotBurst(sharedEutilsRateLimiters.withoutApiKey, 50);
  });

  test('sharedEutilsRateLimiters.withApiKey はバーストしない（capacity: 1 の固定回帰テスト）', async () => {
    // 10 req/s → 補充間隔 約 100ms。50ms の猶予はそれより短いので同じ書き方が使える。
    // withApiKey は待機自体が約 100ms で済むため、2 テスト合計の待ち時間は 500ms 程度に収まる。
    await expectBucketDoesNotBurst(sharedEutilsRateLimiters.withApiKey, 50);
  });
});

describe('EutilsError', () => {
  test('status プロパティを保持する', () => {
    const err = new EutilsError('boom', 503);
    expect(err.status).toBe(503);
    expect(err.name).toBe('EutilsError');
  });

  test('permanent は既定で false（既存呼び出し側との後方互換）', () => {
    const err = new EutilsError('boom', 503);
    expect(err.permanent).toBe(false);
  });

  test('permanent を明示的に true にできる', () => {
    const err = new EutilsError('構文エラー', 200, true);
    expect(err.permanent).toBe(true);
  });
});
