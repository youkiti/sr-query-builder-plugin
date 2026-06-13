import {
  buildContextLabel,
  createLocationOptions,
  startApp,
  type AppBootstrapOptions,
} from './bootstrap';
import { createStore, INITIAL_STATE } from './store';
import { SHEET_HEADERS } from '@/domain/sheetsSchema';

function buildDocument(): Document {
  const doc = document.implementation.createHTMLDocument('test');
  doc.body.innerHTML = `
    <h1 class="app__title"><button type="button" id="app-home-link">SR Query Builder</button></h1>
    <span id="app-status"></span>
    <span id="app-context"></span>
    <aside id="app-sidebar"><nav></nav></aside>
    <section id="app-content"></section>
  `;
  return doc;
}

function noopHashOptions(initial = ''): AppBootstrapOptions {
  return {
    getHash: () => initial,
    onHashChange: jest.fn().mockReturnValue(() => undefined),
    setHash: jest.fn(),
    // 既存テストは wiring 層を触らないので runtime を無効化する
    runtime: null,
  };
}

describe('startApp', () => {
  test('初期レンダで status / sidebar / content を更新する', () => {
    const doc = buildDocument();
    startApp(doc, noopHashOptions('#/protocol'));
    expect(doc.getElementById('app-status')?.textContent).toContain('プロトコル入力');
    expect(doc.querySelectorAll('#app-sidebar nav button').length).toBeGreaterThan(0);
    expect(doc.getElementById('app-content')?.querySelector('h2')?.textContent).toBe(
      'プロトコル入力'
    );
  });

  test('プロジェクト未選択時は status に「(未選択)」と出る', () => {
    const doc = buildDocument();
    startApp(doc, noopHashOptions('#/home'));
    expect(doc.getElementById('app-status')?.textContent).toContain('(未選択)');
  });

  test('プロジェクトがあれば status にタイトルが出る', () => {
    const doc = buildDocument();
    const store = createStore({
      route: 'home',
      project: { projectId: 'p', spreadsheetId: 's', driveFolderId: 'd', title: 'My SR' },
      cumulativeCostUsd: null,
      blocksDraft: null,
      protocolDraftPersisted: false,
      protocolDraft: null,
      currentProtocolVersion: null,
      currentFormulaVersionId: null,
      currentFormulaMarkdown: null,
      draftRun: null,
      validationResult: null,
      missedAnalysis: null,
    });
    startApp(doc, { ...noopHashOptions('#/home'), store });
    expect(doc.getElementById('app-status')?.textContent).toContain('My SR');
  });

  test('hashchange 発火で再レンダする', () => {
    const doc = buildDocument();
    let listener: () => void = () => undefined;
    let currentHash = '#/home';
    const opts: AppBootstrapOptions = {
      getHash: () => currentHash,
      onHashChange: (cb) => {
        listener = cb;
        return () => undefined;
      },
      setHash: jest.fn(),
    };
    startApp(doc, opts);
    expect(doc.getElementById('app-status')?.textContent).toContain('ホーム');
    currentHash = '#/seeds';
    listener();
    expect(doc.getElementById('app-status')?.textContent).toContain('シード論文');
  });

  test('サイドバーの「プロトコル入力」ボタンで setHash が呼ばれる', () => {
    const doc = buildDocument();
    const setHash = jest.fn();
    const store = createStore({
      route: 'home',
      project: { projectId: 'p', spreadsheetId: 's', driveFolderId: 'd', title: 'T' },
      cumulativeCostUsd: null,
      blocksDraft: null,
      protocolDraftPersisted: false,
      protocolDraft: null,
      currentProtocolVersion: null,
      currentFormulaVersionId: null,
      currentFormulaMarkdown: null,
      draftRun: null,
      validationResult: null,
      missedAnalysis: null,
    });
    startApp(doc, { ...noopHashOptions('#/home'), setHash, store });
    const protocolBtn = Array.from(
      doc.querySelectorAll<HTMLButtonElement>('#app-sidebar nav button')
    ).find((b) => b.textContent === 'プロトコル入力');
    expect(protocolBtn).toBeTruthy();
    protocolBtn!.click();
    expect(setHash).toHaveBeenCalledWith('#/protocol');
  });

  test('ヘッダーのアプリタイトル（SR Query Builder）は常に表示される', () => {
    const doc = buildDocument();
    startApp(doc, noopHashOptions('#/home'));
    const btn = doc.getElementById('app-home-link') as HTMLButtonElement | null;
    expect(btn).toBeTruthy();
    expect(btn!.textContent).toContain('SR Query Builder');
  });

  test('ヘッダーのアプリタイトルをクリックすると #/home へ遷移する', () => {
    const doc = buildDocument();
    const setHash = jest.fn();
    const store = createStore({
      ...INITIAL_STATE,
      project: { projectId: 'p', spreadsheetId: 's', driveFolderId: 'd', title: 'My SR' },
    });
    startApp(doc, { ...noopHashOptions('#/protocol'), setHash, store });
    const btn = doc.getElementById('app-home-link') as HTMLButtonElement;
    btn.click();
    expect(setHash).toHaveBeenCalledWith('#/home');
  });

  test('サイドバーに「ホーム」は出さない', () => {
    const doc = buildDocument();
    startApp(doc, noopHashOptions('#/protocol'));
    const labels = Array.from(doc.querySelectorAll<HTMLButtonElement>('#app-sidebar nav button')).map(
      (button) => button.textContent
    );
    expect(labels).not.toContain('ホーム');
  });

  test('ガード未達のサイドバーボタンは is-disabled 付きで、クリック時は status に理由を表示', () => {
    const doc = buildDocument();
    const setHash = jest.fn();
    startApp(doc, { ...noopHashOptions('#/home'), setHash });
    const blocksBtn = Array.from(
      doc.querySelectorAll<HTMLButtonElement>('#app-sidebar nav button')
    ).find((b) => b.textContent === 'ブロック承認')!;
    expect(blocksBtn.classList.contains('is-disabled')).toBe(true);
    expect(blocksBtn.getAttribute('aria-disabled')).toBe('true');
    expect(blocksBtn.title).toContain('プロジェクト');
    blocksBtn.click();
    expect(setHash).not.toHaveBeenCalled();
    expect(doc.getElementById('app-status')?.textContent).toContain('プロジェクト');
  });

  test('status 要素が無くてもガード済みボタンクリックで例外にならない', () => {
    const doc = document.implementation.createHTMLDocument('no-status');
    doc.body.innerHTML = `
      <aside id="app-sidebar"><nav></nav></aside>
      <section id="app-content"></section>
    `;
    const setHash = jest.fn();
    startApp(doc, { ...noopHashOptions('#/home'), setHash });
    const blocksBtn = Array.from(
      doc.querySelectorAll<HTMLButtonElement>('#app-sidebar nav button')
    ).find((b) => b.textContent === 'ブロック承認')!;
    expect(() => blocksBtn.click()).not.toThrow();
    expect(setHash).not.toHaveBeenCalled();
  });

  test('空ハッシュでは protocol を初期表示する', () => {
    const doc = buildDocument();
    startApp(doc, noopHashOptions(''));
    expect(doc.getElementById('app-status')?.textContent).toContain('プロトコル入力');
    expect(doc.getElementById('app-content')?.querySelector('h2')?.textContent).toBe(
      'プロトコル入力'
    );
  });

  test('ハッシュで直接未達ルートに入った場合は guard placeholder を描画し、view は呼ばない', () => {
    const doc = buildDocument();
    // project 未選択のまま /blocks に直接飛ばす
    startApp(doc, noopHashOptions('#/blocks'));
    const content = doc.getElementById('app-content')!;
    expect(content.querySelector('h2')?.textContent).toBe('ブロック承認');
    const placeholder = content.querySelector('.view__placeholder');
    expect(placeholder?.textContent).toContain('プロジェクト');
    // 実 blocks view は store.blocksDraft を参照して空時にもフォームを描画するため、
    // 「placeholder しか無い = view が呼ばれていない」ことを form / fieldset 不在で確認
    expect(content.querySelector('form')).toBeNull();
    expect(content.querySelector('fieldset')).toBeNull();
  });

  test('現在のルートのサイドバーボタンに is-active が付く', () => {
    const doc = buildDocument();
    startApp(doc, noopHashOptions('#/blocks'));
    const active = doc.querySelector('#app-sidebar nav .is-active');
    expect(active?.textContent).toBe('ブロック承認');
  });

  test('store を更新すると再レンダされる', () => {
    const doc = buildDocument();
    const store = createStore();
    const handle = startApp(doc, { ...noopHashOptions('#/home'), store });
    handle.store.setState((s) => ({
      ...s,
      project: { projectId: 'p', spreadsheetId: 's', driveFolderId: 'd', title: 'New' },
    }));
    expect(doc.getElementById('app-status')?.textContent).toContain('New');
  });

  test('dispose でリスナ解除 + サブスクライブ解除', () => {
    const doc = buildDocument();
    const unlistenHash = jest.fn();
    const onHashChange = jest.fn().mockReturnValue(unlistenHash);
    const handle = startApp(doc, {
      getHash: () => '',
      onHashChange,
      setHash: jest.fn(),
    });
    handle.dispose();
    expect(unlistenHash).toHaveBeenCalledTimes(1);
  });

  test('必要な DOM 要素が欠けていても例外にならない', () => {
    const doc = document.implementation.createHTMLDocument('empty');
    expect(() => startApp(doc, noopHashOptions(''))).not.toThrow();
  });

  test('Protocol / Formula 未確定時は #app-context は空文字', () => {
    const doc = buildDocument();
    startApp(doc, noopHashOptions('#/home'));
    expect(doc.getElementById('app-context')?.textContent).toBe('');
  });

  test('Protocol version と Formula version がストアにあれば #app-context に両方出る', () => {
    const doc = buildDocument();
    const store = createStore({
      ...INITIAL_STATE,
      project: { projectId: 'p', spreadsheetId: 's', driveFolderId: 'd', title: 'My SR' },
      currentProtocolVersion: 2,
      currentFormulaVersionId: 'deadbeef-cafe-1234-5678-000000000000',
    });
    startApp(doc, { ...noopHashOptions('#/home'), store });
    const ctx = doc.getElementById('app-context')?.textContent ?? '';
    expect(ctx).toContain('Protocol v2');
    expect(ctx).toContain('Formula deadbeef');
    expect(ctx).toContain('/');
  });

  test('Protocol version だけでも #app-context に出る（Formula はまだ無い）', () => {
    const doc = buildDocument();
    const store = createStore({
      ...INITIAL_STATE,
      project: { projectId: 'p', spreadsheetId: 's', driveFolderId: 'd', title: 'T' },
      currentProtocolVersion: 1,
    });
    startApp(doc, { ...noopHashOptions('#/home'), store });
    const ctx = doc.getElementById('app-context')?.textContent ?? '';
    expect(ctx).toBe('Protocol v1');
  });
});

describe('startApp - wiring 層', () => {
  function jsonResponse(body: unknown): Response {
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response;
  }

  function makeRuntime(initialStore: Record<string, unknown> = {}): {
    runtime: NonNullable<AppBootstrapOptions['runtime']>;
    data: Record<string, unknown>;
    fetchMock: jest.Mock;
  } {
    const data = { ...initialStore };
    const fetchMock = jest.fn();
    return {
      data,
      fetchMock,
      runtime: {
        google: {
          fetch: fetchMock as unknown as typeof fetch,
          getAccessToken: jest.fn().mockResolvedValue('t'),
        },
        profile: {
          getProfileUserInfo: jest.fn().mockResolvedValue({ email: 'me@x', id: 'u' }),
        },
        store: {
          read: async <T>(key: string) => data[key] as T | undefined,
          write: async (items) => {
            Object.assign(data, items);
          },
        },
      },
    };
  }

  async function flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  /** draft の 4 skill（block-designer / mesh / freeword）が解釈できる共通 Gemini 応答 */
  function geminiDraftSkillResponse(): Response {
    return jsonResponse({
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  concept_summary: 'c',
                  mesh_requirements: [],
                  freeword_requirements: [],
                  rationale: '',
                  suggestions: [{ descriptor: 'Desc', tag_syntax: '"Desc"[Mesh]', rationale: '' }],
                  freewords: [{ query: 'term[tiab]', rationale: '' }],
                }),
              },
            ],
          },
        },
      ],
    });
  }

  /** draft ルートの前提（プロトコル承認済み + 1 ブロック）を store に流し込む。studyDesign='' でフィルタ無し */
  function seedDraftPrereqs(handle: ReturnType<typeof startApp>): void {
    handle.store.setState((s) => ({
      ...s,
      protocolDraft: {
        frameworkType: 'pico',
        researchQuestion: 'RQ',
        inclusionCriteria: '',
        exclusionCriteria: '',
        studyDesign: '',
        sourceType: 'manual',
        sourceFilename: null,
        rawTextRef: null,
        rawTextPreview: 'p',
        rawTextInline: '本文',
      },
      blocksDraft: {
        blocks: [{ blockLabel: 'P', description: 'p', aiGenerated: true, note: '' }],
        combinationExpression: '#1',
      },
      currentProtocolVersion: 1,
    }));
  }

  test('hydrate: chrome.storage の currentProject を store に取り込む', async () => {
    const doc = buildDocument();
    const { runtime } = makeRuntime({
      currentProject: { projectId: 'p', spreadsheetId: 's', driveFolderId: 'd', title: 'My SR' },
    });
    const handle = startApp(doc, { ...noopHashOptions('#/home'), runtime });
    await flush();
    expect(handle.store.getState().project?.title).toBe('My SR');
  });

  test('hydrate: 同じ projectId なら setState せず参照を変えない', async () => {
    const doc = buildDocument();
    const { runtime } = makeRuntime({
      currentProject: { projectId: 'p', spreadsheetId: 's', driveFolderId: 'd', title: 'X' },
    });
    const initialProject = {
      projectId: 'p',
      spreadsheetId: 's',
      driveFolderId: 'd',
      title: 'Initial',
    };
    const store = createStore({
      ...createStore().getState(),
      project: initialProject,
    });
    startApp(doc, { ...noopHashOptions('#/home'), store, runtime });
    await flush();
    expect(store.getState().project).toBe(initialProject);
  });

  test('hydrate: storage に何も無ければ project は null のまま', async () => {
    const doc = buildDocument();
    const { runtime } = makeRuntime();
    const handle = startApp(doc, { ...noopHashOptions('#/home'), runtime });
    await flush();
    expect(handle.store.getState().project).toBeNull();
  });

  test('protocol view 既定 onSubmit が submitProtocol を呼び blocksDraft を埋める', async () => {
    const doc = buildDocument();
    const { runtime, data, fetchMock } = makeRuntime({
      currentProject: { projectId: 'p', spreadsheetId: 's', driveFolderId: 'D', title: 'T' },
      'apiKeys.gemini': 'KEY',
    });
    const setHash = jest.fn();
    fetchMock.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('generativelanguage.googleapis.com')) {
        return jsonResponse({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      framework_type: 'pico',
                      research_question: 'RQ',
                      blocks: [{ block_label: 'P', description: 'p' }],
                      combination_expression: '#1',
                    }),
                  },
                ],
              },
            },
          ],
        });
      }
      if (typeof url === 'string' && url.includes('/upload/drive/v3/files')) {
        return jsonResponse({ id: 'f', webViewLink: 'https://drive/x' });
      }
      return jsonResponse({});
    });
    const handle = startApp(doc, {
      getHash: () => '#/protocol',
      onHashChange: jest.fn().mockReturnValue(() => undefined),
      setHash,
      runtime,
    });
    await flush(); // hydrate
    handle.store.setState((s) => ({ ...s })); // force re-render so view sees project
    const form = doc.querySelector('form')!;
    const inline = doc.querySelector<HTMLTextAreaElement>('textarea#inline')!;
    inline.value = '本文';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    await flush();
    await flush();
    expect(handle.store.getState().blocksDraft?.blocks[0]?.blockLabel).toBe('P');
    expect(setHash).toHaveBeenCalledWith('#/blocks');
    expect(data['LLM_LOG']).toBeUndefined(); // sanity: no unexpected key
  });

  /** Protocol タブの行を SHEET_HEADERS.Protocol の列順で組み立てる */
  function protocolRow(version: string, rq: string, inline = ''): string[] {
    return SHEET_HEADERS.Protocol.map((key) => {
      if (key === 'version') return version;
      if (key === 'framework_type') return 'pico';
      if (key === 'research_question') return rq;
      if (key === 'block_count') return '1';
      if (key === 'combination_expression') return '#1';
      if (key === 'source_type') return 'manual';
      if (key === 'raw_text_inline') return inline;
      if (key === 'created_at') return `2026-06-0${version}T00:00:00Z`;
      if (key === 'created_by') return 'me@x';
      return '';
    });
  }

  /** ProtocolBlocks タブの行を SHEET_HEADERS.ProtocolBlocks の列順で組み立てる */
  function protocolBlockRow(version: string, label: string): string[] {
    return SHEET_HEADERS.ProtocolBlocks.map((key) => {
      if (key === 'version') return version;
      if (key === 'block_index') return '1';
      if (key === 'block_label') return label;
      if (key === 'description') return 'desc';
      if (key === 'ai_generated') return 'TRUE';
      return '';
    });
  }

  /** Sheets 読み出し（Protocol / ProtocolBlocks / FormulaVersions）を持つ fetch ハンドラ */
  function sheetsFetchHandler(
    extra?: (url: string) => Response | null
  ): (url: string) => Promise<Response> {
    return async (url: string): Promise<Response> => {
      if (typeof url !== 'string') {
        return jsonResponse({});
      }
      const handled = extra?.(url);
      if (handled) {
        return handled;
      }
      if (url.includes(':append')) {
        return jsonResponse({});
      }
      if (url.includes('/values/ProtocolBlocks')) {
        return jsonResponse({
          values: [[...SHEET_HEADERS.ProtocolBlocks], protocolBlockRow('3', 'P-orig')],
        });
      }
      if (url.includes('/values/Protocol')) {
        return jsonResponse({
          values: [
            [...SHEET_HEADERS.Protocol],
            protocolRow('1', 'RQ v1', '本文 v1'),
            protocolRow('3', 'RQ v3', '本文 v3'),
          ],
        });
      }
      if (url.includes('/values/FormulaVersions')) {
        return jsonResponse({ values: [] });
      }
      return jsonResponse({});
    };
  }

  test('hydrate: Sheets の最新 Protocol を読み込むと persisted=true で読み取り専用表示になる', async () => {
    const doc = buildDocument();
    const { runtime, fetchMock } = makeRuntime({
      currentProject: { projectId: 'p', spreadsheetId: 's', driveFolderId: 'D', title: 'T' },
    });
    fetchMock.mockImplementation(sheetsFetchHandler());
    const handle = startApp(doc, {
      getHash: () => '#/protocol',
      onHashChange: jest.fn().mockReturnValue(() => undefined),
      setHash: jest.fn(),
      runtime,
    });
    await flush();
    const state = handle.store.getState();
    expect(state.protocolDraftPersisted).toBe(true);
    expect(state.currentProtocolVersion).toBe(3);
    expect(state.protocolDraft?.researchQuestion).toBe('RQ v3');
    handle.store.setState((s) => ({ ...s })); // 再レンダして view に反映
    expect(doc.querySelector('.protocol__readonly')).not.toBeNull();
    expect(doc.querySelector('.protocol__version-label')?.textContent).toContain('v3');
  });

  test('protocol view 既定 onListVersions が Protocol タブの全バージョンを読む', async () => {
    const doc = buildDocument();
    const { runtime, fetchMock } = makeRuntime({
      currentProject: { projectId: 'p', spreadsheetId: 's', driveFolderId: 'D', title: 'T' },
    });
    fetchMock.mockImplementation(sheetsFetchHandler());
    const handle = startApp(doc, {
      getHash: () => '#/protocol',
      onHashChange: jest.fn().mockReturnValue(() => undefined),
      setHash: jest.fn(),
      runtime,
    });
    await flush();
    handle.store.setState((s) => ({ ...s }));
    doc.querySelector<HTMLButtonElement>('.protocol__load-versions')!.click();
    await flush();
    const select = doc.querySelector<HTMLSelectElement>('#protocol-version-select')!;
    expect(select.options).toHaveLength(2);
    expect(select.options[0]?.textContent).toContain('v3');
    expect(select.options[1]?.textContent).toContain('v1');
  });

  test('protocol view 既定 onReviseKeepBlocks が既存ブロックを維持したまま新 version を追記する', async () => {
    const doc = buildDocument();
    const { runtime, fetchMock } = makeRuntime({
      currentProject: { projectId: 'p', spreadsheetId: 's', driveFolderId: 'D', title: 'T' },
      'apiKeys.gemini': 'KEY',
    });
    fetchMock.mockImplementation(
      sheetsFetchHandler((url) => {
        if (url.includes('generativelanguage.googleapis.com')) {
          return jsonResponse({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        framework_type: 'pico',
                        research_question: 'RQ 改訂版',
                        blocks: [{ block_label: 'P-llm', description: 'llm 抽出' }],
                        combination_expression: '#1',
                      }),
                    },
                  ],
                },
              },
            ],
          });
        }
        if (url.includes('/upload/drive/v3/files')) {
          return jsonResponse({ id: 'f', webViewLink: 'https://drive/x' });
        }
        return null;
      })
    );
    const handle = startApp(doc, {
      getHash: () => '#/protocol',
      onHashChange: jest.fn().mockReturnValue(() => undefined),
      setHash: jest.fn(),
      runtime,
    });
    await flush();
    handle.store.setState((s) => ({
      ...s,
      // 旧プロトコル由来の検索式があった想定（リセットされることを確認する）
      currentFormulaVersionId: 'F-old',
      currentFormulaMarkdown: '# old',
    }));

    // 読み取り専用 → 編集 → 保存 → 「既存ブロックを維持」
    doc.querySelector<HTMLButtonElement>('.protocol__edit')!.click();
    const inline = doc.querySelector<HTMLTextAreaElement>('textarea#inline')!;
    inline.value = '改訂後の本文';
    doc.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    doc.querySelector<HTMLButtonElement>('.protocol__revise-keep')!.click();
    for (let i = 0; i < 10; i += 1) {
      await flush();
    }

    const state = handle.store.getState();
    // 既存最大 v3 の次 = v4 が採番され、ブロックは LLM 抽出結果ではなく既存定義のまま
    expect(state.currentProtocolVersion).toBe(4);
    expect(state.protocolDraftPersisted).toBe(true);
    expect(state.blocksDraft?.blocks[0]?.blockLabel).toBe('P-orig');
    expect(state.protocolDraft?.researchQuestion).toBe('RQ 改訂版');
    // 検索式系の状態はリセットされる（§4.2）
    expect(state.currentFormulaVersionId).toBeNull();
    expect(state.currentFormulaMarkdown).toBeNull();
    // Protocol / ProtocolBlocks への追記が起きている
    const appended = fetchMock.mock.calls
      .map((c) => c[0] as string)
      .filter((u) => typeof u === 'string' && u.includes(':append'));
    expect(appended.some((u) => u.includes('Protocol'))).toBe(true);
    expect(appended.some((u) => u.includes('ProtocolBlocks'))).toBe(true);
  });

  test('blocks view 既定 onApprove が approveBlocks を呼ぶ', async () => {
    const doc = buildDocument();
    const { runtime, fetchMock } = makeRuntime({
      currentProject: { projectId: 'p', spreadsheetId: 'SHEET-1', driveFolderId: 'D', title: 'T' },
    });
    const setHash = jest.fn();
    fetchMock.mockResolvedValue(jsonResponse({}));
    const handle = startApp(doc, {
      getHash: () => '#/blocks',
      onHashChange: jest.fn().mockReturnValue(() => undefined),
      setHash,
      runtime,
    });
    await flush();
    handle.store.setState((s) => ({
      ...s,
      protocolDraft: {
        frameworkType: 'pico',
        researchQuestion: 'RQ',
        inclusionCriteria: '',
        exclusionCriteria: '',
        studyDesign: 'RCT',
        sourceType: 'manual',
        sourceFilename: null,
        rawTextRef: null,
        rawTextPreview: 'p',
        rawTextInline: '本文',
      },
      blocksDraft: {
        blocks: [
          { blockLabel: 'P', description: '', aiGenerated: true, note: '' },
          { blockLabel: 'I', description: '', aiGenerated: true, note: '' },
        ],
        combinationExpression: '#1 AND #2',
      },
    }));
    const approveBtn = Array.from(doc.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent?.startsWith('承認して')
    )!;
    approveBtn.click();
    await flush();
    await flush();
    await flush();
    // approveBlocks は :append を呼ぶ
    const calls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(calls.some((u) => u.includes(':append'))).toBe(true);
    expect(setHash).toHaveBeenCalledWith('#/seeds');
  });

  test('draft view 既定 onGenerate が generateDraft を呼び FormulaVersions に追記する', async () => {
    const doc = buildDocument();
    const { runtime, fetchMock } = makeRuntime({
      currentProject: { projectId: 'p', spreadsheetId: 'SHEET-1', driveFolderId: 'D', title: 'T' },
      'apiKeys.gemini': 'KEY',
    });
    fetchMock.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('generativelanguage.googleapis.com')) {
        return jsonResponse({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      concept_summary: 'c',
                      mesh_requirements: [],
                      freeword_requirements: [],
                      rationale: '',
                      suggestions: [
                        { descriptor: 'Desc', tag_syntax: '"Desc"[Mesh]', rationale: '' },
                      ],
                      freewords: [{ query: 'term[tiab]', rationale: '' }],
                    }),
                  },
                ],
              },
            },
          ],
        });
      }
      if (typeof url === 'string' && url.includes('/upload/drive/v3/files')) {
        return jsonResponse({ id: 'f', webViewLink: '' });
      }
      return jsonResponse({});
    });
    const handle = startApp(doc, {
      getHash: () => '#/draft',
      onHashChange: jest.fn().mockReturnValue(() => undefined),
      setHash: jest.fn(),
      runtime,
    });
    await flush(); // hydrate
    handle.store.setState((s) => ({
      ...s,
      protocolDraft: {
        frameworkType: 'pico',
        researchQuestion: 'RQ',
        inclusionCriteria: '',
        exclusionCriteria: '',
        studyDesign: 'RCT',
        sourceType: 'manual',
        sourceFilename: null,
        rawTextRef: null,
        rawTextPreview: 'p',
        rawTextInline: '本文',
      },
      blocksDraft: {
        blocks: [{ blockLabel: 'P', description: 'p', aiGenerated: true, note: '' }],
        combinationExpression: '#1',
      },
      // draft ルートのガードは「ブロック承認済み（currentProtocolVersion が採番済み）」を要求するため、
      // wiring 層テストでは明示的に 1 を入れておく
      currentProtocolVersion: 1,
    }));
    const generateBtn = doc.querySelector<HTMLButtonElement>('#app-content button')!;
    generateBtn.click();
    for (let i = 0; i < 10; i += 1) {
      await flush();
    }
    const calls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(calls.some((u) => u.includes('FormulaVersions') && u.includes(':append'))).toBe(true);
    expect(handle.store.getState().currentFormulaVersionId).toBeTruthy();
  });

  test('export view 既定 onExport が Conversions に 4 行追記する', async () => {
    const doc = buildDocument();
    const { runtime, fetchMock } = makeRuntime({
      currentProject: { projectId: 'p', spreadsheetId: 'SHEET-1', driveFolderId: 'D', title: 'T' },
    });
    fetchMock.mockResolvedValue(jsonResponse({}));
    const handle = startApp(doc, {
      getHash: () => '#/export',
      onHashChange: jest.fn().mockReturnValue(() => undefined),
      setHash: jest.fn(),
      runtime,
    });
    await flush();
    handle.store.setState((s) => ({
      ...s,
      currentFormulaVersionId: 'v-1',
      currentFormulaMarkdown:
        '## PubMed/MEDLINE\n\n```\n#1 "Diabetes"[Mesh]\n#2 #1 AND metformin\n```\n',
    }));
    const exportBtn = doc.querySelector<HTMLButtonElement>('#app-content button')!;
    exportBtn.click();
    for (let i = 0; i < 10; i += 1) {
      await flush();
    }
    const appendCalls = fetchMock.mock.calls.filter((c) =>
      (c[0] as string).includes('Conversions') && (c[0] as string).includes(':append')
    );
    expect(appendCalls).toHaveLength(4);
  });

  test('seeds view 既定 onIngest が SeedPapers に追記する', async () => {
    const doc = buildDocument();
    const seedHeader = [...SHEET_HEADERS.SeedPapers];
    const { runtime, fetchMock } = makeRuntime({
      currentProject: { projectId: 'p', spreadsheetId: 'SHEET-1', driveFolderId: 'D', title: 'T' },
    });
    fetchMock.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/values/SeedPapers')) {
        return jsonResponse({ values: [seedHeader] });
      }
      if (typeof url === 'string' && url.includes('eutils.ncbi.nlm.nih.gov')) {
        if (url.includes('efetch')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({}),
            text: async () =>
              `<?xml version="1.0"?><PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>111</PMID><Article><ArticleTitle>X</ArticleTitle></Article></MedlineCitation></PubmedArticle></PubmedArticleSet>`,
          } as Response;
        }
        return jsonResponse({ esearchresult: { count: '1', idlist: ['111'] } });
      }
      return jsonResponse({});
    });
    startApp(doc, {
      getHash: () => '#/seeds',
      onHashChange: jest.fn().mockReturnValue(() => undefined),
      setHash: jest.fn(),
      runtime,
    });
    await flush();
    const textarea = doc.querySelector<HTMLTextAreaElement>('.seeds__pmid-input')!;
    textarea.value = '111';
    const pmidBtn = Array.from(doc.querySelectorAll('#app-content fieldset'))[0]!.querySelector(
      'button'
    )!;
    pmidBtn.click();
    for (let i = 0; i < 10; i += 1) {
      await flush();
    }
    const appendCalls = fetchMock.mock.calls.filter((c) =>
      (c[0] as string).includes('SeedPapers') && (c[0] as string).includes(':append')
    );
    expect(appendCalls.length).toBeGreaterThan(0);
  });

  test('history view 既定 onList が FormulaVersions を読み、onLoad で store を差し替える', async () => {
    const doc = buildDocument();
    const { runtime, fetchMock } = makeRuntime({
      currentProject: { projectId: 'p', spreadsheetId: 'SHEET-1', driveFolderId: 'D', title: 'T' },
    });
    const header = [...SHEET_HEADERS.FormulaVersions];
    fetchMock.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/values/FormulaVersions')) {
        const row = (versionId: string): string[] =>
          header.map((k) => {
            if (k === 'version_id') return versionId;
            if (k === 'protocol_version') return versionId === 'v2' ? '7' : '1';
            if (k === 'formula_md') return `## PubMed/MEDLINE\n\n\`\`\`\n#1 md-${versionId}\n\`\`\`\n`;
            if (k === 'created_by') return 'ai_draft';
            if (k === 'created_at') return '2026';
            return '';
          });
        return jsonResponse({ values: [header, row('v1'), row('v2')] });
      }
      return jsonResponse({});
    });
    const handle = startApp(doc, {
      getHash: () => '#/history',
      onHashChange: jest.fn().mockReturnValue(() => undefined),
      setHash: jest.fn(),
      runtime,
    });
    await flush();
    handle.store.setState((s) => ({ ...s })); // force re-render after hydrate
    for (let i = 0; i < 5; i += 1) {
      await flush();
    }
    const items = doc.querySelectorAll('.history__item');
    expect(items.length).toBe(2);
    // 上の方（最新）は v2
    const loadBtn = items[0]!.querySelector<HTMLButtonElement>('.history__load')!;
    loadBtn.click();
    expect(handle.store.getState().currentProtocolVersion).toBe(7);
    expect(handle.store.getState().currentFormulaVersionId).toBe('v2');
    expect(handle.store.getState().currentFormulaMarkdown).toContain('md-v2');
  });

  test('edit view 既定 onSave が FormulaVersions に user_edit 行を追加する', async () => {
    const doc = buildDocument();
    const { runtime, fetchMock } = makeRuntime({
      currentProject: { projectId: 'p', spreadsheetId: 'SHEET-1', driveFolderId: 'D', title: 'T' },
    });
    fetchMock.mockResolvedValue(jsonResponse({}));
    const handle = startApp(doc, {
      getHash: () => '#/edit',
      onHashChange: jest.fn().mockReturnValue(() => undefined),
      setHash: jest.fn(),
      runtime,
    });
    await flush();
    handle.store.setState((s) => ({
      ...s,
      protocolDraft: {
        frameworkType: 'pico',
        researchQuestion: 'RQ',
        inclusionCriteria: '',
        exclusionCriteria: '',
        studyDesign: 'RCT',
        sourceType: 'manual',
        sourceFilename: null,
        rawTextRef: null,
        rawTextPreview: 'p',
        rawTextInline: '本文',
      },
      currentFormulaVersionId: 'parent-v',
      currentFormulaMarkdown: '## PubMed/MEDLINE\n\n```\n#1 old\n```\n',
    }));
    const textarea = doc.querySelector<HTMLTextAreaElement>('.edit__formula')!;
    textarea.value = '## PubMed/MEDLINE\n\n```\n#1 edited\n```\n';
    const saveBtn = doc.querySelector<HTMLButtonElement>('.edit__actions button')!;
    saveBtn.click();
    for (let i = 0; i < 5; i += 1) {
      await flush();
    }
    const appendCalls = fetchMock.mock.calls.filter((c) =>
      (c[0] as string).includes('FormulaVersions') && (c[0] as string).includes(':append')
    );
    expect(appendCalls).toHaveLength(1);
    expect(handle.store.getState().currentFormulaMarkdown).toContain('edited');
  });

  test('edit view 既定 onImproveBlock が improve-block skill を呼んで提案を返す', async () => {
    const doc = buildDocument();
    const { runtime, fetchMock } = makeRuntime({
      currentProject: { projectId: 'p', spreadsheetId: 'SHEET-1', driveFolderId: 'D', title: 'T' },
      'apiKeys.gemini': 'KEY',
    });
    fetchMock.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('generativelanguage.googleapis.com')) {
        return jsonResponse({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      proposed_expression: '"Asthma"[Mesh]',
                      rationale: 'MeSH に寄せる',
                    }),
                  },
                ],
              },
            },
          ],
        });
      }
      if (typeof url === 'string' && url.includes('/upload/drive/v3/files')) {
        return jsonResponse({ id: 'f', webViewLink: '' });
      }
      return jsonResponse({});
    });
    const handle = startApp(doc, {
      getHash: () => '#/edit',
      onHashChange: jest.fn().mockReturnValue(() => undefined),
      setHash: jest.fn(),
      runtime,
    });
    await flush();
    handle.store.setState((s) => ({
      ...s,
      protocolDraft: {
        frameworkType: 'pico',
        researchQuestion: 'RQ',
        inclusionCriteria: '',
        exclusionCriteria: '',
        studyDesign: 'RCT',
        sourceType: 'manual',
        sourceFilename: null,
        rawTextRef: null,
        rawTextPreview: 'p',
        rawTextInline: '本文',
      },
      currentFormulaVersionId: 'v1',
      currentFormulaMarkdown: '## PubMed/MEDLINE\n\n```\n#1 asthma[tiab]\n```\n',
    }));
    const improveBtn = doc.querySelector<HTMLButtonElement>('.edit__block-improve')!;
    improveBtn.click();
    for (let i = 0; i < 5; i += 1) {
      await flush();
    }
    const row = doc.querySelector('.edit__block-row[data-block-id="1"]')!;
    expect(row.querySelector('.edit__block-diff-after pre')?.textContent).toBe('"Asthma"[Mesh]');
    // LLMApiLog 追記も起こる
    const logAppends = fetchMock.mock.calls.filter((c) =>
      (c[0] as string).includes('LLMApiLog') && (c[0] as string).includes(':append')
    );
    expect(logAppends.length).toBeGreaterThan(0);
  });

  test('expand view 既定 onFetch が esearch→efetch→skill を呼び、onDecide が SeedPapers に追記する', async () => {
    const doc = buildDocument();
    const { runtime, fetchMock } = makeRuntime({
      currentProject: { projectId: 'p', spreadsheetId: 'SHEET-1', driveFolderId: 'D', title: 'T' },
      'apiKeys.gemini': 'KEY',
    });
    fetchMock.mockImplementation(async (url: string) => {
      const u = typeof url === 'string' ? url : String(url);
      if (u.includes('/values/SeedPapers')) {
        return jsonResponse({ values: [SHEET_HEADERS.SeedPapers] });
      }
      if (u.includes('esearch.fcgi')) {
        return jsonResponse({ esearchresult: { count: '50', idlist: ['111', '222'] } });
      }
      if (u.includes('efetch.fcgi')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({}),
          text: async () =>
            `<?xml version="1.0"?><PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>111</PMID><Article><ArticleTitle>A</ArticleTitle></Article></MedlineCitation></PubmedArticle><PubmedArticle><MedlineCitation><PMID>222</PMID><Article><ArticleTitle>B</ArticleTitle></Article></MedlineCitation></PubmedArticle></PubmedArticleSet>`,
        } as Response;
      }
      if (u.includes('generativelanguage.googleapis.com')) {
        return jsonResponse({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      picks: [{ pmid: '111', reason: 'subset' }],
                    }),
                  },
                ],
              },
            },
          ],
        });
      }
      if (u.includes('/upload/drive/v3/files')) {
        return jsonResponse({ id: 'f', webViewLink: '' });
      }
      return jsonResponse({});
    });
    const handle = startApp(doc, {
      getHash: () => '#/expand',
      onHashChange: jest.fn().mockReturnValue(() => undefined),
      setHash: jest.fn(),
      runtime,
    });
    await flush();
    handle.store.setState((s) => ({
      ...s,
      protocolDraft: {
        frameworkType: 'pico',
        researchQuestion: 'RQ',
        inclusionCriteria: '',
        exclusionCriteria: '',
        studyDesign: 'RCT',
        sourceType: 'manual',
        sourceFilename: null,
        rawTextRef: null,
        rawTextPreview: 'p',
        rawTextInline: '本文',
      },
      currentFormulaVersionId: 'v-1',
      currentFormulaMarkdown: '## PubMed/MEDLINE\n\n```\n#1 asthma[tiab]\n```\n',
    }));
    const fetchBtn = doc.querySelector<HTMLButtonElement>('.expand__actions button')!;
    fetchBtn.click();
    for (let i = 0; i < 10; i += 1) {
      await flush();
    }
    const items = doc.querySelectorAll('.expand__candidate');
    expect(items.length).toBe(1);
    const includeBtn = items[0]!.querySelector<HTMLButtonElement>(
      'button[data-decision=include]'
    )!;
    includeBtn.click();
    for (let i = 0; i < 5; i += 1) {
      await flush();
    }
    const seedAppends = fetchMock.mock.calls.filter((c) =>
      (c[0] as string).includes('SeedPapers') && (c[0] as string).includes(':append')
    );
    expect(seedAppends).toHaveLength(1);
  });

  test('生成→検証パイプラインが ValidationLog に検証行を追記する', async () => {
    const doc = buildDocument();
    const seedHeader = [...SHEET_HEADERS.SeedPapers];
    const { runtime, fetchMock } = makeRuntime({
      currentProject: { projectId: 'p', spreadsheetId: 'SHEET-1', driveFolderId: 'D', title: 'T' },
      'apiKeys.gemini': 'KEY',
    });
    fetchMock.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('generativelanguage.googleapis.com')) {
        return geminiDraftSkillResponse();
      }
      if (typeof url === 'string' && url.includes('/upload/drive/v3/files')) {
        return jsonResponse({ id: 'f', webViewLink: '' });
      }
      if (typeof url === 'string' && url.includes('/values/SeedPapers')) {
        const seedRow = seedHeader.map((k) => {
          if (k === 'pmid') return '111';
          if (k === 'is_valid') return 'true';
          if (k === 'source') return 'initial';
          if (k === 'ingest_format') return 'pmid_direct';
          return '';
        });
        return jsonResponse({ values: [seedHeader, seedRow] });
      }
      if (typeof url === 'string' && url.includes('eutils.ncbi.nlm.nih.gov')) {
        if (url.includes('efetch')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({}),
            text: async () => `<?xml version="1.0"?><PubmedArticleSet></PubmedArticleSet>`,
          } as Response;
        }
        return jsonResponse({ esearchresult: { count: '0', idlist: [] } });
      }
      return jsonResponse({});
    });
    const handle = startApp(doc, {
      getHash: () => '#/draft',
      onHashChange: jest.fn().mockReturnValue(() => undefined),
      setHash: jest.fn(),
      runtime,
    });
    await flush();
    seedDraftPrereqs(handle);
    const runBtn = doc.querySelector<HTMLButtonElement>('#app-content button')!;
    runBtn.click();
    for (let i = 0; i < 30; i += 1) {
      await flush();
    }
    const appendCalls = fetchMock.mock.calls.filter((c) =>
      (c[0] as string).includes('ValidationLog') && (c[0] as string).includes(':append')
    );
    // 生成式は概念 #1 + 結合 #2 の 2 ブロック（studyDesign='' でフィルタ無し）。
    // line_hits 2 行 + final_query 1 行 + mesh 1 行 = 4 行。
    expect(appendCalls.length).toBe(4);
  });

  test('生成→検証後、検証結果は store に保存され再描画後も draft に表示が残る', async () => {
    const doc = buildDocument();
    const seedHeader = [...SHEET_HEADERS.SeedPapers];
    const { runtime, fetchMock } = makeRuntime({
      currentProject: { projectId: 'p', spreadsheetId: 'SHEET-1', driveFolderId: 'D', title: 'T' },
      'apiKeys.gemini': 'KEY',
    });
    fetchMock.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('generativelanguage.googleapis.com')) {
        return geminiDraftSkillResponse();
      }
      if (typeof url === 'string' && url.includes('/upload/drive/v3/files')) {
        return jsonResponse({ id: 'f', webViewLink: '' });
      }
      if (typeof url === 'string' && url.includes('/values/SeedPapers')) {
        const seedRow = seedHeader.map((k) => {
          if (k === 'pmid') return '111';
          if (k === 'is_valid') return 'true';
          if (k === 'source') return 'initial';
          if (k === 'ingest_format') return 'pmid_direct';
          return '';
        });
        return jsonResponse({ values: [seedHeader, seedRow] });
      }
      if (typeof url === 'string' && url.includes('eutils.ncbi.nlm.nih.gov')) {
        if (url.includes('efetch')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({}),
            text: async () => `<?xml version="1.0"?><PubmedArticleSet></PubmedArticleSet>`,
          } as Response;
        }
        return jsonResponse({ esearchresult: { count: '0', idlist: [] } });
      }
      return jsonResponse({});
    });
    const handle = startApp(doc, {
      getHash: () => '#/draft',
      onHashChange: jest.fn().mockReturnValue(() => undefined),
      setHash: jest.fn(),
      runtime,
    });
    await flush();
    seedDraftPrereqs(handle);
    const runBtn = doc.querySelector<HTMLButtonElement>('#app-content button')!;
    runBtn.click();
    for (let i = 0; i < 30; i += 1) {
      await flush();
    }
    const versionId = handle.store.getState().currentFormulaVersionId;
    expect(versionId).toBeTruthy();
    expect(handle.store.getState().validationResult?.formulaVersionId).toBe(versionId);
    expect(doc.querySelector('.validate__line-hits')).not.toBeNull();

    // LLM コスト集計（onCostAccumulate）相当の setState → 全ビュー再描画
    handle.store.setState((s) => ({
      ...s,
      cumulativeCostUsd: (s.cumulativeCostUsd ?? 0) + 0.01,
    }));
    // 再描画後も state から結果が復元されている
    expect(doc.querySelector('.validate__line-hits')).not.toBeNull();
    expect(doc.querySelector('.validate__missed')?.textContent).toContain('111');
  });

  test('apiKeys.ncbi が保存されていれば、生成→検証の eutils 呼び出しに api_key が載る', async () => {
    const doc = buildDocument();
    const { runtime, fetchMock } = makeRuntime({
      currentProject: { projectId: 'p', spreadsheetId: 'SHEET-1', driveFolderId: 'D', title: 'T' },
      'apiKeys.gemini': 'KEY',
      'apiKeys.ncbi': 'NCBI-KEY',
    });
    fetchMock.mockImplementation(async (url: string) => {
      const u = typeof url === 'string' ? url : String(url);
      if (u.includes('generativelanguage.googleapis.com')) {
        return geminiDraftSkillResponse();
      }
      if (u.includes('/upload/drive/v3/files')) {
        return jsonResponse({ id: 'f', webViewLink: '' });
      }
      if (u.includes('/values/SeedPapers')) {
        return jsonResponse({ values: [SHEET_HEADERS.SeedPapers] });
      }
      if (u.includes('eutils.ncbi.nlm.nih.gov')) {
        if (u.includes('efetch')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({}),
            text: async () => `<?xml version="1.0"?><PubmedArticleSet></PubmedArticleSet>`,
          } as Response;
        }
        return jsonResponse({ esearchresult: { count: '0', idlist: [] } });
      }
      return jsonResponse({});
    });
    const handle = startApp(doc, {
      getHash: () => '#/draft',
      onHashChange: jest.fn().mockReturnValue(() => undefined),
      setHash: jest.fn(),
      runtime,
    });
    await flush();
    seedDraftPrereqs(handle);
    const runBtn = doc.querySelector<HTMLButtonElement>('#app-content button')!;
    runBtn.click();
    for (let i = 0; i < 30; i += 1) {
      await flush();
    }
    const eutilsCalls = fetchMock.mock.calls
      .map((c) => c[0] as string)
      .filter((u) => u.includes('eutils.ncbi.nlm.nih.gov'));
    expect(eutilsCalls.length).toBeGreaterThan(0);
    expect(eutilsCalls.every((u) => u.includes('api_key=NCBI-KEY'))).toBe(true);
  });
});

describe('buildContextLabel', () => {
  test('空状態は空文字', () => {
    expect(buildContextLabel(INITIAL_STATE)).toBe('');
  });

  test('Protocol version と Formula version を " / " 区切りで結合する', () => {
    expect(
      buildContextLabel({
        ...INITIAL_STATE,
        currentProtocolVersion: 5,
        currentFormulaVersionId: 'abcdef01-2345-6789-abcd-ef0123456789',
      })
    ).toBe('Protocol v5 / Formula abcdef01');
  });

  test('Formula version だけあれば Formula ラベルだけ出す', () => {
    expect(
      buildContextLabel({
        ...INITIAL_STATE,
        currentFormulaVersionId: 'short',
      })
    ).toBe('Formula short');
  });

  test('cumulativeCostUsd が非 null なら累積コストを末尾に表示する', () => {
    expect(
      buildContextLabel({
        ...INITIAL_STATE,
        cumulativeCostUsd: 0.0123,
      })
    ).toBe('累積 $0.0123');
  });

  test('Protocol / Formula / コストをすべて連結する', () => {
    expect(
      buildContextLabel({
        ...INITIAL_STATE,
        currentProtocolVersion: 2,
        currentFormulaVersionId: 'abcdef01-2345-6789-abcd-ef0123456789',
        cumulativeCostUsd: 0.005,
      })
    ).toBe('Protocol v2 / Formula abcdef01 / 累積 $0.0050');
  });
});

describe('createLocationOptions', () => {
  test('getHash / onHashChange / setHash を返す', () => {
    const addSpy = jest.fn();
    const removeSpy = jest.fn();
    const fakeWin = {
      location: { hash: '#/validate' },
      addEventListener: addSpy,
      removeEventListener: removeSpy,
    } as unknown as Window;
    const opts = createLocationOptions(fakeWin);
    expect(opts.getHash()).toBe('#/validate');
    const listener = jest.fn();
    const off = opts.onHashChange(listener);
    expect(addSpy).toHaveBeenCalledWith('hashchange', listener);
    off();
    expect(removeSpy).toHaveBeenCalledWith('hashchange', listener);
    opts.setHash('#/seeds');
    expect((fakeWin.location as Location).hash).toBe('#/seeds');
  });
});
