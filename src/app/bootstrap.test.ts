import {
  buildContextLabel,
  createLocationOptions,
  startApp,
  type AppBootstrapOptions,
} from './bootstrap';
import { createStore, INITIAL_STATE } from './store';
import { SHEET_HEADERS } from '@/domain/sheetsSchema';
import { sharedEutilsRateLimiters } from '@/lib/ncbi';

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
      currentFormulaModel: null,
      currentFormulaCreatedBy: null,
      draftRun: null,
      expandRun: null,
      validationResult: null,
      missedAnalysis: null,
      excessFilterProposal: null,
      formulaEditDraft: null,
      blockImprovement: null,
      formulaSave: null,
      formulaEditNote: null,
      blockImprovementInstruction: null,
      blocksDraftSavedAt: null,
      hydrateError: null,
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
      currentFormulaModel: null,
      currentFormulaCreatedBy: null,
      draftRun: null,
      expandRun: null,
      validationResult: null,
      missedAnalysis: null,
      excessFilterProposal: null,
      formulaEditDraft: null,
      blockImprovement: null,
      formulaSave: null,
      formulaEditNote: null,
      blockImprovementInstruction: null,
      blocksDraftSavedAt: null,
      hydrateError: null,
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
  // bootstrap.test.ts は startApp() 経由で実物の esearch/efetch を叩く統合テストで、
  // 1 回の操作が複数リクエストを瞬時に必要とする。共有トークンバケット（issue #59）は
  // モジュールスコープで実タイマーを使うため、flush()（実時間を進めない）ではスロットリング
  // の待機が解決せず「呼び出しが起きていない」ように見えてしまう。
  // ここで検証したいのは配線であってレート制御ではない（レート制御自体は
  // rateLimit.test.ts / eutils.test.ts が担当する）ので、待機を無効化する。
  beforeEach(() => {
    jest.spyOn(sharedEutilsRateLimiters.withoutApiKey, 'acquire').mockResolvedValue(undefined);
    jest.spyOn(sharedEutilsRateLimiters.withApiKey, 'acquire').mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

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

  test('hydrate: 下書きバックアップがあれば承認済みブロックより優先して復元する', async () => {
    const doc = buildDocument();
    const { runtime, fetchMock } = makeRuntime({
      currentProject: { projectId: 'p', spreadsheetId: 's', driveFolderId: 'D', title: 'T' },
      blocksDraftBackup: {
        projectId: 'p',
        savedAt: '2026-07-01T00:00:00Z',
        draft: {
          blocks: [{ blockLabel: '下書きP', description: 'd', aiGenerated: false, note: '' }],
          combinationExpression: '#1',
        },
      },
    });
    fetchMock.mockImplementation(sheetsFetchHandler());
    const handle = startApp(doc, { ...noopHashOptions('#/home'), runtime });
    await flush();
    const state = handle.store.getState();
    // Sheets の承認済みブロック（P-orig）ではなく、バックアップの編集内容が勝つ
    expect(state.blocksDraft?.blocks[0]?.blockLabel).toBe('下書きP');
    expect(state.blocksDraftSavedAt).toBe('2026-07-01T00:00:00Z');
    expect(state.hydrateError).toBeNull();
  });

  test('hydrate: 別プロジェクトの下書きバックアップは復元しない', async () => {
    const doc = buildDocument();
    const { runtime, fetchMock } = makeRuntime({
      currentProject: { projectId: 'p', spreadsheetId: 's', driveFolderId: 'D', title: 'T' },
      blocksDraftBackup: {
        projectId: 'other-project',
        savedAt: '2026-07-01T00:00:00Z',
        draft: {
          blocks: [{ blockLabel: '他人の下書き', description: 'd', aiGenerated: false, note: '' }],
          combinationExpression: '#1',
        },
      },
    });
    fetchMock.mockImplementation(sheetsFetchHandler());
    const handle = startApp(doc, { ...noopHashOptions('#/home'), runtime });
    await flush();
    const state = handle.store.getState();
    expect(state.blocksDraft?.blocks[0]?.blockLabel).toBe('P-orig');
    expect(state.blocksDraftSavedAt).toBeNull();
  });

  test('hydrate: Sheets 読み込み失敗で hydrateError がセットされ home にバナーが出る', async () => {
    const doc = buildDocument();
    const { runtime, fetchMock } = makeRuntime({
      currentProject: { projectId: 'p', spreadsheetId: 's', driveFolderId: 'D', title: 'T' },
    });
    fetchMock.mockRejectedValue(new Error('Sheets API down'));
    const handle = startApp(doc, { ...noopHashOptions('#/home'), runtime });
    await flush();
    expect(handle.store.getState().hydrateError).toContain('Sheets API down');
    handle.store.setState((s) => ({ ...s })); // 再レンダして view に反映
    const banner = doc.querySelector('.view__hydrate-error');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain('読み込みに失敗しました');
  });

  test('hydrate 失敗バナーの「再試行」で復元をやり直し、成功したらバナーが消える', async () => {
    const doc = buildDocument();
    const { runtime, fetchMock } = makeRuntime({
      currentProject: { projectId: 'p', spreadsheetId: 's', driveFolderId: 'D', title: 'T' },
    });
    fetchMock.mockRejectedValue(new Error('temporary outage'));
    const handle = startApp(doc, { ...noopHashOptions('#/home'), runtime });
    await flush();
    handle.store.setState((s) => ({ ...s }));
    // 2 回目は成功させる
    fetchMock.mockImplementation(sheetsFetchHandler());
    doc.querySelector<HTMLButtonElement>('.view__hydrate-error-retry')!.click();
    await flush();
    const state = handle.store.getState();
    expect(state.hydrateError).toBeNull();
    expect(state.currentProtocolVersion).toBe(3);
    handle.store.setState((s) => ({ ...s }));
    expect(doc.querySelector('.view__hydrate-error')).toBeNull();
  });

  test('blocks 既定 onSaveDraft: 下書きを chrome.storage へ保存し未承認バナーを出す', async () => {
    const doc = buildDocument();
    const { runtime, data, fetchMock } = makeRuntime({
      currentProject: { projectId: 'p', spreadsheetId: 's', driveFolderId: 'D', title: 'T' },
    });
    fetchMock.mockImplementation(sheetsFetchHandler());
    const handle = startApp(doc, {
      getHash: () => '#/blocks',
      onHashChange: jest.fn().mockReturnValue(() => undefined),
      setHash: jest.fn(),
      runtime,
    });
    await flush(); // hydrate
    handle.store.setState((s) => ({ ...s })); // 再レンダして view に反映
    const saveBtn = Array.from(doc.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent === '下書きとして保存'
    )!;
    saveBtn.click();
    await flush();
    const backup = data['blocksDraftBackup'] as { projectId: string; draft: unknown } | undefined;
    expect(backup?.projectId).toBe('p');
    expect(handle.store.getState().blocksDraftSavedAt).not.toBeNull();
    // setState 由来の再レンダで未承認バナーが表示される
    const notice = doc.querySelector('.blocks__draft-notice');
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain('未承認の下書きがあります');
  });

  test('blocks 既定 onApprove: 承認で下書きバックアップを破棄する', async () => {
    const doc = buildDocument();
    const { runtime, data, fetchMock } = makeRuntime({
      currentProject: { projectId: 'p', spreadsheetId: 's', driveFolderId: 'D', title: 'T' },
      blocksDraftBackup: {
        projectId: 'p',
        savedAt: '2026-07-01T00:00:00Z',
        draft: {
          blocks: [{ blockLabel: '下書きP', description: 'd', aiGenerated: false, note: '' }],
          combinationExpression: '#1',
        },
      },
    });
    fetchMock.mockImplementation(sheetsFetchHandler());
    const handle = startApp(doc, {
      getHash: () => '#/blocks',
      onHashChange: jest.fn().mockReturnValue(() => undefined),
      setHash: jest.fn(),
      runtime,
    });
    await flush(); // hydrate（バックアップ復元）
    expect(handle.store.getState().blocksDraftSavedAt).not.toBeNull();
    handle.store.setState((s) => ({ ...s }));
    const approveBtn = Array.from(doc.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent?.includes('承認してシード論文へ')
    )!;
    approveBtn.click();
    await flush();
    await flush();
    expect(data['blocksDraftBackup']).toBeNull();
    expect(handle.store.getState().blocksDraftSavedAt).toBeNull();
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

  test('hydrate: 最新 FormulaVersion の model も store に復元する', async () => {
    const doc = buildDocument();
    const { runtime, fetchMock } = makeRuntime({
      currentProject: { projectId: 'p', spreadsheetId: 's', driveFolderId: 'D', title: 'T' },
    });
    const header = [...SHEET_HEADERS.FormulaVersions];
    const formulaRow = header.map((k) => {
      if (k === 'version_id') return 'fv-1';
      if (k === 'protocol_version') return '3';
      if (k === 'formula_md') return '## PubMed/MEDLINE\n\n```\n#1 asthma[tiab]\n```\n';
      if (k === 'created_by') return 'ai_draft';
      if (k === 'model') return 'gemini-3.5-flash';
      return '';
    });
    fetchMock.mockImplementation(
      sheetsFetchHandler((url) =>
        url.includes('/values/FormulaVersions')
          ? jsonResponse({ values: [header, formulaRow] })
          : null
      )
    );
    const handle = startApp(doc, {
      getHash: () => '#/home',
      onHashChange: jest.fn().mockReturnValue(() => undefined),
      setHash: jest.fn(),
      runtime,
    });
    await flush();
    const state = handle.store.getState();
    expect(state.currentFormulaVersionId).toBe('fv-1');
    expect(state.currentFormulaModel).toBe('gemini-3.5-flash');
    // issue #40: hydrate も createdBy を復元する（draftView の破棄確認判定に使う）
    expect(state.currentFormulaCreatedBy).toBe('ai_draft');
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
            if (k === 'model') return versionId === 'v2' ? 'gemini-3.5-flash' : '';
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
    expect(handle.store.getState().currentFormulaModel).toBe('gemini-3.5-flash');
    // issue #40: 履歴読み込みも createdBy を復元する
    expect(handle.store.getState().currentFormulaCreatedBy).toBe('ai_draft');
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
    // 鉛筆インライン編集で #1 を書き換える
    doc
      .querySelector<HTMLButtonElement>('.edit__block-row[data-block-id="1"] .edit__block-edit-toggle')!
      .click();
    const blockInput = doc.querySelector<HTMLTextAreaElement>('.edit__block-edit-input')!;
    blockInput.value = 'edited';
    doc.querySelector<HTMLButtonElement>('.edit__block-edit-save')!.click();
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

  test('edit view 既定 onSave は store.formulaSave を saving → saved と遷移させ、確認メッセージが再描画後も残る（issue #42）', async () => {
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
    doc.querySelector<HTMLButtonElement>('.edit__actions button')!.click();
    // runSaveEditedFormula は最初の await 前に同期で saving へ遷移させる
    expect(handle.store.getState().formulaSave).toEqual({
      formulaVersionId: 'parent-v',
      status: 'saving',
      error: null,
    });
    expect(doc.querySelector('.edit__status')?.textContent).toBe('保存中…');
    expect(doc.querySelector<HTMLButtonElement>('.edit__actions button')!.disabled).toBe(true);
    for (let i = 0; i < 5; i += 1) {
      await flush();
    }
    const saved = handle.store.getState().formulaSave;
    expect(saved?.status).toBe('saved');
    // 保存で採番された新しい版を持つので、保存完了の再描画後も stale にならず残る
    expect(saved?.formulaVersionId).toBe(handle.store.getState().currentFormulaVersionId);
    expect(doc.querySelector('.edit__status')?.textContent).toContain('保存しました');
    expect(doc.querySelector('.edit__status')?.textContent).toContain(saved!.formulaVersionId);
    expect(doc.querySelector('.edit__error')?.textContent).toBe('');
  });

  test('edit view 既定 onSave は失敗時に store.formulaSave を error にする', async () => {
    const doc = buildDocument();
    const { runtime, fetchMock } = makeRuntime({
      currentProject: { projectId: 'p', spreadsheetId: 'SHEET-1', driveFolderId: 'D', title: 'T' },
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
      currentFormulaVersionId: 'parent-v',
      currentFormulaMarkdown: '## PubMed/MEDLINE\n\n```\n#1 old\n```\n',
    }));
    fetchMock.mockRejectedValue(new Error('ネットワーク断'));
    doc.querySelector<HTMLButtonElement>('.edit__actions button')!.click();
    for (let i = 0; i < 5; i += 1) {
      await flush();
    }
    const save = handle.store.getState().formulaSave;
    expect(save?.status).toBe('error');
    expect(save?.formulaVersionId).toBe('parent-v');
    expect(doc.querySelector('.edit__error')?.textContent).toContain('ネットワーク断');
    expect(doc.querySelector('.edit__status')?.textContent).toBe('');
    // 失敗後はもう一度押せる
    expect(doc.querySelector<HTMLButtonElement>('.edit__actions button')!.disabled).toBe(false);
  });

  test('edit view 既定 onSave は Error 以外で失敗しても String 化して表示する', async () => {
    const doc = buildDocument();
    const { runtime, fetchMock } = makeRuntime({
      currentProject: { projectId: 'p', spreadsheetId: 'SHEET-1', driveFolderId: 'D', title: 'T' },
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
      currentFormulaVersionId: 'parent-v',
      currentFormulaMarkdown: '## PubMed/MEDLINE\n\n```\n#1 old\n```\n',
    }));
    // googleFetch は reject をラップしないので、非 Error はそのまま catch まで届く
    fetchMock.mockRejectedValue('rare');
    doc.querySelector<HTMLButtonElement>('.edit__actions button')!.click();
    for (let i = 0; i < 5; i += 1) {
      await flush();
    }
    const save = handle.store.getState().formulaSave;
    expect(save?.status).toBe('error');
    expect(save?.error).toBe('rare');
    expect(doc.querySelector('.edit__error')?.textContent).toBe('rare');
  });

  test('edit view 既定 onNoteChange が store.formulaEditNote を更新し、md 編集で保存ステータスが消える', async () => {
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
      currentFormulaVersionId: 'v1',
      currentFormulaMarkdown: '## PubMed/MEDLINE\n\n```\n#1 old\n```\n',
      formulaSave: { formulaVersionId: 'v1', status: 'saved', error: null },
    }));
    // 編集メモ: 打鍵（input）で store に載り、再描画後も入力欄に残る（PR #43 で change → input）
    const noteInput = doc.querySelector<HTMLInputElement>('.edit__note-input')!;
    noteInput.value = 'MeSH を追加';
    noteInput.dispatchEvent(new Event('input'));
    expect(handle.store.getState().formulaEditNote).toEqual({
      formulaVersionId: 'v1',
      note: 'MeSH を追加',
    });
    expect(doc.querySelector<HTMLInputElement>('.edit__note-input')!.value).toBe('MeSH を追加');

    // md を編集すると直前の「保存しました」は現在の内容を説明しないので消える
    doc
      .querySelector<HTMLButtonElement>('.edit__block-row[data-block-id="1"] .edit__block-edit-toggle')!
      .click();
    const blockInput = doc.querySelector<HTMLTextAreaElement>('.edit__block-edit-input')!;
    blockInput.value = 'edited';
    doc.querySelector<HTMLButtonElement>('.edit__block-edit-save')!.click();
    expect(handle.store.getState().formulaSave).toBeNull();
    expect(doc.querySelector('.edit__status')?.textContent).toBe('');
    // メモは版が変わっていないので残る
    expect(doc.querySelector<HTMLInputElement>('.edit__note-input')!.value).toBe('MeSH を追加');
  });

  test('edit view 既定 onNoteChange は setStateSilently 経由なので打鍵が再描画を誘発しない（PR #43 の回帰対応）', async () => {
    const doc = buildDocument();
    const { runtime } = makeRuntime({
      currentProject: { projectId: 'p', spreadsheetId: 'SHEET-1', driveFolderId: 'D', title: 'T' },
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
      currentFormulaVersionId: 'v1',
      currentFormulaMarkdown: '## PubMed/MEDLINE\n\n```\n#1 old\n```\n',
    }));

    // startApp 内部の render も含め、以後 setState（＝再描画を誘発する更新）が起きたかを
    // この購読者で監視する。setStateSilently は購読者へ通知しないため、打鍵だけなら
    // 呼ばれないはず。
    const listener = jest.fn();
    handle.store.subscribe(listener);

    const noteInput = doc.querySelector<HTMLInputElement>('.edit__note-input')!;
    noteInput.value = '打鍵中のメモ';
    noteInput.dispatchEvent(new Event('input'));

    expect(handle.store.getState().formulaEditNote).toEqual({
      formulaVersionId: 'v1',
      note: '打鍵中のメモ',
    });
    expect(listener).not.toHaveBeenCalled();
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
    // 新フロー: 改善ボタンはプロンプト欄を開くだけ。「改善案を取得」で実行する。
    for (let i = 0; i < 5; i += 1) {
      await flush();
    }
    const submitBtn = doc.querySelector<HTMLButtonElement>('.edit__block-ai-submit')!;
    submitBtn.click();
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

  test('edit view 既定 onGetImproveContext は view が計算した siblings をそのまま context へ載せる（issue #89）', async () => {
    const doc = buildDocument();
    const { runtime, fetchMock } = makeRuntime({
      currentProject: { projectId: 'p', spreadsheetId: 'SHEET-1', driveFolderId: 'D', title: 'T' },
      'apiKeys.gemini': 'KEY',
    });
    fetchMock.mockImplementation(async () => jsonResponse({}));
    const handle = startApp(doc, {
      getHash: () => '#/edit',
      onHashChange: jest.fn().mockReturnValue(() => undefined),
      setHash: jest.fn(),
      runtime,
    });
    await flush();
    handle.store.setState((s) => ({
      ...s,
      currentFormulaVersionId: 'v1',
      // #1/#2 は "Asthma"[Mesh] を共有する（結合行 #3 は比較対象に含まれない）。
      currentFormulaMarkdown: [
        '## PubMed/MEDLINE',
        '',
        '```',
        '#1 "Asthma"[Mesh] OR asthma*[tiab]',
        '#2 "Asthma"[Mesh] OR children[tiab]',
        '#3 #1 AND #2',
        '```',
        '',
      ].join('\n'),
    }));
    const row = doc.querySelector('.edit__block-row[data-block-id="1"]')!;
    row.querySelector<HTMLButtonElement>('.edit__block-improve')!.click();
    for (let i = 0; i < 5; i += 1) {
      await flush();
    }
    const siblingsSection = row.querySelector('.edit__block-ai-context-siblings');
    expect(siblingsSection?.textContent).toContain('#2:');
    expect(siblingsSection?.textContent).toContain('共有語: Asthma');
  });

  test('edit view 既定 onImproveBlock は store.blockImprovement を running → ready と遷移させる', async () => {
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
      currentFormulaVersionId: 'v1',
      currentFormulaMarkdown: '## PubMed/MEDLINE\n\n```\n#1 asthma[tiab]\n```\n',
    }));
    doc.querySelector<HTMLButtonElement>('.edit__block-improve')!.click();
    for (let i = 0; i < 5; i += 1) {
      await flush();
    }
    doc.querySelector<HTMLButtonElement>('.edit__block-ai-submit')!.click();
    // runImproveBlock は最初の await 前に同期で running へ遷移させる
    expect(handle.store.getState().blockImprovement).toEqual({
      formulaVersionId: 'v1',
      blockId: '1',
      status: 'running',
      result: null,
      error: null,
      history: [],
    });
    for (let i = 0; i < 5; i += 1) {
      await flush();
    }
    const improvement = handle.store.getState().blockImprovement;
    expect(improvement?.status).toBe('ready');
    expect(improvement?.result?.proposedExpression).toBe('"Asthma"[Mesh]');
    expect(improvement?.error).toBeNull();
    // 成功時に今回の turn（指示・提案・rationale）が history へ積まれる（issue #90）。
    expect(improvement?.history).toEqual([
      { instruction: '', proposedExpression: '"Asthma"[Mesh]', rationale: 'MeSH に寄せる' },
    ]);
  });

  test('edit view 既定 onImproveBlock は失敗時に store.blockImprovement を error にする', async () => {
    const doc = buildDocument();
    // Gemini API キー未設定 → buildLlmProviderFactory が LlmApiKeyMissingError を投げる
    const { runtime } = makeRuntime({
      currentProject: { projectId: 'p', spreadsheetId: 'SHEET-1', driveFolderId: 'D', title: 'T' },
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
      currentFormulaVersionId: 'v1',
      currentFormulaMarkdown: '## PubMed/MEDLINE\n\n```\n#1 asthma[tiab]\n```\n',
    }));
    doc.querySelector<HTMLButtonElement>('.edit__block-improve')!.click();
    for (let i = 0; i < 5; i += 1) {
      await flush();
    }
    doc.querySelector<HTMLButtonElement>('.edit__block-ai-submit')!.click();
    for (let i = 0; i < 10; i += 1) {
      await flush();
    }
    const improvement = handle.store.getState().blockImprovement;
    expect(improvement?.status).toBe('error');
    expect(improvement?.error).toContain('API キー');
    expect(doc.querySelector('.edit__block-error')?.textContent).toContain('API キー');
  });

  test('edit view 既定 onInstructionChange は setStateSilently で store.blockImprovementInstruction を更新する（issue #90）', async () => {
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
      currentFormulaVersionId: 'v1',
      currentFormulaMarkdown: '## PubMed/MEDLINE\n\n```\n#1 asthma[tiab]\n```\n',
    }));
    doc.querySelector<HTMLButtonElement>('.edit__block-improve')!.click();

    // setStateSilently は購読者へ通知しない＝再描画を誘発しない（formulaEditNote と同じ検証）。
    const listener = jest.fn();
    handle.store.subscribe(listener);

    const instructionInput = doc.querySelector<HTMLTextAreaElement>('.edit__block-ai-instruction')!;
    instructionInput.value = '打鍵中の指示';
    instructionInput.dispatchEvent(new Event('input'));

    expect(handle.store.getState().blockImprovementInstruction).toEqual({
      formulaVersionId: 'v1',
      blockId: '1',
      instruction: '打鍵中の指示',
    });
    expect(listener).not.toHaveBeenCalled();
  });

  test('edit view 既定「指示を追加してやり直す」は 2 回目の LLM 呼び出しに会話履歴を積み、store.blockImprovement.history が 2 turn になる（issue #90）', async () => {
    const doc = buildDocument();
    const { runtime, fetchMock } = makeRuntime({
      currentProject: { projectId: 'p', spreadsheetId: 'SHEET-1', driveFolderId: 'D', title: 'T' },
      'apiKeys.gemini': 'KEY',
    });
    let geminiCallCount = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('generativelanguage.googleapis.com')) {
        geminiCallCount += 1;
        const proposal =
          geminiCallCount === 1
            ? { proposed_expression: '"Asthma"[Mesh]', rationale: 'MeSH に寄せる' }
            : { proposed_expression: '"Asthma"[Mesh] OR wheeze[tiab]', rationale: 'tiab も残した' };
        return jsonResponse({
          candidates: [{ content: { parts: [{ text: JSON.stringify(proposal) }] } }],
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
      currentFormulaVersionId: 'v1',
      currentFormulaMarkdown: '## PubMed/MEDLINE\n\n```\n#1 asthma[tiab]\n```\n',
    }));
    doc.querySelector<HTMLButtonElement>('.edit__block-improve')!.click();
    for (let i = 0; i < 5; i += 1) {
      await flush();
    }
    doc.querySelector<HTMLButtonElement>('.edit__block-ai-submit')!.click();
    for (let i = 0; i < 5; i += 1) {
      await flush();
    }
    expect(handle.store.getState().blockImprovement?.status).toBe('ready');
    expect(handle.store.getState().blockImprovement?.history).toEqual([
      { instruction: '', proposedExpression: '"Asthma"[Mesh]', rationale: 'MeSH に寄せる' },
    ]);

    // 「指示を追加してやり直す」で 2 回目を送信する。
    const redoInput = doc.querySelector<HTMLTextAreaElement>('.edit__block-ai-redo-instruction')!;
    redoInput.value = 'wheeze も残して';
    doc.querySelector<HTMLButtonElement>('.edit__block-ai-redo-submit')!.click();
    for (let i = 0; i < 5; i += 1) {
      await flush();
    }

    const improvement = handle.store.getState().blockImprovement;
    expect(improvement?.status).toBe('ready');
    expect(improvement?.result?.proposedExpression).toBe('"Asthma"[Mesh] OR wheeze[tiab]');
    // 2 turn 積まれる（1 turn 目はそのまま残り、2 turn 目に今回の指示・提案が足される）。
    expect(improvement?.history).toEqual([
      { instruction: '', proposedExpression: '"Asthma"[Mesh]', rationale: 'MeSH に寄せる' },
      {
        instruction: 'wheeze も残して',
        proposedExpression: '"Asthma"[Mesh] OR wheeze[tiab]',
        rationale: 'tiab も残した',
      },
    ]);

    // 2 回目の Gemini 呼び出しには 1 turn 目の model メッセージが会話履歴として積まれている。
    const geminiCalls = fetchMock.mock.calls.filter((c) =>
      (c[0] as string).includes('generativelanguage.googleapis.com')
    );
    expect(geminiCalls).toHaveLength(2);
    const secondBody = JSON.parse((geminiCalls[1]![1] as RequestInit).body as string) as {
      contents: Array<{ role: string; parts: Array<{ text: string }> }>;
    };
    // system は systemInstruction 側へ分離されるため contents には user/model のみが並ぶ:
    // user(文脈テンプレート) → model(1 turn 目の提案) → user(今回の指示)。
    expect(secondBody.contents).toHaveLength(3);
    expect(secondBody.contents[1]!.role).toBe('model');
    const modelTurn = JSON.parse(secondBody.contents[1]!.parts[0]!.text) as {
      proposed_expression: string;
      rationale: string;
    };
    expect(modelTurn.proposed_expression).toBe('"Asthma"[Mesh]');
    expect(modelTurn.rationale).toBe('MeSH に寄せる');
    expect(secondBody.contents[2]!.role).toBe('user');
    expect(secondBody.contents[2]!.parts[0]!.text).toBe('wheeze も残して');
  });

  test('edit view 既定 onDraftChange / onClearImprovement が store を更新する', async () => {
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
      currentFormulaVersionId: 'v1',
      currentFormulaMarkdown: '## PubMed/MEDLINE\n\n```\n#1 asthma[tiab]\n```\n',
    }));
    // 鉛筆編集 → onDraftChange 経由で store.formulaEditDraft が更新される
    doc
      .querySelector<HTMLButtonElement>('.edit__block-row[data-block-id="1"] .edit__block-edit-toggle')!
      .click();
    const input = doc.querySelector<HTMLTextAreaElement>('.edit__block-edit-input')!;
    input.value = 'edited[tiab]';
    doc.querySelector<HTMLButtonElement>('.edit__block-edit-save')!.click();
    expect(handle.store.getState().formulaEditDraft?.formulaVersionId).toBe('v1');
    expect(handle.store.getState().formulaEditDraft?.markdown).toContain('#1 edited[tiab]');

    // onClearImprovement: reject ボタンで store.blockImprovement が null に戻る
    handle.store.setState((s) => ({
      ...s,
      blockImprovement: {
        formulaVersionId: 'v1',
        blockId: '1',
        status: 'ready',
        result: {
          blockId: '1',
          currentExpression: 'edited[tiab]',
          proposedExpression: 'proposed[tiab]',
          rationale: 'r',
        },
        error: null,
        history: [],
      },
    }));
    doc.querySelector<HTMLButtonElement>('.edit__block-reject')!.click();
    expect(handle.store.getState().blockImprovement).toBeNull();
  });

  test('edit view 既定インスペクタ callback（onCountHits）は既存の esearch 経路（db=pubmed）を叩く（issue #58 chunk 3a）', async () => {
    const doc = buildDocument();
    const { runtime, fetchMock } = makeRuntime({
      currentProject: { projectId: 'p', spreadsheetId: 'SHEET-1', driveFolderId: 'D', title: 'T' },
    });
    fetchMock.mockResolvedValue(jsonResponse({ esearchresult: { count: '5', idlist: [] } }));
    const handle = startApp(doc, {
      getHash: () => '#/edit',
      onHashChange: jest.fn().mockReturnValue(() => undefined),
      setHash: jest.fn(),
      runtime,
    });
    await flush();
    handle.store.setState((s) => ({
      ...s,
      currentFormulaVersionId: 'v1',
      currentFormulaMarkdown: '## PubMed/MEDLINE\n\n```\n#1 asthma[tiab]\n```\n',
    }));
    // 鉛筆を開くとブロック・インスペクタが展開し、フリーワード Δ 計算が onCountHits
    // （bootstrap 既定実装 = esearch）を呼ぶ。
    doc.querySelector<HTMLButtonElement>('.edit__block-edit-toggle')!.click();
    for (let i = 0; i < 5; i += 1) {
      await flush();
    }
    const esearchCalls = fetchMock.mock.calls
      .map(([url]) => String(url))
      .filter((u) => u.includes('esearch.fcgi') && u.includes('db=pubmed'));
    expect(esearchCalls.length).toBeGreaterThan(0);
    expect(esearchCalls[0]).toContain('term=asthma');
    expect(doc.querySelector('.bins__delta-row')).toBeTruthy();
    expect(doc.querySelector('.bins__count--done, .bins__delta-individual')?.textContent).toContain(
      '5 件'
    );
  });

  test('expand view 既定 onFetch が esearch→efetch→skill を呼び、onDecide が SeedPapers に追記する', async () => {
    const doc = buildDocument();
    const { runtime, fetchMock } = makeRuntime({
      currentProject: { projectId: 'p', spreadsheetId: 'SHEET-1', driveFolderId: 'D', title: 'T' },
      'apiKeys.gemini': 'KEY',
    });
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
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
        // 1 回目は expand-query-for-recall（拡張語）、2 回目は pick-boundary-cases（候補選定）。
        // system プロンプトに 'recall' が含まれるかで返答を切り替える。
        const body = typeof init?.body === 'string' ? init.body : '';
        const llmText = body.includes('recall')
          ? JSON.stringify({
              blocks: [
                {
                  id: '1',
                  additions: [
                    { term: '"Lung Diseases"[Mesh]', axis: 'mesh', rationale: '親概念へ拡張' },
                  ],
                },
              ],
            })
          : JSON.stringify({ picks: [{ pmid: '111', reason: 'subset' }] });
        return jsonResponse({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: llmText,
                  },
                ],
              },
            },
          ],
          // 実 Gemini はトークン数を返すため LLM コスト集計の setState（→ 全ビュー再描画）が
          // 走る。この再描画でも取得結果（候補一覧）が消えないこと＝store.expandRun 保持の
          // 回帰テストとして、トークン数を載せて cost を非 null にしておく。
          usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
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

  test('境界事例取得が失敗すると expandRun=error になりエラーを表示する', async () => {
    const doc = buildDocument();
    // Gemini API キー未設定 → buildLlmProviderFactory が LlmApiKeyMissingError を投げる
    const { runtime } = makeRuntime({
      currentProject: { projectId: 'p', spreadsheetId: 'SHEET-1', driveFolderId: 'D', title: 'T' },
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
      currentFormulaVersionId: 'v-1',
      currentFormulaMarkdown: '## PubMed/MEDLINE\n\n```\n#1 asthma[tiab]\n```\n',
    }));
    doc.querySelector<HTMLButtonElement>('.expand__actions button')!.click();
    for (let i = 0; i < 10; i += 1) {
      await flush();
    }
    const expandRun = handle.store.getState().expandRun;
    expect(expandRun?.status).toBe('error');
    expect(expandRun?.error).toContain('API キー');
    expect(doc.querySelector('.expand__error')?.textContent).toContain('API キー');
    expect(doc.querySelector('.expand__candidate')).toBeNull();
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

  const REVALIDATE_MD = '## PubMed/MEDLINE\n\n```\n#1 "asthma"[tiab]\n#2 "children"[tiab]\n#3 #1 AND #2\n```\n';

  /** 検証フェーズ失敗直後（生成済み式あり）の状態を store に流し込む */
  function seedValidatingError(handle: ReturnType<typeof startApp>): void {
    seedDraftPrereqs(handle);
    handle.store.setState((s) => ({
      ...s,
      currentFormulaVersionId: 'fv-1',
      currentFormulaMarkdown: REVALIDATE_MD,
      draftRun: {
        status: 'error',
        phase: 'validating',
        progressLabel: '',
        startedAtMs: Date.now(),
        error: 'NCBI 503',
        blockHits: [],
      },
    }));
  }

  /** 検証だけ回すのに必要な NCBI / Sheets / Drive のモック（esearch は count を返す） */
  function mockValidationFetch(fetchMock: jest.Mock, esearchCount: string): void {
    fetchMock.mockImplementation(async (url: string) => {
      const u = typeof url === 'string' ? url : String(url);
      if (u.includes('generativelanguage.googleapis.com')) {
        return jsonResponse({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      candidates: [
                        {
                          label: '英語論文に限定',
                          expression: 'english[la]',
                          rationale: '非英語論文を除外するリスクあり',
                        },
                      ],
                    }),
                  },
                ],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        });
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
        return jsonResponse({ esearchresult: { count: esearchCount, idlist: [] } });
      }
      return jsonResponse({});
    });
  }

  test('「検証のみ再実行」は LLM を呼ばずに検証を回す（fix-plan 2-2）', async () => {
    const doc = buildDocument();
    const { runtime, fetchMock } = makeRuntime({
      currentProject: { projectId: 'p', spreadsheetId: 'SHEET-1', driveFolderId: 'D', title: 'T' },
      // apiKeys.gemini は意図的に置かない: LLM が呼ばれたら factory 生成で失敗して気付ける
    });
    mockValidationFetch(fetchMock, '5');
    const handle = startApp(doc, {
      getHash: () => '#/draft',
      onHashChange: jest.fn().mockReturnValue(() => undefined),
      setHash: jest.fn(),
      runtime,
    });
    await flush();
    seedValidatingError(handle);
    const btn = doc.querySelector<HTMLButtonElement>('.draft__revalidate');
    expect(btn).not.toBeNull();
    btn!.click();
    for (let i = 0; i < 30; i += 1) {
      await flush();
    }
    const llmCalls = fetchMock.mock.calls.filter((c) =>
      (c[0] as string).includes('generativelanguage.googleapis.com')
    );
    expect(llmCalls).toHaveLength(0);
    const state = handle.store.getState();
    expect(state.draftRun).toBeNull();
    expect(state.validationResult?.formulaVersionId).toBe('fv-1');
    expect(state.validationResult?.summary.lineHits.length).toBeGreaterThan(0);
  });

  test('検証完了時に総ヒット > 10,000 なら design_filter を呼び提案を保存する（fix-plan 2-1）', async () => {
    const doc = buildDocument();
    const { runtime, fetchMock } = makeRuntime({
      currentProject: { projectId: 'p', spreadsheetId: 'SHEET-1', driveFolderId: 'D', title: 'T' },
      'apiKeys.gemini': 'KEY',
    });
    mockValidationFetch(fetchMock, '10001');
    const handle = startApp(doc, {
      getHash: () => '#/draft',
      onHashChange: jest.fn().mockReturnValue(() => undefined),
      setHash: jest.fn(),
      runtime,
    });
    await flush();
    seedValidatingError(handle);
    doc.querySelector<HTMLButtonElement>('.draft__revalidate')!.click();
    for (let i = 0; i < 30; i += 1) {
      await flush();
    }
    const state = handle.store.getState();
    expect(state.excessFilterProposal?.formulaVersionId).toBe('fv-1');
    expect(state.excessFilterProposal?.totalHits).toBe(10001);
    expect(state.excessFilterProposal?.candidates).toEqual([
      expect.objectContaining({ label: '英語論文に限定', expression: 'english[la]' }),
    ]);
    // view にも承認 UI が出る
    expect(doc.querySelector('.draft__excess')).not.toBeNull();
    // 式はまだ変更されていない（承認ゲート）
    expect(state.currentFormulaMarkdown).toBe(REVALIDATE_MD);
  });

  test('同一バージョンへ提案済みなら design_filter を再度呼ばない（fix-plan 2-1 / LLM 二重呼び出し防止）', async () => {
    const doc = buildDocument();
    const { runtime, fetchMock } = makeRuntime({
      currentProject: { projectId: 'p', spreadsheetId: 'SHEET-1', driveFolderId: 'D', title: 'T' },
      'apiKeys.gemini': 'KEY',
    });
    mockValidationFetch(fetchMock, '10001');
    const handle = startApp(doc, {
      getHash: () => '#/draft',
      onHashChange: jest.fn().mockReturnValue(() => undefined),
      setHash: jest.fn(),
      runtime,
    });
    await flush();
    seedValidatingError(handle);
    // 現在の formulaVersionId（'fv-1'）に対する提案が既に保存されている状態を再現する
    const existingProposal = {
      formulaVersionId: 'fv-1',
      totalHits: 10001,
      candidates: [
        { label: '既存候補', expression: 'existing[la]', rationale: '既に提案済み' },
      ],
      error: null,
    };
    handle.store.setState((s) => ({ ...s, excessFilterProposal: existingProposal }));
    doc.querySelector<HTMLButtonElement>('.draft__revalidate')!.click();
    for (let i = 0; i < 30; i += 1) {
      await flush();
    }
    // design_filter（Gemini）は一度も呼ばれていない = 早期 return が効いている
    const geminiCalls = fetchMock.mock.calls.filter((c) =>
      (c[0] as string).includes('generativelanguage.googleapis.com')
    );
    expect(geminiCalls).toHaveLength(0);
    // 既存の提案は上書きされずそのまま残る
    expect(handle.store.getState().excessFilterProposal).toEqual(existingProposal);
    // 検証自体は完走している（再検証の主機能は妨げられない）
    expect(handle.store.getState().validationResult?.formulaVersionId).toBe('fv-1');
  });

  test('フィルタ承認で式が更新され新バージョン追記 + 再検証、拒否（見送り）では式不変（fix-plan 2-1）', async () => {
    const doc = buildDocument();
    const { runtime, fetchMock } = makeRuntime({
      currentProject: { projectId: 'p', spreadsheetId: 'SHEET-1', driveFolderId: 'D', title: 'T' },
      'apiKeys.gemini': 'KEY',
    });
    mockValidationFetch(fetchMock, '10001');
    const handle = startApp(doc, {
      getHash: () => '#/draft',
      onHashChange: jest.fn().mockReturnValue(() => undefined),
      setHash: jest.fn(),
      runtime,
    });
    await flush();
    seedDraftPrereqs(handle);
    handle.store.setState((s) => ({
      ...s,
      currentFormulaVersionId: 'fv-1',
      currentFormulaMarkdown: REVALIDATE_MD,
      excessFilterProposal: {
        formulaVersionId: 'fv-1',
        totalHits: 10001,
        candidates: [
          { label: '英語論文に限定', expression: 'english[la]', rationale: 'リスクあり' },
        ],
        error: null,
      },
    }));

    // --- 見送り: 式は変更されず提案だけ破棄される ---
    doc.querySelector<HTMLButtonElement>('.draft__excess-dismiss')!.click();
    expect(handle.store.getState().excessFilterProposal).toBeNull();
    expect(handle.store.getState().currentFormulaMarkdown).toBe(REVALIDATE_MD);
    expect(
      fetchMock.mock.calls.filter(
        (c) =>
          (c[0] as string).includes('FormulaVersions') && (c[0] as string).includes(':append')
      )
    ).toHaveLength(0);

    // --- 承認: 式へ追記 → FormulaVersions 追記 → 再検証 ---
    handle.store.setState((s) => ({
      ...s,
      excessFilterProposal: {
        formulaVersionId: 'fv-1',
        totalHits: 10001,
        candidates: [
          { label: '英語論文に限定', expression: 'english[la]', rationale: 'リスクあり' },
        ],
        error: null,
      },
    }));
    const check = doc.querySelector<HTMLInputElement>('.draft__excess-check')!;
    check.checked = true;
    check.dispatchEvent(new Event('change'));
    doc.querySelector<HTMLButtonElement>('.draft__excess-apply')!.click();
    for (let i = 0; i < 40; i += 1) {
      await flush();
    }
    const state = handle.store.getState();
    expect(state.currentFormulaMarkdown).toContain('#Filter1 english[la]');
    expect(state.currentFormulaMarkdown).toContain('#3 #1 AND #2 AND #Filter1');
    expect(state.currentFormulaVersionId).not.toBe('fv-1');
    // 新バージョンの追記（FormulaVersions :append）が走っている
    const appendCalls = fetchMock.mock.calls.filter(
      (c) =>
        (c[0] as string).includes('FormulaVersions') && (c[0] as string).includes(':append')
    );
    expect(appendCalls.length).toBeGreaterThan(0);
    // 承認後は検証のみ再実行され、新バージョンの検証結果が保存される
    expect(state.validationResult?.formulaVersionId).toBe(state.currentFormulaVersionId);
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
