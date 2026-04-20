import { SHEET_HEADERS } from '@/domain/sheetsSchema';
import {
  createStore,
  type AppState,
  type BlocksDraft,
  type ProtocolDraft,
} from '../store';
import { saveEditedFormula } from './editService';

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function makeProtocolDraft(overrides: Partial<ProtocolDraft> = {}): ProtocolDraft {
  return {
    frameworkType: 'pico',
    researchQuestion: 'RQ',
    inclusionCriteria: 'inc',
    exclusionCriteria: 'exc',
    studyDesign: 'RCT',
    sourceType: 'manual',
    sourceFilename: null,
    rawTextRef: null,
    rawTextPreview: 'プレビュー',
    rawTextInline: '本文',
    ...overrides,
  };
}

function makeBlocksDraft(): BlocksDraft {
  return {
    blocks: [
      { blockLabel: 'Population', description: 'pop', aiGenerated: true, note: '' },
    ],
    combinationExpression: '#1',
  };
}

function makeState(overrides: Partial<AppState> = {}): AppState {
  return {
    route: 'edit',
    project: {
      projectId: 'p',
      spreadsheetId: 'SHEET-1',
      driveFolderId: 'D',
      title: 'Test',
    },
    cumulativeCostUsd: null,
    blocksDraft: makeBlocksDraft(),
    protocolDraft: makeProtocolDraft(),
    currentProtocolVersion: 3,
    currentFormulaVersionId: 'parent-v',
    currentFormulaMarkdown: '## PubMed/MEDLINE\n\n```\n#1 old\n```\n',
    ...overrides,
  };
}

const VALID_MD = '## PubMed/MEDLINE\n\n```\n#1 asthma[tiab]\n#2 children[tiab]\n#3 #1 AND #2\n```\n';

describe('saveEditedFormula', () => {
  test('プロジェクト未選択なら例外', async () => {
    const store = createStore(makeState({ project: null }));
    const google = { fetch: jest.fn(), getAccessToken: jest.fn().mockResolvedValue('t') };
    await expect(
      saveEditedFormula({ formulaMd: VALID_MD, note: '' }, { google, store })
    ).rejects.toThrow('プロジェクト');
  });

  test('protocolDraft 未設定なら例外', async () => {
    const store = createStore(makeState({ protocolDraft: null }));
    const google = { fetch: jest.fn(), getAccessToken: jest.fn().mockResolvedValue('t') };
    await expect(
      saveEditedFormula({ formulaMd: VALID_MD, note: '' }, { google, store })
    ).rejects.toThrow('protocolDraft');
  });

  test('空の formula は例外', async () => {
    const store = createStore(makeState());
    const google = { fetch: jest.fn(), getAccessToken: jest.fn().mockResolvedValue('t') };
    await expect(
      saveEditedFormula({ formulaMd: '   \n', note: '' }, { google, store })
    ).rejects.toThrow('検索式が空');
  });

  test('フォーマット不正はパースエラー', async () => {
    const store = createStore(makeState());
    const google = { fetch: jest.fn(), getAccessToken: jest.fn().mockResolvedValue('t') };
    await expect(
      saveEditedFormula({ formulaMd: 'no section', note: '' }, { google, store })
    ).rejects.toThrow();
  });

  test('user_edit として FormulaVersions に追記し、store を更新する', async () => {
    const store = createStore(makeState());
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse({}));
    const google = { fetch: fetchMock, getAccessToken: jest.fn().mockResolvedValue('t') };
    const result = await saveEditedFormula(
      { formulaMd: VALID_MD, note: '手で調整' },
      { google, store, newUuid: () => 'new-id', now: () => '2026-04-19T00:00:00.000Z' }
    );
    expect(result).toEqual({ versionId: 'new-id', parentVersionId: 'parent-v' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('FormulaVersions');
    const body = JSON.parse((init as RequestInit).body as string) as {
      values: (string | number | boolean | null)[][];
    };
    const row = body.values[0]!;
    const map: Record<string, string | number | boolean | null> = {};
    SHEET_HEADERS.FormulaVersions.forEach((key, i) => {
      map[key] = row[i] as string | number | boolean | null;
    });
    expect(map['version_id']).toBe('new-id');
    expect(map['parent_version_id']).toBe('parent-v');
    expect(map['protocol_version']).toBe(3);
    expect(map['created_by']).toBe('user_edit');
    expect(map['note']).toBe('手で調整');
    expect(map['created_at']).toBe('2026-04-19T00:00:00.000Z');
    expect(store.getState().currentFormulaVersionId).toBe('new-id');
    expect(store.getState().currentFormulaMarkdown).toBe(VALID_MD);
  });

  test('note 空白は null として保存される', async () => {
    const store = createStore(makeState());
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse({}));
    const google = { fetch: fetchMock, getAccessToken: jest.fn().mockResolvedValue('t') };
    await saveEditedFormula(
      { formulaMd: VALID_MD, note: '   ' },
      { google, store, newUuid: () => 'n', now: () => 'now' }
    );
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string) as {
      values: (string | number | boolean | null)[][];
    };
    const row = body.values[0]!;
    const noteIdx = SHEET_HEADERS.FormulaVersions.indexOf('note');
    expect(row[noteIdx]).toBe('');
  });

  test('currentProtocolVersion が null なら 0 で埋める', async () => {
    const store = createStore(makeState({ currentProtocolVersion: null }));
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse({}));
    const google = { fetch: fetchMock, getAccessToken: jest.fn().mockResolvedValue('t') };
    await saveEditedFormula(
      { formulaMd: VALID_MD, note: '' },
      { google, store, newUuid: () => 'n', now: () => 'now' }
    );
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string) as {
      values: (string | number | boolean | null)[][];
    };
    const row = body.values[0]!;
    const pvIdx = SHEET_HEADERS.FormulaVersions.indexOf('protocol_version');
    expect(row[pvIdx]).toBe(0);
  });

  test('rawTextRef があれば protocol_snapshot_ref に使う', async () => {
    const store = createStore(
      makeState({
        protocolDraft: makeProtocolDraft({ rawTextRef: 'https://drive/snap', rawTextInline: null }),
      })
    );
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse({}));
    const google = { fetch: fetchMock, getAccessToken: jest.fn().mockResolvedValue('t') };
    await saveEditedFormula(
      { formulaMd: VALID_MD, note: '' },
      { google, store, newUuid: () => 'n', now: () => 'now' }
    );
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string) as {
      values: (string | number | boolean | null)[][];
    };
    const row = body.values[0]!;
    const ref = row[SHEET_HEADERS.FormulaVersions.indexOf('protocol_snapshot_ref')];
    expect(ref).toBe('https://drive/snap');
  });

  test('rawTextRef も rawTextInline も null なら空文字', async () => {
    const store = createStore(
      makeState({
        protocolDraft: makeProtocolDraft({ rawTextRef: null, rawTextInline: null }),
      })
    );
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse({}));
    const google = { fetch: fetchMock, getAccessToken: jest.fn().mockResolvedValue('t') };
    await saveEditedFormula(
      { formulaMd: VALID_MD, note: '' },
      { google, store, newUuid: () => 'n', now: () => 'now' }
    );
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string) as {
      values: (string | number | boolean | null)[][];
    };
    const row = body.values[0]!;
    const ref = row[SHEET_HEADERS.FormulaVersions.indexOf('protocol_snapshot_ref')];
    expect(ref).toBe('');
  });

  test('newUuid / now が省略された場合はデフォルト実装が使われる', async () => {
    const store = createStore(makeState());
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse({}));
    const google = { fetch: fetchMock, getAccessToken: jest.fn().mockResolvedValue('t') };
    const result = await saveEditedFormula(
      { formulaMd: VALID_MD, note: '' },
      { google, store }
    );
    expect(typeof result.versionId).toBe('string');
    expect(result.versionId.length).toBeGreaterThan(0);
  });
});
