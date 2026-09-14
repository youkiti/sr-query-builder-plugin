import { SHEET_HEADERS } from '@/domain/sheetsSchema';
import type { ChatMessage, ChatResponse, LLMProvider } from '@/lib/llm';
import { createStore, type AppState } from '../store';
import { generateDraft, generateDraftFormula, type DraftProgress } from './draftService';

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function makeState(): AppState {
  return {
    route: 'draft',
    project: { projectId: 'p', spreadsheetId: 'SHEET-1', driveFolderId: 'D', title: 'T' },
    cumulativeCostUsd: null,
    blocksDraft: {
      blocks: [
        { blockLabel: 'Population', description: '対象', aiGenerated: true, note: '' },
        { blockLabel: 'Intervention', description: '介入', aiGenerated: true, note: '' },
      ],
      combinationExpression: '#1 AND #2',
    },
    protocolDraftPersisted: false,
    protocolDraft: {
      frameworkType: 'pico',
      researchQuestion: 'RQ',
      inclusionCriteria: 'inc',
      exclusionCriteria: 'exc',
      studyDesign: 'RCT',
      sourceType: 'manual',
      sourceFilename: null,
      rawTextRef: null,
      rawTextPreview: 'p',
      rawTextInline: '本文',
    },
    currentProtocolVersion: 3,
    currentFormulaVersionId: null,
    currentFormulaMarkdown: null,
    currentFormulaModel: null,
    currentFormulaCreatedBy: null,
    draftRun: null,
    expandRun: null,
    queryOptimizationRun: null,
    queryOptimizationSetup: null,
    validationResult: null,
    missedAnalysis: null,
    excessFilterProposal: null,
    formulaEditDraft: null,
    blockImprovement: null,
    formulaSave: null,
    formulaEditNote: null,
    blockImprovementInstruction: null,
    blockImprovementManualEditDraft: null,
    blocksDraftSavedAt: null,
    hydrateError: null,
    expandInsideStrategy: 'specific',
  };
}

function skillProviderFor(purpose: string): LLMProvider {
  return {
    providerId: 'gemini',
    model: 'test',
    chat: async (_messages: readonly ChatMessage[]): Promise<ChatResponse> => {
      const text =
        purpose === 'draft_block'
          ? JSON.stringify({
              concept_summary: 'concept',
              mesh_requirements: ['req'],
              freeword_requirements: ['fw req'],
              rationale: 'memo',
            })
          : purpose === 'suggest_mesh'
            ? JSON.stringify({
                suggestions: [
                  {
                    descriptor: 'Desc',
                    tag_syntax: '"Desc"[Mesh]',
                    rationale: 'ok',
                  },
                ],
              })
            : JSON.stringify({
                freewords: [{ query: 'term[tiab]', rationale: 'ok' }],
              });
      return { text, tokensIn: null, tokensOut: null, raw: {} };
    },
  };
}

function setupDeps(extra: { onProgress?: (p: DraftProgress) => void } = {}): {
  store: ReturnType<typeof createStore>;
  fetchMock: jest.Mock;
  purposes: string[];
  deps: Parameters<typeof generateDraft>[0];
} {
  const store = createStore(makeState());
  const fetchMock = jest.fn().mockResolvedValue(jsonResponse({}));
  const purposes: string[] = [];
  const deps: Parameters<typeof generateDraft>[0] = {
    google: {
      fetch: fetchMock as unknown as typeof fetch,
      getAccessToken: jest.fn().mockResolvedValue('t'),
    },
    store,
    eutils: {
      fetch: fetchMock as unknown as typeof fetch,
      tool: 'test',
      email: 'test@example.com',
    },
    llmFactory: {
      model: 'gemini-test',
      forPurpose: (purpose) => {
        purposes.push(purpose);
        return skillProviderFor(purpose);
      },
    },
    newUuid: () => 'new-version-id',
    now: () => '2026-04-19T00:00:00.000Z',
    ...(extra.onProgress ? { onProgress: extra.onProgress } : {}),
  };
  return { store, fetchMock, purposes, deps };
}

describe('generateDraft', () => {
  test('各ブロックに対して 3 skill（block/mesh/freeword）を順に呼び、FormulaVersions に追記', async () => {
    const progress: DraftProgress[] = [];
    const { store, fetchMock, purposes, deps } = setupDeps({
      onProgress: (p) => progress.push(p),
    });
    const result = await generateDraft(deps);

    expect(result.versionId).toBe('new-version-id');
    expect(result.markdown).toContain('## PubMed/MEDLINE');
    expect(result.blockSkeletons).toHaveLength(2);
    expect(result.meshSuggestions).toHaveLength(2);
    expect(result.freewordSuggestions).toHaveLength(2);
    // filter-designer は決定論的（LLM 不要）
    expect(result.filter.filters[0]?.blockId).toBe('RCTfilter');

    // 2 ブロック × 3 skill = 6 回の LLM 呼び出し
    expect(purposes).toEqual([
      'draft_block',
      'suggest_mesh',
      'expand_freeword',
      'draft_block',
      'suggest_mesh',
      'expand_freeword',
    ]);

    // FormulaVersions タブへの append が発火した
    const appendCall = fetchMock.mock.calls.find((c) =>
      (c[0] as string).includes('FormulaVersions') && (c[0] as string).includes(':append')
    );
    expect(appendCall).toBeTruthy();
    const body = JSON.parse((appendCall![1] as RequestInit).body as string) as {
      values: (string | number | boolean | null)[][];
    };
    const row = body.values[0]!;
    const map: Record<string, unknown> = {};
    SHEET_HEADERS.FormulaVersions.forEach((k, i) => {
      map[k] = row[i];
    });
    expect(map['version_id']).toBe('new-version-id');
    expect(map['protocol_version']).toBe(3);
    expect(map['created_by']).toBe('ai_draft');
    // 生成に使ったモデル ID が model 列に記録される
    expect(map['model']).toBe('gemini-test');

    // store に currentFormulaVersionId / markdown / model / createdBy が入る
    expect(store.getState().currentFormulaVersionId).toBe('new-version-id');
    expect(store.getState().currentFormulaMarkdown).toContain('## PubMed/MEDLINE');
    expect(store.getState().currentFormulaModel).toBe('gemini-test');
    // 生成完了時は常に 'ai_draft'（issue #40: 手編集版の破棄確認を draftView が
    // この値で判定するため）
    expect(store.getState().currentFormulaCreatedBy).toBe('ai_draft');

    // onProgress の呼び出し順（step 列挙）
    const steps = progress.map((p) => p.step);
    expect(steps[0]).toBe('block-designer');
    expect(steps[steps.length - 1]).toBe('done');
    expect(steps).toContain('assemble');
    expect(steps).toContain('save');
  });

  test('currentProtocolVersion が未設定なら 0 で保存する', async () => {
    const { store, fetchMock, deps } = setupDeps();
    store.setState((s) => ({ ...s, currentProtocolVersion: null }));
    await generateDraft(deps);
    const appendCall = fetchMock.mock.calls.find((c) =>
      (c[0] as string).includes('FormulaVersions') && (c[0] as string).includes(':append')
    );
    const body = JSON.parse((appendCall![1] as RequestInit).body as string) as {
      values: (string | number | boolean | null)[][];
    };
    const protocolVersionIdx = SHEET_HEADERS.FormulaVersions.indexOf('protocol_version');
    expect(body.values[0]![protocolVersionIdx]).toBe(0);
  });

  test('protocol.rawTextRef があればそれを snapshot_ref に使う', async () => {
    const { store, fetchMock, deps } = setupDeps();
    store.setState((s) => ({
      ...s,
      protocolDraft: { ...s.protocolDraft!, rawTextRef: 'https://drive/snap', rawTextInline: null },
    }));
    await generateDraft(deps);
    const body = JSON.parse(
      (fetchMock.mock.calls.find((c) =>
        (c[0] as string).includes('FormulaVersions') && (c[0] as string).includes(':append')
      )![1] as RequestInit).body as string
    ) as { values: (string | number | boolean | null)[][] };
    const idx = SHEET_HEADERS.FormulaVersions.indexOf('protocol_snapshot_ref');
    expect(body.values[0]![idx]).toBe('https://drive/snap');
  });

  test('rawTextRef / rawTextInline がどちらも null なら snapshot_ref は空文字', async () => {
    const { store, fetchMock, deps } = setupDeps();
    store.setState((s) => ({
      ...s,
      protocolDraft: { ...s.protocolDraft!, rawTextRef: null, rawTextInline: null },
    }));
    await generateDraft(deps);
    const body = JSON.parse(
      (fetchMock.mock.calls.find((c) =>
        (c[0] as string).includes('FormulaVersions') && (c[0] as string).includes(':append')
      )![1] as RequestInit).body as string
    ) as { values: (string | number | boolean | null)[][] };
    const idx = SHEET_HEADERS.FormulaVersions.indexOf('protocol_snapshot_ref');
    expect(body.values[0]![idx]).toBe('');
  });

  test('parent_version_id は store の currentFormulaVersionId から引き継ぐ', async () => {
    const { store, fetchMock, deps } = setupDeps();
    store.setState((s) => ({ ...s, currentFormulaVersionId: 'prev-v' }));
    await generateDraft(deps);
    const body = JSON.parse(
      (fetchMock.mock.calls.find((c) =>
        (c[0] as string).includes('FormulaVersions') && (c[0] as string).includes(':append')
      )![1] as RequestInit).body as string
    ) as { values: (string | number | boolean | null)[][] };
    const idx = SHEET_HEADERS.FormulaVersions.indexOf('parent_version_id');
    expect(body.values[0]![idx]).toBe('prev-v');
  });

  test('プロジェクト未選択ならエラー', async () => {
    const { store, deps } = setupDeps();
    store.setState((s) => ({ ...s, project: null }));
    await expect(generateDraft(deps)).rejects.toThrow(/プロジェクト/);
  });

  test('protocolDraft 未設定ならエラー', async () => {
    const { store, deps } = setupDeps();
    store.setState((s) => ({ ...s, protocolDraft: null }));
    await expect(generateDraft(deps)).rejects.toThrow(/protocolDraft/);
  });

  test('blocksDraft 未設定ならエラー', async () => {
    const { store, deps } = setupDeps();
    store.setState((s) => ({ ...s, blocksDraft: null }));
    await expect(generateDraft(deps)).rejects.toThrow(/blocksDraft/);
  });

  test('blocks 空ならエラー', async () => {
    const { store, deps } = setupDeps();
    store.setState((s) => ({
      ...s,
      blocksDraft: { blocks: [], combinationExpression: '' },
    }));
    await expect(generateDraft(deps)).rejects.toThrow(/blocksDraft/);
  });

  test('seed あり → 各 skill に seed のタイトル・抄録・MeSH が渡る（§4.4）', async () => {
    // SeedPapers に適格 seed 1 件、efetch でその論文の MeSH/抄録を返すように fetch を分岐する
    const seedRow = [
      '111', 'Seed title', '2020', 'initial', 'pmid_direct', '',
      'true', '', '', '', '', '', '',
    ];
    const efetchXml =
      '<PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>111</PMID>' +
      '<Article><ArticleTitle>Thrombolysis for acute stroke</ArticleTitle>' +
      '<Abstract><AbstractText>We studied alteplase in ischemic stroke.</AbstractText></Abstract></Article>' +
      '<MeshHeadingList>' +
      '<MeshHeading><DescriptorName MajorTopicYN="Y">Stroke</DescriptorName>' +
      '<QualifierName>drug therapy</QualifierName></MeshHeading>' +
      '<MeshHeading><DescriptorName>Thrombolytic Therapy</DescriptorName></MeshHeading>' +
      '<MeshHeading><DescriptorName>Humans</DescriptorName></MeshHeading>' +
      '</MeshHeadingList></MedlineCitation></PubmedArticle></PubmedArticleSet>';
    const fetchMock = jest.fn((input: string) => {
      const url = String(input);
      if (url.includes('/values/SeedPapers')) {
        return Promise.resolve(jsonResponse({ values: [SHEET_HEADERS.SeedPapers, seedRow] }));
      }
      if (url.includes('efetch.fcgi')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({}),
          text: async () => efetchXml,
        } as Response);
      }
      return Promise.resolve(jsonResponse({}));
    });
    const prompts: Record<string, string[]> = {};
    const store = createStore(makeState());
    const deps: Parameters<typeof generateDraft>[0] = {
      google: {
        fetch: fetchMock as unknown as typeof fetch,
        getAccessToken: jest.fn().mockResolvedValue('t'),
      },
      store,
      eutils: { fetch: fetchMock as unknown as typeof fetch, tool: 'test' },
      llmFactory: {
        model: 'gemini-test',
        forPurpose: (purpose) => {
          const base = skillProviderFor(purpose);
          return {
            ...base,
            chat: async (messages) => {
              (prompts[purpose] ??= []).push(messages.map((m) => m.content).join('\n'));
              return base.chat(messages);
            },
          };
        },
      },
      newUuid: () => 'v',
      now: () => '2026-04-19T00:00:00.000Z',
    };
    await generateDraft(deps);
    // block-designer プロンプトに seed タイトルが含まれる
    expect(prompts['draft_block']![0]).toContain('- Thrombolysis for acute stroke');
    // suggest_mesh プロンプトにカバレッジ付き MeSH が含まれ、チェックタグは分離される
    expect(prompts['suggest_mesh']![0]).toContain('Stroke* (1/1)');
    expect(prompts['suggest_mesh']![0]).toContain('drug therapy');
    expect(prompts['suggest_mesh']![0]).toContain('チェックタグ');
    expect(prompts['suggest_mesh']![0]).not.toContain('(seed 論文の MeSH なし)');
    // freeword-designer プロンプトに seed の抄録が含まれる
    expect(prompts['expand_freeword']![0]).toContain('We studied alteplase in ischemic stroke.');
  });

  test('seed なし → suggestMesh に空配列が渡る（プロンプトは「MeSH なし」）', async () => {
    const meshPrompts: string[] = [];
    const { store, deps } = setupDeps();
    deps.llmFactory = {
      model: 'gemini-test',
      forPurpose: (purpose) => {
        const base = skillProviderFor(purpose);
        if (purpose !== 'suggest_mesh') return base;
        return {
          ...base,
          chat: async (messages) => {
            meshPrompts.push(messages.map((m) => m.content).join('\n'));
            return base.chat(messages);
          },
        };
      },
    };
    await generateDraft(deps);
    expect(store.getState().currentFormulaVersionId).toBe('new-version-id');
    expect(meshPrompts[0]).toContain('(seed 論文の MeSH なし)');
  });

  test('countBlockHits 注入時はブロックごとにヒット数を計測し blockHits を返す', async () => {
    const { deps } = setupDeps();
    const counted: string[] = [];
    const onCounted: string[] = [];
    const result = await generateDraft({
      ...deps,
      countBlockHits: async (expression) => {
        counted.push(expression);
        return 42;
      },
      onBlockCounted: (hit) => onCounted.push(`${hit.blockId}:${hit.hitCount}`),
    });
    // 2 ブロックそれぞれで計測（葉式がそのまま渡る）
    expect(counted).toHaveLength(2);
    expect(counted[0]).toContain('[Mesh]');
    expect(result.blockHits).toHaveLength(2);
    expect(result.blockHits[0]).toMatchObject({ blockId: '1', hitCount: 42, error: null });
    expect(result.blockHits[1]).toMatchObject({ blockId: '2', blockLabel: 'Intervention' });
    expect(onCounted).toEqual(['1:42', '2:42']);
  });

  test('countBlockHits が投げてもブロックは error 付きで継続し、生成は完了する', async () => {
    const { store, deps } = setupDeps();
    const result = await generateDraft({
      ...deps,
      countBlockHits: async () => {
        throw new Error('esearch failed');
      },
    });
    expect(result.blockHits).toHaveLength(2);
    expect(result.blockHits[0]?.hitCount).toBeNull();
    expect(result.blockHits[0]?.error).toContain('esearch failed');
    // 計測が失敗しても式の生成・保存は通る
    expect(store.getState().currentFormulaVersionId).toBe('new-version-id');
  });

  test('countBlockHits 未注入なら計測せず blockHits は空（line-hits step も出ない）', async () => {
    const progress: DraftProgress[] = [];
    const { deps } = setupDeps({ onProgress: (p) => progress.push(p) });
    const result = await generateDraft(deps);
    expect(result.blockHits).toHaveLength(0);
    expect(progress.map((p) => p.step)).not.toContain('line-hits');
  });

  test('newUuid / now を省略しても動く', async () => {
    const { store, deps } = setupDeps();
    const overridden = { ...deps };
    delete (overridden as { newUuid?: unknown }).newUuid;
    delete (overridden as { now?: unknown }).now;
    await generateDraft(overridden);
    expect(store.getState().currentFormulaVersionId).toBeDefined();
  });
});


describe('generateDraftFormula', () => {
  const seedContext = { titles: [], samples: [], meshSummary: { seedCount: 0, concepts: [], checkTags: [] } };

  test('保存先・store を使わず生成し、版の採番も保存進捗の通知もしない', async () => {
    const progress: DraftProgress[] = [];
    const { deps, store, fetchMock } = setupDeps({ onProgress: (p) => progress.push(p) });
    const state = store.getState();
    const update = jest.spyOn(store, 'setState');
    const uuid = jest.fn();
    const result = await generateDraftFormula({ protocol: state.protocolDraft!, blocks: state.blocksDraft!, seedContext }, {
      ...deps, ...{ newUuid: uuid },
    });
    expect(result.markdown).toContain('## PubMed/MEDLINE');
    expect(result).not.toHaveProperty('versionId');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(uuid).not.toHaveBeenCalled();
    expect(store.getState()).toBe(state);
    expect(progress.map((p) => p.step)).not.toContain('save');
    expect(progress.map((p) => p.step)).not.toContain('done');
  });

  test('空の承認ブロックは生成前に拒否する', async () => {
    const { deps, store, fetchMock } = setupDeps();
    await expect(generateDraftFormula({ protocol: store.getState().protocolDraft!, blocks: {
      blocks: [], combinationExpression: '',
    }, seedContext }, deps)).rejects.toThrow('ブロック承認');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

test.each(['generateDraftFormula', 'generateDraft'] as const)('%s が目安を全ブロックの設計だけに転送する', async (entry) => {
  const { deps, store } = setupDeps();
  const prompts: Record<string, string[]> = {};
  deps.llmFactory = { model: 'test', forPurpose: (purpose) => {
    const base = skillProviderFor(purpose);
    return { ...base, chat: async (messages) => {
      (prompts[purpose] ??= []).push(messages.find((m) => m.role === 'user')!.content);
      return base.chat(messages);
    } };
  } };
  if (entry === 'generateDraft') {
    await generateDraft(deps, { targetHits: 1234 });
  } else {
    const state = store.getState();
    await generateDraftFormula({ protocol: state.protocolDraft!, blocks: state.blocksDraft!, targetHits: 1234,
      seedContext: { titles: [], samples: [], meshSummary: { seedCount: 0, concepts: [], checkTags: [] } } }, deps);
  }
  expect(prompts.draft_block).toHaveLength(2);
  for (const prompt of prompts.draft_block!) expect(prompt).toContain('目安であって上限ではない）: 1234');
  for (const purpose of ['suggest_mesh', 'expand_freeword']) {
    expect(prompts[purpose]).toHaveLength(2);
    for (const prompt of prompts[purpose]!) expect(prompt).not.toContain('1234');
  }
});


test('辞書の missing だけを外し、後続設計・式・版の記録に反映する', async () => {
  const { deps, fetchMock } = setupDeps();
  const missing = 'Diabetic Retinopathy, Proliferative';
  const freewordChat = jest.fn().mockResolvedValue({ text: JSON.stringify({ freewords: [{ query: 'term[tiab]', rationale: '' }] }), tokensIn: null, tokensOut: null, raw: {} });
  deps.llmFactory.forPurpose = (purpose) => {
    const provider = skillProviderFor(purpose);
    if (purpose === 'suggest_mesh') provider.chat = async () => ({ text: JSON.stringify({ suggestions:
      [missing, 'Neoplasms', 'Unknown'].map((descriptor) => ({ descriptor, tag_syntax: `${descriptor}[Mesh]`, rationale: '' })) }),
      tokensIn: null, tokensOut: null, raw: {} });
    if (purpose === 'expand_freeword') provider.chat = freewordChat;
    return provider;
  };
  deps.resolveMeshDescriptors = jest.fn().mockResolvedValue(new Map<string, import('@/lib/ncbi/mesh').MeshResolution>([[missing, { status: 'missing' }], ['Neoplasms', { status: 'resolved', headings: ['Neoplasms'] }], ['Unknown', { status: 'unknown' }]]));
  const result = await generateDraft(deps);
  expect(deps.resolveMeshDescriptors).toHaveBeenCalledWith([missing, 'Neoplasms', 'Unknown']);
  expect(result.meshSuggestions.map((items) => items.map((item) => item.descriptor))).toEqual([
    ['Neoplasms', 'Unknown'], ['Neoplasms', 'Unknown'],
  ]);
  expect(result.removedMeshHeadings).toEqual([
    { blockIndex: 0, blockId: '1', blockLabel: 'Population', descriptor: missing },
    { blockIndex: 1, blockId: '2', blockLabel: 'Intervention', descriptor: missing },
  ]);
  expect(result.markdown).not.toContain(missing);
  expect(result.markdown).toContain('"Unknown"[Mesh]');
  expect(result.markdown).toContain('"Neoplasms"[Mesh]');
  const messages = JSON.stringify(freewordChat.mock.calls);
  expect(messages).not.toContain(missing);
  expect(messages).toContain('Neoplasms');
  expect(messages).toContain('Unknown');
  const append = fetchMock.mock.calls.find((call) => String(call[0]).includes('FormulaVersions') && String(call[0]).includes(':append'))!;
  const row = JSON.parse(append[1].body as string).values[0] as string[];
  expect(row[SHEET_HEADERS.FormulaVersions.indexOf('note')]).toBe(`MeSH 辞書に無い見出しを外しました: #1 ${missing}、#2 ${missing}`);
});

test('辞書確認の注入なしでは全候補を引用符付きで残す', async () => {
  const { deps, fetchMock } = setupDeps();
  const result = await generateDraft(deps);
  expect(result.removedMeshHeadings).toEqual([]);
  expect(result.replacedMeshHeadings).toEqual([]);
  expect(result.meshSuggestions.flat().map((item) => item.descriptor)).toEqual(['Desc', 'Desc']);
  expect(result.markdown).toContain('"Desc"[Mesh]');
  const append = fetchMock.mock.calls.find((call) => String(call[0]).includes('FormulaVersions') && String(call[0]).includes(':append'))!;
  const row = JSON.parse(append[1].body as string).values[0] as string[];
  expect(row[SHEET_HEADERS.FormulaVersions.indexOf('note')]).toBe('');
});


test('正式名への展開と重複除去を後続設計・式・版へ反映し、タグ指定と理由を保つ', async () => {
  const { deps, fetchMock } = setupDeps();
  const freewordChat = jest.fn().mockResolvedValue({ text: JSON.stringify({ freewords: [{ query: 'term[tiab]', rationale: '' }] }), tokensIn: null, tokensOut: null, raw: {} });
  deps.llmFactory.forPurpose = (purpose) => {
    const provider = skillProviderFor(purpose);
    if (purpose === 'suggest_mesh') provider.chat = async () => ({ text: JSON.stringify({ suggestions: [
      { descriptor: 'Heart Attack', tag_syntax: 'Heart Attack[Mesh:NoExp]', rationale: '理由' },
      { descriptor: 'Tobacco', tag_syntax: 'Tobacco[Majr]', rationale: '理由' },
      { descriptor: 'myocardial infarction', tag_syntax: 'myocardial infarction[Mesh]', rationale: '' },
      { descriptor: 'neoplasms', tag_syntax: 'neoplasms[Mesh]', rationale: '' },
      { descriptor: 'Missing', tag_syntax: 'Missing[Mesh]', rationale: '' },
    ] }), tokensIn: null, tokensOut: null, raw: {} });
    if (purpose === 'expand_freeword') provider.chat = freewordChat;
    return provider;
  };
  deps.resolveMeshDescriptors = async () => new Map<string, import('@/lib/ncbi/mesh').MeshResolution>([
    ['Heart Attack', { status: 'resolved', headings: ['Myocardial Infarction'] }],
    ['Tobacco', { status: 'resolved', headings: ['Tobacco Products', 'Nicotiana'] }],
    ['myocardial infarction', { status: 'resolved', headings: ['Myocardial Infarction'] }],
    ['neoplasms', { status: 'resolved', headings: ['Neoplasms'] }],
    ['Missing', { status: 'missing' }],
  ]);
  const result = await generateDraft(deps);
  expect(result.meshSuggestions[0]).toEqual([
    { descriptor: 'Myocardial Infarction', tagSyntax: '"Myocardial Infarction"[Mesh:NoExp]', rationale: '理由' },
    { descriptor: 'Tobacco Products', tagSyntax: '"Tobacco Products"[Majr]', rationale: '理由' },
    { descriptor: 'Nicotiana', tagSyntax: '"Nicotiana"[Majr]', rationale: '理由' },
    { descriptor: 'Neoplasms', tagSyntax: '"Neoplasms"[Mesh]', rationale: '' },
  ]);
  expect(result.replacedMeshHeadings).toEqual(['Population', 'Intervention'].flatMap((blockLabel, blockIndex) => [
    { blockIndex, blockId: String(blockIndex + 1), blockLabel, from: 'Heart Attack', to: ['Myocardial Infarction'] },
    { blockIndex, blockId: String(blockIndex + 1), blockLabel, from: 'Tobacco', to: ['Tobacco Products', 'Nicotiana'] },
  ]));
  const prompts = JSON.stringify(freewordChat.mock.calls);
  for (const heading of ['Myocardial Infarction', 'Tobacco Products', 'Nicotiana', 'Neoplasms']) {
    expect(prompts).toContain(heading);
    expect(result.markdown).toContain(`"${heading}"[`);
  }
  expect(prompts).not.toContain('Heart Attack');
  expect(result.markdown).not.toContain('Heart Attack');
  expect(result.markdown).toContain('"Myocardial Infarction"[Mesh:NoExp]');
  const append = fetchMock.mock.calls.find((call) => String(call[0]).includes('FormulaVersions') && String(call[0]).includes(':append'))!;
  const row = JSON.parse(append[1].body as string).values[0] as string[];
  expect(row[SHEET_HEADERS.FormulaVersions.indexOf('note')]).toBe('MeSH 辞書に無い見出しを外しました: #1 Missing、#2 Missing／MeSH の同義語を正式な見出しに置き換えました: #1 Heart Attack → Myocardial Infarction、#1 Tobacco → Tobacco Products、Nicotiana、#2 Heart Attack → Myocardial Infarction、#2 Tobacco → Tobacco Products、Nicotiana');
});
