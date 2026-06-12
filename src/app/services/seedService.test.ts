import { SHEET_HEADERS } from '@/domain/sheetsSchema';
import { createStore, type AppState } from '../store';
import {
  fillPmidForRisRow,
  ingestSeeds,
  invalidateSeed,
  setSeedEnabled,
  listSeeds,
  retrySeed,
  type IngestInput,
  type SeedServiceDeps,
} from './seedService';

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
    protocolDraftPersisted: false,
    protocolDraft: null,
    currentProtocolVersion: null,
    currentFormulaVersionId: null,
    currentFormulaMarkdown: null,
    validationResult: null,
    missedAnalysis: null,
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
    newUuid: (() => {
      let i = 0;
      return () => {
        i += 1;
        return `seed-${i}`;
      };
    })(),
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

  // §4.3: user_removed 済み PMID の再 ingest は新規有効行として復活させず、
  // duplicate_pmid 行を追記する（「一度無効化した事実」を監査ログに残す）。
  test('user_removed 行がある PMID の再 ingest は duplicate_pmid で追記（有効行は作らない）', async () => {
    const { sheetsFetchMock, eutilsFetchMock, deps } = setupDeps();
    // 既存に user_removed の行を持たせる
    const removedRow: string[] = header.map(() => '');
    removedRow[header.indexOf('pmid')] = '111';
    removedRow[header.indexOf('is_valid')] = 'false';
    removedRow[header.indexOf('exclusion_reason')] = 'user_removed';
    removedRow[header.indexOf('source')] = 'initial';
    removedRow[header.indexOf('ingest_format')] = 'pmid_direct';
    sheetsFetchMock.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/values/SeedPapers')) {
        return jsonResponse({ values: [header, removedRow] });
      }
      return jsonResponse({});
    });
    const summary = await ingestSeeds({ mode: 'pmid_direct', pmids: ['111'] }, deps);
    expect(summary.valid).toBe(0);
    expect(summary.invalid).toBe(1);
    expect(summary.reasons.duplicate_pmid).toBe(1);
    // 重複扱いなので E-utilities 検証は走らない
    expect(eutilsFetchMock).not.toHaveBeenCalled();
    // 追記された 1 行は duplicate_pmid（有効行ではない）
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
    expect(map['is_valid']).toBe(false);
    expect(map['exclusion_reason']).toBe('duplicate_pmid');
  });

  // §4.3: pmid_not_found 行のみの PMID は重複扱いにしない。
  // 「再試行」経路（retrySeed）と同じく、再 ingest で見つかれば新規有効行を作る。
  test('pmid_not_found 行のみの PMID の再 ingest は通常どおり有効行を作る（再試行経路）', async () => {
    const { sheetsFetchMock, eutilsFetchMock, deps } = setupDeps();
    const notFoundRow: string[] = header.map(() => '');
    notFoundRow[header.indexOf('pmid')] = '111';
    notFoundRow[header.indexOf('is_valid')] = 'false';
    notFoundRow[header.indexOf('exclusion_reason')] = 'pmid_not_found';
    notFoundRow[header.indexOf('source')] = 'initial';
    notFoundRow[header.indexOf('ingest_format')] = 'pmid_direct';
    sheetsFetchMock.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/values/SeedPapers')) {
        return jsonResponse({ values: [header, notFoundRow] });
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
    const summary = await ingestSeeds({ mode: 'pmid_direct', pmids: ['111'] }, deps);
    // 重複扱いされず、新規有効行が作られる
    expect(summary.valid).toBe(1);
    expect(summary.reasons.duplicate_pmid).toBe(0);
    expect(eutilsFetchMock).toHaveBeenCalled();
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
    expect(map['is_valid']).toBe(true);
    expect(map['exclusion_reason']).toBe('');
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

  // §4.3: 同一バッチ内の重複も監査用に duplicate_pmid 行として残す（先頭だけ残す挙動から変更）。
  // 空文字・空白のみは引き続き除外する。
  test('同リクエスト内の重複は 2 件目以降を duplicate_pmid で追記（空文字は除外）', async () => {
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
    // 1 件目=有効、2 件目=duplicate_pmid。空文字 2 件は除外。
    expect(summary.registered).toBe(2);
    expect(summary.valid).toBe(1);
    expect(summary.invalid).toBe(1);
    expect(summary.reasons.duplicate_pmid).toBe(1);
    // duplicate 行も added に含まれる
    expect(summary.added).toHaveLength(2);
    expect(summary.added[1]?.exclusionReason).toBe('duplicate_pmid');
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
      if (typeof url === 'string' && url.includes('/drive/v3/files?fields=files')) {
        return jsonResponse({ files: [] });
      }
      if (typeof url === 'string' && url.includes('/drive/v3/files?fields=id,webViewLink')) {
        return jsonResponse({ id: 'folder-or-file', webViewLink: 'https://drive/folder' });
      }
      if (typeof url === 'string' && url.includes('/upload/drive/v3/files')) {
        return jsonResponse({ id: 'raw-ris', webViewLink: 'https://drive/raw-ris' });
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
    expect(map['original_payload_ref']).toBe('https://drive/raw-ris');
  });

  test('newUuid を省略しても ris_no_pmid の payload を保存できる', async () => {
    const { sheetsFetchMock, eutilsFetchMock, deps } = setupDeps();
    sheetsFetchMock.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/values/SeedPapers')) {
        return jsonResponse(emptySheetsListResponse);
      }
      if (typeof url === 'string' && url.includes('/drive/v3/files?fields=files')) {
        return jsonResponse({ files: [] });
      }
      if (typeof url === 'string' && url.includes('/drive/v3/files?fields=id,webViewLink')) {
        return jsonResponse({ id: 'folder-or-file', webViewLink: 'https://drive/folder' });
      }
      if (typeof url === 'string' && url.includes('/upload/drive/v3/files')) {
        return jsonResponse({ id: 'raw-ris', webViewLink: 'https://drive/raw-ris' });
      }
      return jsonResponse({});
    });
    eutilsFetchMock.mockResolvedValue(
      jsonResponse({ esearchresult: { count: '0', idlist: [] } })
    );
    const withoutUuid: SeedServiceDeps = { ...deps };
    delete (withoutUuid as { newUuid?: unknown }).newUuid;
    await expect(
      ingestSeeds(
        { mode: 'ris', text: 'TY  - JOUR\nDB  - Scopus\nTI  - My Paper\nER  - \n' },
        withoutUuid
      )
    ).resolves.toBeDefined();
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

describe('listSeeds / invalidateSeed / retrySeed', () => {
  function rowFor(overrides: Partial<Record<string, string>>): string[] {
    const base: Record<string, string> = {
      pmid: '111',
      title: 'T',
      year: '2020',
      source: 'initial',
      ingest_format: 'pmid_direct',
      original_db: '',
      is_valid: 'true',
      exclusion_reason: '',
      original_payload_ref: '',
      user_decision: '',
      decided_at: '',
      decided_by: '',
      note: '',
    };
    return header.map((key) => overrides[key] ?? base[key] ?? '');
  }

  test('listSeeds は行番号付きで一覧を返す', async () => {
    const { sheetsFetchMock, deps } = setupDeps();
    sheetsFetchMock.mockResolvedValue(
      jsonResponse({
        values: [
          header,
          rowFor({ pmid: '111' }),
          rowFor({ pmid: '222', is_valid: 'false', exclusion_reason: 'pmid_not_found' }),
        ],
      })
    );
    const rows = await listSeeds(deps);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.rowIndex).toBe(2);
    expect(rows[1]?.rowIndex).toBe(3);
    expect(rows[1]?.seed.exclusionReason).toBe('pmid_not_found');
  });

  test('invalidateSeed は当該行を user_removed へ PUT する', async () => {
    const { sheetsFetchMock, deps } = setupDeps();
    sheetsFetchMock.mockResolvedValue(jsonResponse({}));
    const seed = {
      pmid: '111',
      title: 'T',
      year: 2020,
      source: 'initial' as const,
      ingestFormat: 'pmid_direct' as const,
      originalDb: null,
      isValid: true,
      exclusionReason: null,
      originalPayloadRef: null,
      userDecision: null,
      decidedAt: null,
      decidedBy: null,
      note: null,
    };
    const updated = await invalidateSeed(2, seed, deps);
    expect(updated.isValid).toBe(false);
    expect(updated.exclusionReason).toBe('user_removed');
    const putCall = sheetsFetchMock.mock.calls.find(
      (c) => (c[1] as RequestInit | undefined)?.method === 'PUT'
    );
    expect(putCall).toBeDefined();
    expect(decodeURIComponent(putCall![0] as string)).toContain('SeedPapers!A2:Z2');
  });

  test('setSeedEnabled(false) は当該行を user_disabled へ PUT する', async () => {
    const { sheetsFetchMock, deps } = setupDeps();
    sheetsFetchMock.mockResolvedValue(jsonResponse({}));
    const seed = {
      pmid: '111',
      title: 'T',
      year: 2020,
      source: 'initial' as const,
      ingestFormat: 'pmid_direct' as const,
      originalDb: null,
      isValid: true,
      exclusionReason: null,
      originalPayloadRef: null,
      userDecision: null,
      decidedAt: null,
      decidedBy: null,
      note: null,
    };
    const updated = await setSeedEnabled(2, seed, false, deps);
    expect(updated.isValid).toBe(false);
    expect(updated.exclusionReason).toBe('user_disabled');
    const putCall = sheetsFetchMock.mock.calls.find(
      (c) => (c[1] as RequestInit | undefined)?.method === 'PUT'
    );
    expect(putCall).toBeDefined();
    expect(decodeURIComponent(putCall![0] as string)).toContain('SeedPapers!A2:Z2');
  });

  test('setSeedEnabled(true) は user_disabled 行を有効へ戻す', async () => {
    const { sheetsFetchMock, deps } = setupDeps();
    sheetsFetchMock.mockResolvedValue(jsonResponse({}));
    const seed = {
      pmid: '111',
      title: 'T',
      year: 2020,
      source: 'initial' as const,
      ingestFormat: 'pmid_direct' as const,
      originalDb: null,
      isValid: false,
      exclusionReason: 'user_disabled' as const,
      originalPayloadRef: null,
      userDecision: null,
      decidedAt: null,
      decidedBy: null,
      note: null,
    };
    const updated = await setSeedEnabled(2, seed, true, deps);
    expect(updated.isValid).toBe(true);
    expect(updated.exclusionReason).toBeNull();
  });

  test('retrySeed は 1 PMID で再 ingest する（見つかれば有効行追記）', async () => {
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
    const summary = await retrySeed('111', deps);
    expect(summary.registered).toBe(1);
    expect(summary.valid).toBe(1);
  });

  test('プロジェクト未選択時 listSeeds はエラー', async () => {
    const { store, deps } = setupDeps();
    store.setState((s) => ({ ...s, project: null }));
    await expect(listSeeds(deps)).rejects.toThrow(/プロジェクト/);
  });

  test('fillPmidForRisRow は手入力 PMID を pmid_direct で ingest する（見つかれば有効行追記）', async () => {
    const { sheetsFetchMock, eutilsFetchMock, deps } = setupDeps();
    sheetsFetchMock.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/values/SeedPapers')) {
        return jsonResponse(emptySheetsListResponse);
      }
      return jsonResponse({});
    });
    eutilsFetchMock
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '1', idlist: ['99999'] } }))
      .mockResolvedValueOnce(
        xmlResponse(
          `<?xml version="1.0"?><PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>99999</PMID><Article><ArticleTitle>RIS Supplement</ArticleTitle></Article></MedlineCitation></PubmedArticle></PubmedArticleSet>`
        )
      );
    const summary = await fillPmidForRisRow('99999', deps);
    expect(summary.registered).toBe(1);
    expect(summary.valid).toBe(1);
    const appendBody = JSON.parse(
      (sheetsFetchMock.mock.calls.find((c) => (c[0] as string).includes(':append'))![1] as RequestInit)
        .body as string
    ) as { values: (string | number | boolean | null)[][] };
    const row = appendBody.values[0]!;
    const map: Record<string, string | number | boolean | null> = {};
    header.forEach((k, i) => { map[k] = row[i] as string | number | boolean | null; });
    expect(map['pmid']).toBe('99999');
    expect(map['is_valid']).toBe(true);
    expect(map['ingest_format']).toBe('pmid_direct');
  });

  test('fillPmidForRisRow は前後の空白をトリムする', async () => {
    const { sheetsFetchMock, eutilsFetchMock, deps } = setupDeps();
    sheetsFetchMock.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/values/SeedPapers')) {
        return jsonResponse(emptySheetsListResponse);
      }
      return jsonResponse({});
    });
    eutilsFetchMock
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '1', idlist: ['12345'] } }))
      .mockResolvedValueOnce(
        xmlResponse(
          `<?xml version="1.0"?><PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>12345</PMID><Article><ArticleTitle>T</ArticleTitle></Article></MedlineCitation></PubmedArticle></PubmedArticleSet>`
        )
      );
    const summary = await fillPmidForRisRow('  12345  ', deps);
    expect(summary.valid).toBe(1);
  });
});
