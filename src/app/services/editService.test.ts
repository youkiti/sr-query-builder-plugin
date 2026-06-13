import { SHEET_HEADERS } from '@/domain/sheetsSchema';
import {
  createStore,
  type AppState,
  type BlocksDraft,
  type ProtocolDraft,
} from '../store';
import {
  applyBlockImprovement,
  getBlockImprovementContext,
  requestBlockImprovement,
  saveEditedFormula,
  type BlockImprovementDeps,
} from './editService';
import type { LlmProviderFactory } from './llmProviderService';
import type { LLMProvider } from '@/lib/llm';

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

/** SeedPapers タブが空（ヘッダのみ）で返る Google モック。seed 文脈を空にしたいとき用。 */
function emptySeedsGoogle(): { fetch: jest.Mock; getAccessToken: jest.Mock } {
  return {
    fetch: jest.fn().mockResolvedValue(jsonResponse({ values: [SHEET_HEADERS.SeedPapers] })),
    getAccessToken: jest.fn().mockResolvedValue('t'),
  };
}

/** 指定した SeedPapers の行（seed オブジェクト → 行配列）を返す Google モック。 */
function seedsGoogle(rows: Record<string, string | number | boolean>[]): {
  fetch: jest.Mock;
  getAccessToken: jest.Mock;
} {
  const header = [...SHEET_HEADERS.SeedPapers];
  const values = [header, ...rows.map((r) => header.map((key) => r[key] ?? ''))];
  return {
    fetch: jest.fn().mockResolvedValue(jsonResponse({ values })),
    getAccessToken: jest.fn().mockResolvedValue('t'),
  };
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
    protocolDraftPersisted: false,
    protocolDraft: makeProtocolDraft(),
    currentProtocolVersion: 3,
    currentFormulaVersionId: 'parent-v',
    currentFormulaMarkdown: '## PubMed/MEDLINE\n\n```\n#1 old\n```\n',
    draftRun: null,
    expandRun: null,
    validationResult: null,
    missedAnalysis: null,
    ...overrides,
  };
}

const VALID_MD = '## PubMed/MEDLINE\n\n```\n#1 asthma[tiab]\n#2 children[tiab]\n#3 #1 AND #2\n```\n';

function getAppendBody(fetchMock: jest.Mock): {
  values: (string | number | boolean | null)[][];
} {
  const appendCall = fetchMock.mock.calls.find((c) =>
    (c[0] as string).includes('FormulaVersions') && (c[0] as string).includes(':append')
  );
  expect(appendCall).toBeTruthy();
  return JSON.parse((appendCall![1] as RequestInit).body as string) as {
    values: (string | number | boolean | null)[][];
  };
}

describe('saveEditedFormula', () => {
  test('プロジェクト未選択なら例外', async () => {
    const store = createStore(makeState({ project: null }));
    const google = { fetch: jest.fn(), getAccessToken: jest.fn().mockResolvedValue('t') };
    await expect(
      saveEditedFormula({ formulaMd: VALID_MD, note: '' }, { google, store })
    ).rejects.toThrow('プロジェクト');
  });

  test('protocolDraft 未設定なら例外', async () => {
    const store = createStore(
      makeState({ protocolDraft: null, currentFormulaVersionId: null })
    );
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
    const [url] = fetchMock.mock.calls.find((c) =>
      (c[0] as string).includes('FormulaVersions') && (c[0] as string).includes(':append')
    )!;
    expect(url).toContain('FormulaVersions');
    const body = getAppendBody(fetchMock);
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
    const body = getAppendBody(fetchMock);
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
    const body = getAppendBody(fetchMock);
    const row = body.values[0]!;
    const pvIdx = SHEET_HEADERS.FormulaVersions.indexOf('protocol_version');
    expect(row[pvIdx]).toBe(0);
  });

  test('親 FormulaVersion があれば protocolDraft 未設定でも親の系譜を引き継ぐ', async () => {
    const store = createStore(
      makeState({
        protocolDraft: null,
        currentProtocolVersion: null,
        currentFormulaVersionId: 'parent-v',
      })
    );
    const fetchMock = jest.fn().mockImplementation(async (url: string) => {
      if ((url as string).includes('/values/FormulaVersions')) {
        const header = [...SHEET_HEADERS.FormulaVersions];
        const row = header.map((key) => {
          if (key === 'version_id') return 'parent-v';
          if (key === 'protocol_version') return '7';
          if (key === 'protocol_snapshot_ref') return 'https://drive/parent';
          if (key === 'formula_md') return VALID_MD;
          if (key === 'created_by') return 'ai_draft';
          if (key === 'created_at') return '2026';
          return '';
        });
        return jsonResponse({ values: [header, row] });
      }
      return jsonResponse({});
    });
    const google = { fetch: fetchMock, getAccessToken: jest.fn().mockResolvedValue('t') };
    await saveEditedFormula(
      { formulaMd: VALID_MD, note: '' },
      { google, store, newUuid: () => 'n', now: () => 'now' }
    );
    const appendCall = fetchMock.mock.calls.find((c) =>
      (c[0] as string).includes('FormulaVersions') && (c[0] as string).includes(':append')
    )!;
    const body = JSON.parse((appendCall[1] as RequestInit).body as string) as {
      values: (string | number | boolean | null)[][];
    };
    const row = body.values[0]!;
    expect(row[SHEET_HEADERS.FormulaVersions.indexOf('protocol_version')]).toBe(7);
    expect(row[SHEET_HEADERS.FormulaVersions.indexOf('protocol_snapshot_ref')]).toBe(
      'https://drive/parent'
    );
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
    const body = getAppendBody(fetchMock);
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
    const body = getAppendBody(fetchMock);
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

function fakeLlmFactory(
  responseJson: string
): { factory: LlmProviderFactory; captured: { purpose: string | null } } {
  const captured = { purpose: null as string | null };
  const provider: LLMProvider = {
    providerId: 'gemini',
    model: 'test',
    chat: async () => ({ text: responseJson, tokensIn: null, tokensOut: null, raw: {} }),
  };
  return {
    captured,
    factory: {
      forPurpose: (purpose) => {
        captured.purpose = purpose;
        return provider;
      },
    },
  };
}

describe('requestBlockImprovement', () => {
  test('blockId が見つかれば improve-block skill を `improve_block` purpose で呼び結果を返す', async () => {
    const store = createStore(
      makeState({
        currentFormulaMarkdown: VALID_MD,
      })
    );
    const { factory, captured } = fakeLlmFactory(
      JSON.stringify({
        proposed_expression: '"Asthma"[Mesh] OR asthma*[tiab]',
        rationale: 'MeSH 追加で感度向上',
      })
    );
    const deps: BlockImprovementDeps = { store, google: emptySeedsGoogle(), llmFactory: factory };
    const result = await requestBlockImprovement({ blockId: '1' }, deps);
    expect(captured.purpose).toBe('improve_block');
    expect(result).toEqual({
      blockId: '1',
      currentExpression: 'asthma[tiab]',
      proposedExpression: '"Asthma"[Mesh] OR asthma*[tiab]',
      rationale: 'MeSH 追加で感度向上',
    });
  });

  test('formula_md が未設定なら例外', async () => {
    const store = createStore(makeState({ currentFormulaMarkdown: null }));
    const { factory } = fakeLlmFactory('{}');
    await expect(
      requestBlockImprovement({ blockId: '1' }, { store, google: emptySeedsGoogle(), llmFactory: factory })
    ).rejects.toThrow(/検索式/);
  });

  test('formula_md が空白のみでも「検索式」エラー', async () => {
    const store = createStore(makeState({ currentFormulaMarkdown: '   \n  ' }));
    const { factory } = fakeLlmFactory('{}');
    await expect(
      requestBlockImprovement({ blockId: '1' }, { store, google: emptySeedsGoogle(), llmFactory: factory })
    ).rejects.toThrow(/検索式/);
  });

  test('blockId が見つからないと例外', async () => {
    const store = createStore(makeState({ currentFormulaMarkdown: VALID_MD }));
    const { factory } = fakeLlmFactory('{}');
    await expect(
      requestBlockImprovement({ blockId: '99' }, { store, google: emptySeedsGoogle(), llmFactory: factory })
    ).rejects.toThrow(/#99/);
  });

  test('blocksDraft が無ければ blockLabel / description は空文字で渡す', async () => {
    const store = createStore(
      makeState({
        currentFormulaMarkdown: VALID_MD,
        blocksDraft: null,
      })
    );
    const calls: string[] = [];
    const provider: LLMProvider = {
      providerId: 'gemini',
      model: 'test',
      chat: async (messages) => {
        const user = messages.find((m) => m.role === 'user')!.content;
        calls.push(user);
        return {
          text: JSON.stringify({ proposed_expression: 'x', rationale: 'y' }),
          tokensIn: null,
          tokensOut: null,
          raw: {},
        };
      },
    };
    const factory: LlmProviderFactory = { forPurpose: () => provider };
    await requestBlockImprovement({ blockId: '1' }, { store, google: emptySeedsGoogle(), llmFactory: factory });
    // label と description が空なので description は「(不明)」で埋められる
    expect(calls[0]).toContain('(不明)');
  });

  test('数値でない blockId（例: `RCTfilter`）は blocksDraft 参照せずに空 context で通す', async () => {
    const mdWithRct = [
      '## PubMed/MEDLINE',
      '',
      '```',
      '#1 asthma[tiab]',
      '#RCTfilter "randomized controlled trial"[pt]',
      '#2 #1 AND #RCTfilter',
      '```',
      '',
    ].join('\n');
    const store = createStore(makeState({ currentFormulaMarkdown: mdWithRct }));
    const { factory } = fakeLlmFactory(
      JSON.stringify({ proposed_expression: 'updated', rationale: 'r' })
    );
    const result = await requestBlockImprovement(
      { blockId: 'RCTfilter' },
      { store, google: emptySeedsGoogle(), llmFactory: factory }
    );
    expect(result.currentExpression).toBe('"randomized controlled trial"[pt]');
    expect(result.proposedExpression).toBe('updated');
  });

  test('blocksDraft の範囲外の blockId（例: 2 だが blocks 1 個だけ）は空 context', async () => {
    const mdMulti = [
      '## PubMed/MEDLINE',
      '',
      '```',
      '#1 asthma[tiab]',
      '#2 children[tiab]',
      '#3 #1 AND #2',
      '```',
      '',
    ].join('\n');
    const store = createStore(makeState({ currentFormulaMarkdown: mdMulti }));
    const calls: string[] = [];
    const provider: LLMProvider = {
      providerId: 'gemini',
      model: 'test',
      chat: async (messages) => {
        calls.push(messages.find((m) => m.role === 'user')!.content);
        return {
          text: JSON.stringify({ proposed_expression: 'new', rationale: 'r' }),
          tokensIn: null,
          tokensOut: null,
          raw: {},
        };
      },
    };
    await requestBlockImprovement(
      { blockId: '2' },
      { store, google: emptySeedsGoogle(), llmFactory: { forPurpose: () => provider } }
    );
    expect(calls[0]).toContain('(不明)');
  });

  test('protocolDraft が null なら RQ 欄は空文字で送る', async () => {
    const store = createStore(
      makeState({
        currentFormulaMarkdown: VALID_MD,
        protocolDraft: null,
      })
    );
    const calls: string[] = [];
    const provider: LLMProvider = {
      providerId: 'gemini',
      model: 'test',
      chat: async (messages) => {
        calls.push(messages.find((m) => m.role === 'user')!.content);
        return {
          text: JSON.stringify({ proposed_expression: 'x', rationale: 'r' }),
          tokensIn: null,
          tokensOut: null,
          raw: {},
        };
      },
    };
    await requestBlockImprovement(
      { blockId: '1' },
      { store, google: emptySeedsGoogle(), llmFactory: { forPurpose: () => provider } }
    );
    // RQ: の直後に空行がくる（`RQ: \n` パターン）
    expect(calls[0]).toMatch(/RQ:\s*\n/);
  });
});

describe('requestBlockImprovement - シード / 検証文脈', () => {
  function capturingFactory(): { factory: LlmProviderFactory; calls: string[] } {
    const calls: string[] = [];
    const provider: LLMProvider = {
      providerId: 'gemini',
      model: 'test',
      chat: async (messages) => {
        calls.push(messages.find((m) => m.role === 'user')!.content);
        return {
          text: JSON.stringify({ proposed_expression: 'x', rationale: 'r' }),
          tokensIn: null,
          tokensOut: null,
          raw: {},
        };
      },
    };
    return { calls, factory: { forPurpose: () => provider } };
  }

  test('SeedPapers の include / 初期シードがプロンプトに載り、exclude は除外される', async () => {
    const store = createStore(makeState({ currentFormulaMarkdown: VALID_MD }));
    const google = seedsGoogle([
      { pmid: '111', title: 'Seed A', source: 'initial', is_valid: 'true', user_decision: 'include' },
      { pmid: '222', title: 'Seed B', source: 'interactive', is_valid: 'true', user_decision: 'include' },
      { pmid: '999', title: 'Excluded', source: 'interactive', is_valid: 'true', user_decision: 'exclude' },
    ]);
    const { factory, calls } = capturingFactory();
    await requestBlockImprovement({ blockId: '1' }, { store, google, llmFactory: factory });
    expect(calls[0]).toContain('PMID 111 [include]: Seed A');
    expect(calls[0]).toContain('PMID 222 [include]: Seed B');
    expect(calls[0]).not.toContain('999');
  });

  test('現バージョンと一致する検証結果（捕捉率・取りこぼし）がプロンプトに載る', async () => {
    const store = createStore(
      makeState({
        currentFormulaMarkdown: VALID_MD,
        currentFormulaVersionId: 'v-now',
        validationResult: {
          formulaVersionId: 'v-now',
          summary: {
            finalQuery: { captureRate: 0.5, capturedPmids: ['111'], missedPmids: ['222'] },
          },
        } as unknown as AppState['validationResult'],
      })
    );
    const { factory, calls } = capturingFactory();
    await requestBlockImprovement(
      { blockId: '1' },
      { store, google: emptySeedsGoogle(), llmFactory: factory }
    );
    expect(calls[0]).toContain('捕捉率: 50%');
    expect(calls[0]).toContain('取りこぼし PMID: 222');
  });

  test('検証結果が別バージョンのものなら stale 扱いで載せない', async () => {
    const store = createStore(
      makeState({
        currentFormulaMarkdown: VALID_MD,
        currentFormulaVersionId: 'v-now',
        validationResult: {
          formulaVersionId: 'v-old',
          summary: {
            finalQuery: { captureRate: 0.9, capturedPmids: ['111'], missedPmids: [] },
          },
        } as unknown as AppState['validationResult'],
      })
    );
    const { factory, calls } = capturingFactory();
    await requestBlockImprovement(
      { blockId: '1' },
      { store, google: emptySeedsGoogle(), llmFactory: factory }
    );
    expect(calls[0]).toContain('(未検証)');
    expect(calls[0]).not.toContain('捕捉率: 90%');
  });

  test('ユーザー指示がプロンプトに載る', async () => {
    const store = createStore(makeState({ currentFormulaMarkdown: VALID_MD }));
    const { factory, calls } = capturingFactory();
    await requestBlockImprovement(
      { blockId: '1', instruction: 'tiab を増やして' },
      { store, google: emptySeedsGoogle(), llmFactory: factory }
    );
    expect(calls[0]).toContain('tiab を増やして');
  });

  test('Sheets 読み取りが失敗してもシードは空で改善は続行する', async () => {
    const store = createStore(makeState({ currentFormulaMarkdown: VALID_MD }));
    const google = {
      fetch: jest.fn().mockRejectedValue(new Error('network')),
      getAccessToken: jest.fn().mockResolvedValue('t'),
    };
    const { factory, calls } = capturingFactory();
    const result = await requestBlockImprovement(
      { blockId: '1' },
      { store, google, llmFactory: factory }
    );
    expect(result.proposedExpression).toBe('x');
    expect(calls[0]).toContain('(なし)');
  });
});

describe('getBlockImprovementContext', () => {
  test('式が未生成なら null', async () => {
    const store = createStore(makeState({ currentFormulaMarkdown: null }));
    const ctx = await getBlockImprovementContext('1', { store, google: emptySeedsGoogle() });
    expect(ctx).toBeNull();
  });

  test('存在しない blockId は null', async () => {
    const store = createStore(makeState({ currentFormulaMarkdown: VALID_MD }));
    const ctx = await getBlockImprovementContext('99', { store, google: emptySeedsGoogle() });
    expect(ctx).toBeNull();
  });

  test('RQ / ブロック定義 / シード / 検証捕捉情報を返す', async () => {
    const store = createStore(
      makeState({
        currentFormulaMarkdown: VALID_MD,
        currentFormulaVersionId: 'v-now',
        validationResult: {
          formulaVersionId: 'v-now',
          summary: {
            finalQuery: { captureRate: 0.5, capturedPmids: ['111'], missedPmids: ['222'] },
          },
        } as unknown as AppState['validationResult'],
      })
    );
    const google = seedsGoogle([
      { pmid: '111', title: 'Seed A', source: 'initial', is_valid: 'true', user_decision: 'include' },
    ]);
    const ctx = await getBlockImprovementContext('1', { store, google });
    expect(ctx).not.toBeNull();
    expect(ctx!.researchQuestion).toBe('RQ');
    expect(ctx!.blockLabel).toBe('Population');
    expect(ctx!.currentExpression).toBe('asthma[tiab]');
    expect(ctx!.seedPapers).toEqual([
      { pmid: '111', title: 'Seed A', decision: 'include', source: 'initial' },
    ]);
    expect(ctx!.validation).toEqual({
      captureRate: 0.5,
      capturedPmids: ['111'],
      missedPmids: ['222'],
    });
  });
});

describe('applyBlockImprovement', () => {
  test('指定行の expression を差し替える（他行はそのまま）', () => {
    const result = applyBlockImprovement(VALID_MD, '1', '"Asthma"[Mesh]');
    expect(result).toContain('#1 "Asthma"[Mesh]');
    expect(result).toContain('#2 children[tiab]');
    expect(result).toContain('#3 #1 AND #2');
  });

  test('新 expression の前後空白は trim される', () => {
    const result = applyBlockImprovement(VALID_MD, '1', '   new-expr   ');
    expect(result).toContain('#1 new-expr');
  });

  test('英数混在 blockId（`RCTfilter` など）も差し替えできる', () => {
    const md = [
      '## PubMed/MEDLINE',
      '',
      '```',
      '#1 x',
      '#RCTfilter "randomized controlled trial"[pt]',
      '```',
      '',
    ].join('\n');
    const result = applyBlockImprovement(md, 'RCTfilter', 'updated');
    expect(result).toContain('#RCTfilter updated');
  });

  test('見つからない blockId は例外', () => {
    expect(() => applyBlockImprovement(VALID_MD, 'ZZ', 'x')).toThrow(/#ZZ/);
  });
});
