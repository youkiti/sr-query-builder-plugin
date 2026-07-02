import { SHEET_HEADERS } from '@/domain/sheetsSchema';
import { createStore, type AppState } from '../store';
import { exportToAllDatabases, suggestFileName, toDownloadUrl } from './exportService';

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

const formulaMd = [
  '## PubMed/MEDLINE',
  '',
  '```',
  '#1 "Diabetes"[Mesh]',
  '#2 metformin[tiab]',
  '#3 #1 AND #2',
  '```',
  '',
].join('\n');

function stateWithFormula(): AppState {
  return {
    route: 'export',
    project: { projectId: 'p', spreadsheetId: 'SHEET-1', driveFolderId: 'D', title: 'T' },
    cumulativeCostUsd: null,
    blocksDraft: null,
    protocolDraftPersisted: false,
    protocolDraft: null,
    currentProtocolVersion: 3,
    currentFormulaVersionId: 'v-42',
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

function setupDeps(): {
  store: ReturnType<typeof createStore>;
  fetchMock: jest.Mock;
  deps: Parameters<typeof exportToAllDatabases>[0];
} {
  const store = createStore(stateWithFormula());
  const fetchMock = jest.fn().mockResolvedValue(jsonResponse({}));
  const deps: Parameters<typeof exportToAllDatabases>[0] = {
    google: {
      fetch: fetchMock as unknown as typeof fetch,
      getAccessToken: jest.fn().mockResolvedValue('t'),
    },
    store,
    newUuid: (() => {
      let i = 0;
      return () => {
        i += 1;
        return `c-${i}`;
      };
    })(),
    now: () => '2026-04-19T00:00:00.000Z',
  };
  return { store, fetchMock, deps };
}

describe('exportToAllDatabases', () => {
  test('4 DB 分の変換 + Conversions タブへの追記を行う', async () => {
    const { fetchMock, deps } = setupDeps();
    const result = await exportToAllDatabases(deps);
    expect(result.conversions).toHaveLength(4);
    expect(result.entries).toHaveLength(4);
    expect(result.entries.map((e) => e.targetDb)).toEqual([
      'central',
      'dialog',
      'clinicaltrials',
      'ictrp',
    ]);
    const appendCalls = fetchMock.mock.calls.filter((c) =>
      (c[0] as string).includes('Conversions') && (c[0] as string).includes(':append')
    );
    expect(appendCalls).toHaveLength(4);
  });

  test('warnings が空配列なら null で保存される', async () => {
    const { fetchMock, deps } = setupDeps();
    // warnings が空になる minimal な式
    const { store } = setupDeps();
    store.setState((s) => ({
      ...s,
      currentFormulaMarkdown: '## PubMed\n\n```\n#1 diabetes\n```\n',
    }));
    // note: setupDeps は store を再生成したので、実際に渡すのは deps の方
    await exportToAllDatabases(deps);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string) as {
      values: (string | number | boolean | null)[][];
    };
    const idx = SHEET_HEADERS.Conversions.indexOf('warnings');
    // [ad] を含まない式なので CENTRAL 変換結果は warnings=[]（→ null → ''）
    expect(body.values[0]![idx]).toBe('');
  });

  test('warnings がある場合は改行区切りで保存される', async () => {
    const { fetchMock, deps, store } = setupDeps();
    // CT.gov 向けの警告が必ず入る（Condition/Intervention 振り分け未対応）
    await exportToAllDatabases(deps);
    const ctCall = fetchMock.mock.calls.find((c) => {
      const body = JSON.parse((c[1] as RequestInit).body as string) as {
        values: (string | number | boolean | null)[][];
      };
      const dbIdx = SHEET_HEADERS.Conversions.indexOf('target_db');
      return body.values[0]![dbIdx] === 'clinicaltrials';
    });
    expect(ctCall).toBeDefined();
    const body = JSON.parse((ctCall![1] as RequestInit).body as string) as {
      values: (string | number | boolean | null)[][];
    };
    const warningsIdx = SHEET_HEADERS.Conversions.indexOf('warnings');
    expect(body.values[0]![warningsIdx]).toContain('Condition');
    expect(store.getState()).toBeDefined(); // keep referenced
  });

  test('プロジェクト未選択ならエラー', async () => {
    const { store, deps } = setupDeps();
    store.setState((s) => ({ ...s, project: null }));
    await expect(exportToAllDatabases(deps)).rejects.toThrow(/プロジェクト/);
  });

  test('currentFormulaVersionId が無ければエラー', async () => {
    const { store, deps } = setupDeps();
    store.setState((s) => ({ ...s, currentFormulaVersionId: null }));
    await expect(exportToAllDatabases(deps)).rejects.toThrow(/ドラフト/);
  });

  test('currentFormulaMarkdown が無ければエラー', async () => {
    const { store, deps } = setupDeps();
    store.setState((s) => ({ ...s, currentFormulaMarkdown: null }));
    await expect(exportToAllDatabases(deps)).rejects.toThrow(/ドラフト/);
  });

  test('newUuid / now を省略しても動く', async () => {
    const { deps } = setupDeps();
    delete (deps as { newUuid?: unknown }).newUuid;
    delete (deps as { now?: unknown }).now;
    const result = await exportToAllDatabases(deps);
    expect(result.entries).toHaveLength(4);
  });
});

describe('toDownloadUrl', () => {
  test('data:text/markdown URL を返す', () => {
    const url = toDownloadUrl({
      targetDb: 'central',
      convertedFormula: '#1 foo',
      warnings: [],
    });
    expect(url.startsWith('data:text/markdown;charset=utf-8,')).toBe(true);
    expect(decodeURIComponent(url.split(',')[1]!)).toBe('#1 foo');
  });

  test('日本語や記号もエンコードされる', () => {
    const url = toDownloadUrl({
      targetDb: 'ictrp',
      convertedFormula: '#1 糖尿病 AND foo',
      warnings: [],
    });
    expect(decodeURIComponent(url.split(',')[1]!)).toBe('#1 糖尿病 AND foo');
  });
});

describe('suggestFileName', () => {
  test.each([
    ['central', 'search-formula.central.md'],
    ['dialog', 'search-formula.dialog.md'],
    ['clinicaltrials', 'search-formula.clinicaltrials.md'],
    ['ictrp', 'search-formula.ictrp.md'],
  ] as const)('%s → %s', (db, expected) => {
    expect(suggestFileName(db)).toBe(expected);
  });
});
