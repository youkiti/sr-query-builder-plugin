import { SHEET_HEADERS } from '@/domain/sheetsSchema';
import { createStore, type AppState } from '../store';
import { runValidation, type ValidationServiceDeps } from './validationService';

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
    route: 'validate',
    project: { projectId: 'p', spreadsheetId: 'SHEET-1', driveFolderId: 'D', title: 'T' },
    cumulativeCostUsd: null,
    blocksDraft: null,
    protocolDraft: null,
    currentProtocolVersion: 3,
    currentFormulaVersionId: 'v-1',
    currentFormulaMarkdown: formulaMd,
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
      );
    const summary = await runValidation(deps);
    expect(summary.lineHits).toHaveLength(3);
    expect(summary.lineHits[0]?.hitCount).toBe(100);
    expect(summary.finalQuery.totalHits).toBe(500);
    expect(summary.finalQuery.captureRate).toBe(1);
    expect(summary.mesh).toHaveLength(1);
    expect(summary.meshFrequency[0]?.descriptor).toBe('Diabetes Mellitus');
    expect(summary.eligibleSeedCount).toBe(1);
    expect(summary.totalSeedCount).toBe(1);
    expect(summary.loggedValidationIds).toHaveLength(5);
    const appendCalls = sheetsFetchMock.mock.calls.filter((c) =>
      (c[0] as string).includes('ValidationLog') && (c[0] as string).includes(':append')
    );
    expect(appendCalls).toHaveLength(5);
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
