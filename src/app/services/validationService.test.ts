import { SHEET_HEADERS } from '@/domain/sheetsSchema';
import type { ChatMessage, LLMProvider } from '@/lib/llm';
import { createStore, type AppState } from '../store';
import {
  analyzeMissedSeeds,
  runValidation,
  type AnalyzeMissedSeedsDeps,
  type ValidationServiceDeps,
} from './validationService';
import type { LlmProviderFactory } from './llmProviderService';

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

const formulaMd = [
  '## PubMed/MEDLINE',
  '',
  '```',
  '#1 diabetes[tiab]',
  '#2 metformin[tiab]',
  '#3 #1 AND #2',
  '```',
  '',
].join('\n');

function makeState(): AppState {
  return {
    route: 'draft',
    project: { projectId: 'p', spreadsheetId: 'SHEET-1', driveFolderId: 'D', title: 'T' },
    cumulativeCostUsd: null,
    blocksDraft: null,
    protocolDraftPersisted: false,
    protocolDraft: null,
    currentProtocolVersion: 3,
    currentFormulaVersionId: 'v-1',
    currentFormulaMarkdown: formulaMd,
    draftRun: null,
    expandRun: null,
    validationResult: null,
    missedAnalysis: null,
    editAutoSave: null,
    blocksDraftSavedAt: null,
    hydrateError: null,
  };
}

const seedHeader = [...SHEET_HEADERS.SeedPapers];
function seedRow(overrides: Partial<Record<string, string>> = {}): string[] {
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
  return seedHeader.map((k) => overrides[k] ?? base[k] ?? '');
}

function setupDeps(seedValuesBody?: { values: string[][] }): {
  store: ReturnType<typeof createStore>;
  sheetsFetchMock: jest.Mock;
  eutilsFetchMock: jest.Mock;
  deps: ValidationServiceDeps;
} {
  const store = createStore(makeState());
  const sheetsFetchMock = jest.fn();
  const eutilsFetchMock = jest.fn();
  sheetsFetchMock.mockImplementation(async (url: string) => {
    if (typeof url === 'string' && url.includes('/values/SeedPapers')) {
      return jsonResponse(seedValuesBody ?? { values: [seedHeader, seedRow()] });
    }
    return jsonResponse({});
  });
  const deps: ValidationServiceDeps = {
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
        return `val-${i}`;
      };
    })(),
    now: () => '2026-04-19T00:00:00.000Z',
  };
  return { store, sheetsFetchMock, eutilsFetchMock, deps };
}

describe('runValidation', () => {
  test('3 種類の検証を走らせ、ValidationLog に 5 行（行ヒット 3 + final + mesh）追記する', async () => {
    const { sheetsFetchMock, eutilsFetchMock, deps } = setupDeps();
    // esearch x3（行ヒット）
    eutilsFetchMock
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '100', idlist: [] } }))
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '200', idlist: [] } }))
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '50', idlist: [] } }))
      // final_query: total + captured
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '500', idlist: [] } }))
      .mockResolvedValueOnce(
        jsonResponse({ esearchresult: { count: '1', idlist: ['111'] } })
      )
      // efetch for mesh
      .mockResolvedValueOnce(
        xmlResponse(
          `<?xml version="1.0"?><PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>111</PMID><Article><ArticleTitle>X</ArticleTitle></Article><MeshHeadingList><MeshHeading><DescriptorName>Diabetes Mellitus</DescriptorName></MeshHeading></MeshHeadingList></MedlineCitation></PubmedArticle></PubmedArticleSet>`
        )
      )
      // mesh tree 解決: db=mesh esearch → esummary(json)
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { idlist: ['2001'] } }))
      .mockResolvedValueOnce(
        jsonResponse({
          result: { uids: ['2001'], '2001': { ds_idxlinks: [{ treenum: 'C18.452.394' }] } },
        })
      );
    const summary = await runValidation(deps);
    expect(summary.lineHits).toHaveLength(3);
    expect(summary.lineHits[0]?.hitCount).toBe(100);
    expect(summary.finalQuery.totalHits).toBe(500);
    expect(summary.finalQuery.captureRate).toBe(1);
    expect(summary.finalQueryError).toBeNull();
    expect(summary.mesh).toHaveLength(1);
    expect(summary.meshFrequency[0]?.descriptor).toBe('Diabetes Mellitus');
    expect(summary.meshError).toBeNull();
    expect(summary.meshHierarchyError).toBeNull();
    expect(summary.meshHierarchy.map((n) => n.treeId)).toEqual([
      'C',
      'C18',
      'C18.452',
      'C18.452.394',
    ]);
    expect(summary.meshMermaid).toContain('flowchart TD');
    expect(summary.meshMermaid).toContain('C18_452_394["C18.452.394<br/>Diabetes Mellitus"]');
    expect(summary.eligibleSeedCount).toBe(1);
    expect(summary.totalSeedCount).toBe(1);
    expect(summary.loggedValidationIds).toHaveLength(5);
    const appendCalls = sheetsFetchMock.mock.calls.filter((c) =>
      (c[0] as string).includes('ValidationLog') && (c[0] as string).includes(':append')
    );
    expect(appendCalls).toHaveLength(5);
  });

  test('onProgress に各検証段階の進捗を通知する', async () => {
    const { eutilsFetchMock, deps } = setupDeps();
    eutilsFetchMock
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '100', idlist: [] } }))
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '200', idlist: [] } }))
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '50', idlist: [] } }))
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '500', idlist: [] } }))
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '1', idlist: ['111'] } }))
      .mockResolvedValueOnce(
        xmlResponse(
          `<?xml version="1.0"?><PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>111</PMID><Article><ArticleTitle>X</ArticleTitle></Article><MeshHeadingList><MeshHeading><DescriptorName>Diabetes Mellitus</DescriptorName></MeshHeading></MeshHeadingList></MedlineCitation></PubmedArticle></PubmedArticleSet>`
        )
      )
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { idlist: ['2001'] } }))
      .mockResolvedValueOnce(
        jsonResponse({
          result: { uids: ['2001'], '2001': { ds_idxlinks: [{ treenum: 'C18.452.394' }] } },
        })
      );
    const progress: import('./validationService').ValidationProgress[] = [];
    await runValidation({ ...deps, onProgress: (p) => progress.push(p) });
    const steps = progress.map((p) => p.step);
    // 段階が順に通知され、line_hits はブロックごとの内訳も出る
    expect(steps).toContain('line_hits');
    expect(steps).toContain('final_query');
    expect(steps).toContain('mesh');
    expect(steps).toContain('mesh_hierarchy');
    expect(steps).toContain('logging');
    expect(steps[steps.length - 1]).toBe('done');
    const lineHitProgress = progress.filter((p) => p.step === 'line_hits');
    expect(lineHitProgress[lineHitProgress.length - 1]).toEqual({
      step: 'line_hits',
      blockIndex: 3,
      blockCount: 3,
    });
  });

  test('mesh tree 取得のみ失敗した場合、meshFrequency は生きて meshHierarchyError にメッセージが入る', async () => {
    const { eutilsFetchMock, deps } = setupDeps();
    eutilsFetchMock
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '1', idlist: [] } }))
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '1', idlist: [] } }))
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '1', idlist: [] } }))
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '10', idlist: [] } }))
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '1', idlist: ['111'] } }))
      .mockResolvedValueOnce(
        xmlResponse(
          `<?xml version="1.0"?><PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>111</PMID><Article><ArticleTitle>X</ArticleTitle></Article><MeshHeadingList><MeshHeading><DescriptorName>Diabetes Mellitus</DescriptorName></MeshHeading></MeshHeadingList></MedlineCitation></PubmedArticle></PubmedArticleSet>`
        )
      )
      // mesh tree esearch が失敗
      .mockRejectedValueOnce(new Error('mesh tree down'));
    const summary = await runValidation(deps);
    expect(summary.meshError).toBeNull();
    expect(summary.meshFrequency).toHaveLength(1);
    expect(summary.meshHierarchy).toEqual([]);
    expect(summary.meshMermaid).toContain('(MeSH 階層なし)');
    expect(summary.meshHierarchyError).toBe('mesh tree down');
  });

  test('meshFrequency が 0 件なら tree 取得は呼ばれず、meshHierarchy は空のまま', async () => {
    const { eutilsFetchMock, deps } = setupDeps();
    eutilsFetchMock
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '0', idlist: [] } }))
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '0', idlist: [] } }))
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '0', idlist: [] } }))
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '0', idlist: [] } }))
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '0', idlist: [] } }))
      .mockResolvedValueOnce(
        xmlResponse(`<?xml version="1.0"?><PubmedArticleSet></PubmedArticleSet>`)
      );
    const summary = await runValidation(deps);
    expect(summary.meshFrequency).toEqual([]);
    expect(summary.meshHierarchy).toEqual([]);
    expect(summary.meshHierarchyError).toBeNull();
    // mesh tree 取得を呼ばないので、eutils の fetch は 6 回で止まる
    expect(eutilsFetchMock).toHaveBeenCalledTimes(6);
  });

  test('line_hits エラーは totalHits=null で記録する', async () => {
    const { sheetsFetchMock, eutilsFetchMock, deps } = setupDeps();
    eutilsFetchMock
      // line 1: エラー
      .mockRejectedValueOnce(new Error('network'))
      // line 2: OK
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '200', idlist: [] } }))
      // line 3: OK
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '50', idlist: [] } }))
      // final total
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '500', idlist: [] } }))
      // final captured
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '0', idlist: [] } }))
      // efetch
      .mockResolvedValueOnce(
        xmlResponse(`<?xml version="1.0"?><PubmedArticleSet></PubmedArticleSet>`)
      );
    const summary = await runValidation(deps);
    expect(summary.lineHits[0]?.error).toBeTruthy();
    const lineAppendCalls = sheetsFetchMock.mock.calls.filter((c) =>
      (c[0] as string).includes(':append')
    );
    // 1 件目の行ヒット追記行は totalHits=null（空文字）
    const firstLineBody = JSON.parse((lineAppendCalls[0]![1] as RequestInit).body as string) as {
      values: (string | number | boolean | null)[][];
    };
    const totalHitsIdx = SHEET_HEADERS.ValidationLog.indexOf('total_hits');
    expect(firstLineBody.values[0]![totalHitsIdx]).toBe('');
  });

  test('無効 seed は捕捉率計算から除外される', async () => {
    const { sheetsFetchMock, eutilsFetchMock, deps } = setupDeps({
      values: [
        seedHeader,
        seedRow({ pmid: '111' }),
        seedRow({ pmid: '222', is_valid: 'false', exclusion_reason: 'pmid_not_found' }),
      ],
    });
    eutilsFetchMock
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '1', idlist: [] } }))
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '1', idlist: [] } }))
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '1', idlist: [] } }))
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '100', idlist: [] } }))
      .mockResolvedValueOnce(
        jsonResponse({ esearchresult: { count: '1', idlist: ['111'] } })
      )
      .mockResolvedValueOnce(
        xmlResponse(`<?xml version="1.0"?><PubmedArticleSet></PubmedArticleSet>`)
      );
    const summary = await runValidation(deps);
    expect(summary.totalSeedCount).toBe(2);
    expect(summary.eligibleSeedCount).toBe(1);
    // Used sheets fetch to confirm seed list query happened
    expect(
      sheetsFetchMock.mock.calls.some((c) => (c[0] as string).includes('/values/SeedPapers'))
    ).toBe(true);
    // MeSH 頻度が 0 件なので hierarchy 取得はスキップされる
    expect(summary.meshHierarchy).toEqual([]);
  });

  test('final_query / mesh が失敗しても line_hits とログ追記は継続する', async () => {
    const { sheetsFetchMock, eutilsFetchMock, deps } = setupDeps();
    eutilsFetchMock
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '100', idlist: [] } }))
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '200', idlist: [] } }))
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '50', idlist: [] } }))
      .mockRejectedValueOnce('final down')
      .mockRejectedValueOnce('mesh down');
    const summary = await runValidation(deps);
    expect(summary.lineHits).toHaveLength(3);
    expect(summary.finalQueryError).toBe('final down');
    expect(summary.meshError).toBe('mesh down');
    const appendCalls = sheetsFetchMock.mock.calls.filter((c) =>
      (c[0] as string).includes('ValidationLog') && (c[0] as string).includes(':append')
    );
    expect(appendCalls).toHaveLength(5);
    const finalBody = JSON.parse((appendCalls[3]![1] as RequestInit).body as string) as {
      values: (string | number | boolean | null)[][];
    };
    const totalHitsIdx = SHEET_HEADERS.ValidationLog.indexOf('total_hits');
    expect(finalBody.values[0]![totalHitsIdx]).toBe('');
  });

  test('final_query / mesh の Error 例外は message を使う', async () => {
    const { eutilsFetchMock, deps } = setupDeps();
    eutilsFetchMock
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '100', idlist: [] } }))
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '200', idlist: [] } }))
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '50', idlist: [] } }))
      .mockRejectedValueOnce(new Error('final error'))
      .mockRejectedValueOnce(new Error('mesh error'));
    const summary = await runValidation(deps);
    expect(summary.finalQueryError).toBe('final error');
    expect(summary.meshError).toBe('mesh error');
  });

  test('行ごと内訳を Drive に保存して detail_ref を全 ValidationLog 行に埋める（§3.1 / §3.3）', async () => {
    const { sheetsFetchMock, eutilsFetchMock, deps } = setupDeps();
    // Drive のフォルダ GET / アップロード POST を webViewLink 付きで返す
    sheetsFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url.includes('/values/SeedPapers')) {
        return jsonResponse({ values: [seedHeader, seedRow()] });
      }
      if (typeof url === 'string' && url.includes('/upload/drive/v3/files')) {
        return jsonResponse({ id: 'detail-file', webViewLink: 'https://drive/detail.json' });
      }
      if (typeof url === 'string' && url.includes('/drive/v3/files')) {
        // ensureChildFolder の GET（既存なし）→ POST（作成）
        if (init?.method === 'POST') {
          return jsonResponse({ id: 'folder-1', webViewLink: 'https://drive/folder' });
        }
        return jsonResponse({ files: [] });
      }
      return jsonResponse({});
    });
    eutilsFetchMock
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '100', idlist: [] } }))
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '200', idlist: [] } }))
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '50', idlist: [] } }))
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '500', idlist: [] } }))
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '1', idlist: ['111'] } }))
      .mockResolvedValueOnce(
        xmlResponse(`<?xml version="1.0"?><PubmedArticleSet></PubmedArticleSet>`)
      );
    await runValidation(deps);
    const appendCalls = sheetsFetchMock.mock.calls.filter((c) =>
      (c[0] as string).includes('ValidationLog') && (c[0] as string).includes(':append')
    );
    expect(appendCalls).toHaveLength(5);
    const detailRefIdx = SHEET_HEADERS.ValidationLog.indexOf('detail_ref');
    for (const call of appendCalls) {
      const body = JSON.parse((call[1] as RequestInit).body as string) as {
        values: (string | number | boolean | null)[][];
      };
      expect(body.values[0]![detailRefIdx]).toBe('https://drive/detail.json');
    }
    // 行ごと内訳 JSON が Drive にアップロードされている
    const uploadCall = sheetsFetchMock.mock.calls.find((c) =>
      (c[0] as string).includes('/upload/drive/v3/files')
    );
    expect(uploadCall).toBeTruthy();
  });

  test('Drive 保存に失敗しても検証は継続し detail_ref は null（§3.3）', async () => {
    const { sheetsFetchMock, eutilsFetchMock, deps } = setupDeps();
    sheetsFetchMock.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/values/SeedPapers')) {
        return jsonResponse({ values: [seedHeader, seedRow()] });
      }
      if (typeof url === 'string' && url.includes('/drive/v3/files')) {
        // フォルダ確保で失敗させる
        throw new Error('drive down');
      }
      return jsonResponse({});
    });
    eutilsFetchMock
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '100', idlist: [] } }))
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '200', idlist: [] } }))
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '50', idlist: [] } }))
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '500', idlist: [] } }))
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '1', idlist: ['111'] } }))
      .mockResolvedValueOnce(
        xmlResponse(`<?xml version="1.0"?><PubmedArticleSet></PubmedArticleSet>`)
      );
    const summary = await runValidation(deps);
    expect(summary.loggedValidationIds).toHaveLength(5);
    const appendCalls = sheetsFetchMock.mock.calls.filter((c) =>
      (c[0] as string).includes('ValidationLog') && (c[0] as string).includes(':append')
    );
    const detailRefIdx = SHEET_HEADERS.ValidationLog.indexOf('detail_ref');
    for (const call of appendCalls) {
      const body = JSON.parse((call[1] as RequestInit).body as string) as {
        values: (string | number | boolean | null)[][];
      };
      // null は append 時に空文字へ変換される
      expect(body.values[0]![detailRefIdx]).toBe('');
    }
  });

  test('プロジェクト未選択ならエラー', async () => {
    const { store, deps } = setupDeps();
    store.setState((s) => ({ ...s, project: null }));
    await expect(runValidation(deps)).rejects.toThrow(/プロジェクト/);
  });

  test('currentFormulaVersionId / markdown が未設定ならエラー', async () => {
    const { store, deps } = setupDeps();
    store.setState((s) => ({ ...s, currentFormulaVersionId: null }));
    await expect(runValidation(deps)).rejects.toThrow(/ドラフト/);
  });

  test('newUuid / now を省略しても動く', async () => {
    const { eutilsFetchMock, deps } = setupDeps();
    eutilsFetchMock
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '0', idlist: [] } }))
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '0', idlist: [] } }))
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '0', idlist: [] } }))
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '0', idlist: [] } }))
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '0', idlist: [] } }))
      .mockResolvedValueOnce(
        xmlResponse(`<?xml version="1.0"?><PubmedArticleSet></PubmedArticleSet>`)
      );
    const withoutHelpers: ValidationServiceDeps = { ...deps };
    delete (withoutHelpers as { newUuid?: unknown }).newUuid;
    delete (withoutHelpers as { now?: unknown }).now;
    await expect(runValidation(withoutHelpers)).resolves.toBeDefined();
  });
});

describe('analyzeMissedSeeds', () => {
  function llmFactory(text: string): {
    factory: LlmProviderFactory;
    calls: ChatMessage[][];
    purposes: string[];
  } {
    const calls: ChatMessage[][] = [];
    const purposes: string[] = [];
    const provider: LLMProvider = {
      providerId: 'gemini',
      model: 'test',
      chat: async (messages) => {
        calls.push([...messages]);
        return { text, tokensIn: null, tokensOut: null, raw: {} };
      },
    };
    return {
      calls,
      purposes,
      factory: {
        forPurpose: (purpose) => {
          purposes.push(purpose);
          return provider;
        },
      },
    };
  }

  function efetchXml(): string {
    return [
      '<?xml version="1.0"?><PubmedArticleSet>',
      '<PubmedArticle><MedlineCitation><PMID>444</PMID>',
      '<Article><ArticleTitle>Acute lung injury support</ArticleTitle>',
      '<Abstract><AbstractText>A trial of ECMO.</AbstractText></Abstract></Article>',
      '<MeshHeadingList><MeshHeading><DescriptorName>Acute Lung Injury</DescriptorName></MeshHeading></MeshHeadingList>',
      '</MedlineCitation></PubmedArticle></PubmedArticleSet>',
    ].join('');
  }

  function makeDeps(
    text: string,
    eutilsXml: string
  ): {
    deps: AnalyzeMissedSeedsDeps;
    calls: ChatMessage[][];
    purposes: string[];
    eutilsFetchMock: jest.Mock;
  } {
    const store = createStore(makeState());
    const { factory, calls, purposes } = llmFactory(text);
    const eutilsFetchMock = jest.fn().mockResolvedValue(xmlResponse(eutilsXml));
    const deps: AnalyzeMissedSeedsDeps = {
      eutils: {
        fetch: eutilsFetchMock as unknown as typeof fetch,
        sleep: async () => undefined,
        maxRetries: 0,
      },
      store,
      llmFactory: factory,
      missedPmids: ['444'],
    };
    return { deps, calls, purposes, eutilsFetchMock };
  }

  test('efetch で書誌を取り、interpret_result purpose で skill を呼んで結果を返す', async () => {
    const skillJson = JSON.stringify({
      analyses: [
        {
          pmid: '444',
          cause: 'acute lung injury が #1 に無いため。',
          suggested_terms: ['"acute lung injury"[tiab]'],
          related_block: '1',
        },
      ],
    });
    const { deps, calls, purposes } = makeDeps(skillJson, efetchXml());
    const result = await analyzeMissedSeeds(deps);
    expect(purposes).toEqual(['interpret_result']);
    expect(result.fetchedPmids).toEqual(['444']);
    expect(result.analyses).toEqual([
      {
        pmid: '444',
        cause: 'acute lung injury が #1 に無いため。',
        suggestedTerms: ['"acute lung injury"[tiab]'],
        relatedBlock: '1',
      },
    ]);
    // プロンプトに書誌（title / abstract / MeSH）と検索式の行が入る
    const userMsg = calls[0]!.find((m) => m.role === 'user')?.content ?? '';
    expect(userMsg).toContain('Acute lung injury support');
    expect(userMsg).toContain('A trial of ECMO.');
    expect(userMsg).toContain('Acute Lung Injury');
    expect(userMsg).toContain('#1: diabetes[tiab]');
  });

  test('missedPmids が空ならエラー', async () => {
    const { deps } = makeDeps('{}', efetchXml());
    await expect(
      analyzeMissedSeeds({ ...deps, missedPmids: [] })
    ).rejects.toThrow(/漏れ PMID/);
  });

  test('formula 未設定ならエラー', async () => {
    const { deps } = makeDeps('{}', efetchXml());
    deps.store.setState((s) => ({ ...s, currentFormulaMarkdown: null }));
    await expect(analyzeMissedSeeds(deps)).rejects.toThrow(/ドラフト/);
  });

  test('efetch が 0 件を返したら LLM を呼ばず空で返す', async () => {
    const { deps, purposes } = makeDeps(
      '{}',
      '<?xml version="1.0"?><PubmedArticleSet></PubmedArticleSet>'
    );
    const result = await analyzeMissedSeeds(deps);
    expect(result.analyses).toEqual([]);
    expect(result.fetchedPmids).toEqual([]);
    expect(purposes).toEqual([]);
  });
});
