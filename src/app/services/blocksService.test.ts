import { SHEET_HEADERS } from '@/domain/sheetsSchema';
import {
  createStore,
  type AppState,
  type BlocksDraft,
  type ProtocolDraft,
} from '../store';
import { approveBlocks } from './blocksService';

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
      { blockLabel: 'Intervention', description: 'int', aiGenerated: false, note: 'メモ' },
    ],
    combinationExpression: '#1 AND #2',
  };
}

function makeStateWithDrafts(): AppState {
  return {
    route: 'blocks',
    project: {
      projectId: 'p',
      spreadsheetId: 'SHEET-1',
      driveFolderId: 'D',
      title: 'Test Project',
    },
    cumulativeCostUsd: null,
    blocksDraft: makeBlocksDraft(),
    protocolDraftPersisted: false,
    protocolDraft: makeProtocolDraft(),
    currentProtocolVersion: null,
    currentFormulaVersionId: null,
    currentFormulaMarkdown: null,
    draftRun: null,
    expandRun: null,
    validationResult: null,
    missedAnalysis: null,
  };
}

function setupDeps(): {
  store: ReturnType<typeof createStore>;
  fetchMock: jest.Mock;
  google: { fetch: jest.Mock; getAccessToken: jest.Mock };
  profile: { getProfileUserInfo: jest.Mock };
} {
  const store = createStore(makeStateWithDrafts());
  const fetchMock = jest.fn();
  const google = {
    fetch: fetchMock,
    getAccessToken: jest.fn().mockResolvedValue('t'),
  };
  const profile = {
    getProfileUserInfo: jest.fn().mockResolvedValue({ email: 'me@x', id: 'u' }),
  };
  return { store, fetchMock, google, profile };
}

describe('approveBlocks', () => {
  test('Protocol タブが空の場合 version=1 で書き込む', async () => {
    const { store, fetchMock, google, profile } = setupDeps();
    fetchMock.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/values/Protocol')) {
        return jsonResponse({ values: [[...SHEET_HEADERS.Protocol]] });
      }
      return jsonResponse({});
    });
    const result = await approveBlocks({
      google: google as Parameters<typeof approveBlocks>[0]['google'],
      profile,
      store,
      now: () => '2026-04-19T00:00:00.000Z',
    });
    expect(result.version).toBe(1);
    expect(result.protocol.researchQuestion).toBe('RQ');
    expect(result.protocol.blockCount).toBe(2);
    expect(result.protocol.createdBy).toBe('me@x');
    expect(result.blocks).toHaveLength(2);
    expect(result.blocks[0]?.blockIndex).toBe(1);
    expect(result.blocks[1]?.blockLabel).toBe('Intervention');
    expect(result.blocks[1]?.note).toBe('メモ');
  });

  test('既存 version の最大 + 1 で書き込む', async () => {
    const { store, fetchMock, google, profile } = setupDeps();
    const versionIdx = SHEET_HEADERS.Protocol.indexOf('version');
    const row = (n: string): string[] => {
      const r = SHEET_HEADERS.Protocol.map(() => '');
      r[versionIdx] = n;
      return r;
    };
    fetchMock.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/values/Protocol')) {
        return jsonResponse({
          values: [[...SHEET_HEADERS.Protocol], row('1'), row('2')],
        });
      }
      return jsonResponse({});
    });
    const result = await approveBlocks({
      google: google as Parameters<typeof approveBlocks>[0]['google'],
      profile,
      store,
    });
    expect(result.version).toBe(3);
  });

  // §4.2: 新しい Protocol.version が確定したら、旧プロトコル由来の検索式系状態を
  // リセットしてブロック以降をやり直させる（旧検索式は FormulaVersions に残る）
  test('承認すると persisted=true になり、検索式系の状態がリセットされる', async () => {
    const { store, fetchMock, google, profile } = setupDeps();
    store.setState((s) => ({
      ...s,
      currentFormulaVersionId: 'F-9',
      currentFormulaMarkdown: '# 旧検索式',
      validationResult: {
        formulaVersionId: 'F-9',
        summary: {} as NonNullable<AppState['validationResult']>['summary'],
      },
      missedAnalysis: {
        formulaVersionId: 'F-9',
        result: {} as NonNullable<AppState['missedAnalysis']>['result'],
      },
    }));
    fetchMock.mockImplementation(async () => jsonResponse({}));
    await approveBlocks({
      google: google as Parameters<typeof approveBlocks>[0]['google'],
      profile,
      store,
    });
    const state = store.getState();
    expect(state.protocolDraftPersisted).toBe(true);
    expect(state.currentProtocolVersion).toBe(1);
    expect(state.currentFormulaVersionId).toBeNull();
    expect(state.currentFormulaMarkdown).toBeNull();
    expect(state.validationResult).toBeNull();
    expect(state.missedAnalysis).toBeNull();
  });

  test('email 取得失敗時は createdBy が空文字', async () => {
    const { store, fetchMock, google, profile } = setupDeps();
    profile.getProfileUserInfo = jest.fn().mockResolvedValue({ email: '', id: '' });
    fetchMock.mockImplementation(async () => jsonResponse({}));
    const result = await approveBlocks({
      google: google as Parameters<typeof approveBlocks>[0]['google'],
      profile,
      store,
    });
    expect(result.protocol.createdBy).toBe('');
  });

  test('空文字フィールドは null に正規化される', async () => {
    const { store, fetchMock, google, profile } = setupDeps();
    store.setState((s) => ({
      ...s,
      protocolDraft: makeProtocolDraft({
        inclusionCriteria: '',
        exclusionCriteria: '',
        studyDesign: '',
        rawTextPreview: '',
      }),
    }));
    fetchMock.mockImplementation(async () => jsonResponse({}));
    const result = await approveBlocks({
      google: google as Parameters<typeof approveBlocks>[0]['google'],
      profile,
      store,
    });
    expect(result.protocol.inclusionCriteria).toBeNull();
    expect(result.protocol.exclusionCriteria).toBeNull();
    expect(result.protocol.studyDesign).toBeNull();
    expect(result.protocol.rawTextPreview).toBeNull();
  });

  test('blockIndex は 1-origin で振り直される', async () => {
    const { store, fetchMock, google, profile } = setupDeps();
    fetchMock.mockImplementation(async () => jsonResponse({}));
    const result = await approveBlocks({
      google: google as Parameters<typeof approveBlocks>[0]['google'],
      profile,
      store,
    });
    expect(result.blocks.map((b) => b.blockIndex)).toEqual([1, 2]);
  });

  test('プロジェクト未選択ならエラー', async () => {
    const store = createStore({ ...makeStateWithDrafts(), project: null });
    const fetchMock = jest.fn();
    await expect(
      approveBlocks({
        google: { fetch: fetchMock, getAccessToken: jest.fn() } as Parameters<
          typeof approveBlocks
        >[0]['google'],
        profile: { getProfileUserInfo: jest.fn() },
        store,
      })
    ).rejects.toThrow(/プロジェクト/);
  });

  test('protocolDraft 未設定ならエラー', async () => {
    const { store, google, profile } = setupDeps();
    store.setState((s) => ({ ...s, protocolDraft: null }));
    await expect(
      approveBlocks({
        google: google as Parameters<typeof approveBlocks>[0]['google'],
        profile,
        store,
      })
    ).rejects.toThrow(/protocolDraft/);
  });

  test('blocksDraft 未設定ならエラー', async () => {
    const { store, google, profile } = setupDeps();
    store.setState((s) => ({ ...s, blocksDraft: null }));
    await expect(
      approveBlocks({
        google: google as Parameters<typeof approveBlocks>[0]['google'],
        profile,
        store,
      })
    ).rejects.toThrow(/blocksDraft/);
  });

  test('blocks 配列が空ならエラー', async () => {
    const { store, google, profile } = setupDeps();
    store.setState((s) => ({
      ...s,
      blocksDraft: { blocks: [], combinationExpression: '' },
    }));
    await expect(
      approveBlocks({
        google: google as Parameters<typeof approveBlocks>[0]['google'],
        profile,
        store,
      })
    ).rejects.toThrow(/blocksDraft/);
  });
});
