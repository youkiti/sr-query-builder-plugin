import { SHEET_HEADERS } from '@/domain/sheetsSchema';
import { createStore, type AppState } from '../store';
import { ingestSeeds, type IngestInput, type SeedServiceDeps } from './seedService';

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function xmlResponse(xml: string): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({}),
    text: async () => xml,
  } as Response;
}

function makeState(): AppState {
  return {
    route: 'seeds',
    project: { projectId: 'p', spreadsheetId: 'SHEET-1', driveFolderId: 'D', title: 'T' },
    cumulativeCostUsd: null,
    blocksDraft: null,
    protocolDraft: null,
    currentProtocolVersion: null,
    currentFormulaVersionId: null,
    currentFormulaMarkdown: null,
  };
}

const header = [...SHEET_HEADERS.SeedPapers];
const emptySheetsListResponse = { values: [header] };

function setupDeps(): {
  store: ReturnType<typeof createStore>;
  sheetsFetchMock: jest.Mock;
  eutilsFetchMock: jest.Mock;
  deps: SeedServiceDeps;
} {
  const store = createStore(makeState());
  const sheetsFetchMock = jest.fn().mockResolvedValue(jsonResponse(emptySheetsListResponse));
  const eutilsFetchMock = jest.fn();
  const deps: SeedServiceDeps = {
    google: {
      fetch: sheetsFetchMock as unknown as typeof fetch,
      getAccessToken: jest.fn().mockResolvedValue('t'),
    },
    eutils: {
      fetch: eutilsFetchMock as unknown as typeof fetch,
      sleep: async () => undefined,
      maxRetries: 0,
    },
    store,
  };
  return { store, sheetsFetchMock, eutilsFetchMock, deps };
}

describe('ingestSeeds - PMID direct', () => {
  test('有効 PMID を SeedPapers に追記する', async () => {
    const { sheetsFetchMock, eutilsFetchMock, deps } = setupDeps();
    // 1 回目: hasValidSeedPmid 用 listSeedPapers（ヘッダのみ）
    // 2 回目: appendSeedPaper
    sheetsFetchMock.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/values/SeedPapers')) {
        return jsonResponse(emptySheetsListResponse);
      }
      return jsonResponse({});
    });
    eutilsFetchMock
      // esearch for '111[uid]' → count=1
      .mockResolvedValueOnce(
        jsonResponse({ esearchresult: { count: '1', idlist: ['111'] } })
      )
      // efetch for ['111']
      .mockResolvedValueOnce(
        xmlResponse(
          `<?xml version="1.0"?><PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>111</PMID><Article><ArticleTitle>TITLE</ArticleTitle><Journal><JournalIssue><PubDate><Year>2020</Year></PubDate></JournalIssue></Journal></Article></MedlineCitation></PubmedArticle></PubmedArticleSet>`
        )
      );
    const input: IngestInput = { mode: 'pmid_direct', pmids: ['111'] };
    const summary = await ingestSeeds(input, deps);
    expect(summary.registered).toBe(1);
    expect(summary.valid).toBe(1);
    expect(summary.invalid).toBe(0);
    const appendCalls = sheetsFetchMock.mock.calls.filter((c) =>
      (c[0] as string).includes(':append')
    );
    expect(appendCalls).toHaveLength(1);
  });

  test('存在しない PMID は pmid_not_found で追記', async () => {
    const { sheetsFetchMock, eutilsFetchMock, deps } = setupDeps();
    sheetsFetchMock.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/values/SeedPapers')) {
        return jsonResponse(emptySheetsListResponse);
      }
      return jsonResponse({});
    });
    eutilsFetchMock.mockResolvedValueOnce(
      jsonResponse({ esearchresult: { count: '0', idlist: [] } })
    );
    const summary = await ingestSeeds({ mode: 'pmid_direct', pmids: ['999'] }, deps);
    expect(summary.valid).toBe(0);
    expect(summary.invalid).toBe(1);
    expect(summary.reasons.pmid_not_found).toBe(1);
    const appendBody = JSON.parse(
      (sheetsFetchMock.mock.calls.find((c) => (c[0] as string).includes(':append'))![1] as RequestInit)
        .body as string
    ) as { values: (string | number | boolean | null)[][] };
    const row = appendBody.values[0]!;
    const map: Record<string, string | number | boolean | null> = {};
    header.forEach((k, i) => {
      map[k] = row[i] as string | number | boolean | null;
    });
    expect(map['pmid']).toBe('999');
    expect(map['is_valid']).toBe(false);
    expect(map['exclusion_reason']).toBe('pmid_not_found');
  });

  test('重複 PMID は duplicate_pmid で追記（上書きしない）', async () => {
    const { sheetsFetchMock, eutilsFetchMock, deps } = setupDeps();
    // hasValidSeedPmid が true を返すよう既存の有効行を返す
    const existingRow: string[] = header.map(() => '');
    existingRow[header.indexOf('pmid')] = '111';
    existingRow[header.indexOf('is_valid')] = 'true';
    existingRow[header.indexOf('source')] = 'initial';
    existingRow[header.indexOf('ingest_format')] = 'pmid_direct';
    sheetsFetchMock.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/values/SeedPapers')) {
        return jsonResponse({ values: [header, existingRow] });
      }
      return jsonResponse({});
    });
    const summary = await ingestSeeds({ mode: 'pmid_direct', pmids: ['111'] }, deps);
    expect(summary.valid).toBe(0);
    expect(summary.reasons.duplicate_pmid).toBe(1);
    // verifyPmids 側は呼ばれない（重複扱いで早期スキップ）
    expect(eutilsFetchMock).not.toHaveBeenCalled();
  });

  test('esearch で有効だが efetch に現れない PMID でも title/year=null で保存', async () => {
    const { sheetsFetchMock, eutilsFetchMock, deps } = setupDeps();
    sheetsFetchMock.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/values/SeedPapers')) {
        return jsonResponse(emptySheetsListResponse);
      }
      return jsonResponse({});
    });
    eutilsFetchMock
      // esearch: PMID 実在
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '1', idlist: ['111'] } }))
      // efetch: 空結果（稀なレース状態の再現）
      .mockResolvedValueOnce(
        xmlResponse(`<?xml version="1.0"?><PubmedArticleSet></PubmedArticleSet>`)
      );
    const summary = await ingestSeeds({ mode: 'pmid_direct', pmids: ['111'] }, deps);
    expect(summary.valid).toBe(1);
    const appendBody = JSON.parse(
      (sheetsFetchMock.mock.calls.find((c) => (c[0] as string).includes(':append'))![1] as RequestInit)
        .body as string
    ) as { values: (string | number | boolean | null)[][] };
    const row = appendBody.values[0]!;
    const map: Record<string, string | number | boolean | null> = {};
    header.forEach((k, i) => {
      map[k] = row[i] as string | number | boolean | null;
    });
    expect(map['pmid']).toBe('111');
    expect(map['title']).toBe('');
    expect(map['year']).toBe('');
  });

  test('同リクエスト内の重複は先頭だけ残して後続スキップ（空文字も除外）', async () => {
    const { sheetsFetchMock, eutilsFetchMock, deps } = setupDeps();
    sheetsFetchMock.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/values/SeedPapers')) {
        return jsonResponse(emptySheetsListResponse);
      }
      return jsonResponse({});
    });
    eutilsFetchMock
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '1', idlist: ['111'] } }))
      .mockResolvedValueOnce(
        xmlResponse(
          `<?xml version="1.0"?><PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>111</PMID><Article><ArticleTitle>X</ArticleTitle></Article></MedlineCitation></PubmedArticle></PubmedArticleSet>`
        )
      );
    const summary = await ingestSeeds(
      { mode: 'pmid_direct', pmids: ['111', '111', '', '   '] },
      deps
    );
    expect(summary.registered).toBe(1);
  });
});

describe('ingestSeeds - NBIB', () => {
  test('NBIB から PMID を抽出し E-utilities で検証する', async () => {
    const { sheetsFetchMock, eutilsFetchMock, deps } = setupDeps();
    sheetsFetchMock.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/values/SeedPapers')) {
        return jsonResponse(emptySheetsListResponse);
      }
      return jsonResponse({});
    });
    eutilsFetchMock
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '1', idlist: ['222'] } }))
      .mockResolvedValueOnce(
        xmlResponse(
          `<?xml version="1.0"?><PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>222</PMID><Article><ArticleTitle>TT</ArticleTitle></Article></MedlineCitation></PubmedArticle></PubmedArticleSet>`
        )
      );
    const nbib = 'PMID- 222\nTI  - TT\n';
    const summary = await ingestSeeds({ mode: 'nbib', text: nbib }, deps);
    expect(summary.valid).toBe(1);
  });
});

describe('ingestSeeds - RIS', () => {
  test('DB=PubMed + AN=数字なら ris_pubmed で登録', async () => {
    const { sheetsFetchMock, eutilsFetchMock, deps } = setupDeps();
    sheetsFetchMock.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/values/SeedPapers')) {
        return jsonResponse(emptySheetsListResponse);
      }
      return jsonResponse({});
    });
    eutilsFetchMock
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '1', idlist: ['333'] } }))
      .mockResolvedValueOnce(
        xmlResponse(
          `<?xml version="1.0"?><PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>333</PMID><Article><ArticleTitle>Z</ArticleTitle></Article></MedlineCitation></PubmedArticle></PubmedArticleSet>`
        )
      );
    const ris = 'TY  - JOUR\nDB  - PubMed\nAN  - 333\nER  - \n';
    const summary = await ingestSeeds({ mode: 'ris', text: ris }, deps);
    expect(summary.valid).toBe(1);
    const appendBody = JSON.parse(
      (sheetsFetchMock.mock.calls.find((c) => (c[0] as string).includes(':append'))![1] as RequestInit)
        .body as string
    ) as { values: (string | number | boolean | null)[][] };
    const row = appendBody.values[0]!;
    const map: Record<string, string | number | boolean | null> = {};
    header.forEach((k, i) => {
      map[k] = row[i] as string | number | boolean | null;
    });
    expect(map['ingest_format']).toBe('ris_pubmed');
    expect(map['original_db']).toBe('PubMed');
  });

  test('PMID に辿り着けない RIS は ris_no_pmid として追記', async () => {
    const { sheetsFetchMock, eutilsFetchMock, deps } = setupDeps();
    sheetsFetchMock.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/values/SeedPapers')) {
        return jsonResponse(emptySheetsListResponse);
      }
      return jsonResponse({});
    });
    // DOI 解決でも 0 件
    eutilsFetchMock.mockResolvedValue(
      jsonResponse({ esearchresult: { count: '0', idlist: [] } })
    );
    const ris = 'TY  - JOUR\nDB  - Scopus\nTI  - My Paper\nPY  - 2021\nER  - \n';
    const summary = await ingestSeeds({ mode: 'ris', text: ris }, deps);
    expect(summary.registered).toBe(1);
    expect(summary.invalid).toBe(1);
    expect(summary.reasons.no_pmid_resolved).toBe(1);
    const appendBody = JSON.parse(
      (sheetsFetchMock.mock.calls.find((c) => (c[0] as string).includes(':append'))![1] as RequestInit)
        .body as string
    ) as { values: (string | number | boolean | null)[][] };
    const row = appendBody.values[0]!;
    const map: Record<string, string | number | boolean | null> = {};
    header.forEach((k, i) => {
      map[k] = row[i] as string | number | boolean | null;
    });
    expect(map['ingest_format']).toBe('ris_no_pmid');
    expect(map['pmid']).toBe('');
    expect(map['title']).toBe('My Paper');
    expect(map['year']).toBe(2021);
    expect(map['original_db']).toBe('Scopus');
  });
});

describe('ingestSeeds - エラーケース', () => {
  test('プロジェクト未選択はエラー', async () => {
    const { store, deps } = setupDeps();
    store.setState((s) => ({ ...s, project: null }));
    await expect(
      ingestSeeds({ mode: 'pmid_direct', pmids: ['1'] }, deps)
    ).rejects.toThrow(/プロジェクト/);
  });

  test('now を省略しても動く', async () => {
    const { sheetsFetchMock, eutilsFetchMock, deps } = setupDeps();
    sheetsFetchMock.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/values/SeedPapers')) {
        return jsonResponse(emptySheetsListResponse);
      }
      return jsonResponse({});
    });
    eutilsFetchMock
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '0', idlist: [] } }));
    const withoutNow: SeedServiceDeps = { ...deps };
    delete (withoutNow as { now?: unknown }).now;
    await expect(
      ingestSeeds({ mode: 'pmid_direct', pmids: ['1'] }, withoutNow)
    ).resolves.toBeDefined();
  });
});
