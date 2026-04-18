import { verifyPmids, verifySinglePmid } from './verifyPmid';

function makeJson(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe('verifyPmids', () => {
  test('実在する PMID は isValid=true、article を補完する', async () => {
    const esearchJson = { esearchresult: { count: '1', idlist: ['111'] } };
    const xml = `<?xml version="1.0"?><PubmedArticleSet>
      <PubmedArticle><MedlineCitation><PMID>111</PMID><Article><ArticleTitle>T</ArticleTitle><Journal><JournalIssue><PubDate><Year>2022</Year></PubDate></JournalIssue></Journal></Article></MedlineCitation></PubmedArticle>
    </PubmedArticleSet>`;
    const fetch = jest
      .fn()
      .mockResolvedValueOnce(makeJson(esearchJson))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () => xml,
      } as Response);

    const result = await verifyPmids(['111'], { fetch });
    expect(result).toEqual([
      {
        pmid: '111',
        isValid: true,
        article: { pmid: '111', title: 'T', year: 2022, meshHeadings: [] },
      },
    ]);
  });

  test('存在しない PMID は isValid=false、article=null', async () => {
    const esearchJson = { esearchresult: { count: '0', idlist: [] } };
    const fetch = jest.fn().mockResolvedValue(makeJson(esearchJson));
    const result = await verifyPmids(['999'], { fetch });
    expect(result[0]).toEqual({ pmid: '999', isValid: false, article: null });
    // efetch は valid が 0 件なので呼ばれない
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('空配列なら fetch を呼ばず [] を返す', async () => {
    const fetch = jest.fn();
    await expect(verifyPmids([], { fetch })).resolves.toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('複数 PMID 混在（valid と invalid が混ざる）', async () => {
    const fetch = jest
      .fn()
      // 1件目 esearch
      .mockResolvedValueOnce(makeJson({ esearchresult: { count: '1', idlist: ['1'] } }))
      // 2件目 esearch
      .mockResolvedValueOnce(makeJson({ esearchresult: { count: '0', idlist: [] } }))
      // efetch（valid=1 件のみ）
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () =>
          `<?xml version="1.0"?><PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>1</PMID><Article><ArticleTitle>X</ArticleTitle></Article></MedlineCitation></PubmedArticle></PubmedArticleSet>`,
      } as Response);
    const result = await verifyPmids(['1', '2'], { fetch });
    expect(result[0]?.isValid).toBe(true);
    expect(result[1]?.isValid).toBe(false);
  });
});

describe('verifySinglePmid', () => {
  test('1 件だけチェックして結果を返す', async () => {
    const fetch = jest
      .fn()
      .mockResolvedValue(makeJson({ esearchresult: { count: '0', idlist: [] } }));
    const result = await verifySinglePmid('42', { fetch });
    expect(result).toEqual({ pmid: '42', isValid: false, article: null });
  });
});
