import { SHEET_HEADERS } from '@/domain/sheetsSchema';
import type { ChatMessage, ChatResponse, LLMProvider } from '@/lib/llm';
import { createStore, type AppState } from '../store';
import { generateDraft, type DraftProgress } from './draftService';

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
    draftRun: null,
    validationResult: null,
    missedAnalysis: null,
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

    // store に currentFormulaVersionId / markdown が入る
    expect(store.getState().currentFormulaVersionId).toBe('new-version-id');
    expect(store.getState().currentFormulaMarkdown).toContain('## PubMed/MEDLINE');

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

  test('newUuid / now を省略しても動く', async () => {
    const { store, deps } = setupDeps();
    const overridden = { ...deps };
    delete (overridden as { newUuid?: unknown }).newUuid;
    delete (overridden as { now?: unknown }).now;
    await generateDraft(overridden);
    expect(store.getState().currentFormulaVersionId).toBeDefined();
  });
});
