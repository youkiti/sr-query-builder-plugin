import {
  createLocationOptions,
  startApp,
  type AppBootstrapOptions,
} from './bootstrap';
import { createStore } from './store';
import { SHEET_HEADERS } from '@/domain/sheetsSchema';

function buildDocument(): Document {
  const doc = document.implementation.createHTMLDocument('test');
  doc.body.innerHTML = `
    <span id="app-status"></span>
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
      protocolDraft: null,
      currentProtocolVersion: null,
      currentFormulaVersionId: null,
      currentFormulaMarkdown: null,
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
      protocolDraft: null,
      currentProtocolVersion: null,
      currentFormulaVersionId: null,
      currentFormulaMarkdown: null,
    });
    startApp(doc, { ...noopHashOptions('#/home'), setHash, store });
    const protocolBtn = Array.from(
      doc.querySelectorAll<HTMLButtonElement>('#app-sidebar nav button')
    ).find((b) => b.textContent === 'プロトコル入力');
    expect(protocolBtn).toBeTruthy();
    protocolBtn!.click();
    expect(setHash).toHaveBeenCalledWith('#/protocol');
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

  test('ホーム画面のステップボタンもガードを通り、未達ルートは setHash されない', () => {
    const doc = buildDocument();
    const setHash = jest.fn();
    // project 無しなら protocol も未達
    startApp(doc, { ...noopHashOptions('#/home'), setHash });
    const homeProtocolBtn = Array.from(
      doc.querySelectorAll<HTMLButtonElement>('#app-content button')
    ).find((b) => b.textContent === 'プロトコル入力');
    expect(homeProtocolBtn).toBeTruthy();
    homeProtocolBtn!.click();
    expect(setHash).not.toHaveBeenCalled();
    expect(doc.getElementById('app-status')?.textContent).toContain('プロジェクト');
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
    expect(setHash).toHaveBeenCalledWith('#/draft');
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

  test('validate view 既定 onRun が ValidationLog に 5 行追記する', async () => {
    const doc = buildDocument();
    const seedHeader = [...SHEET_HEADERS.SeedPapers];
    const { runtime, fetchMock } = makeRuntime({
      currentProject: { projectId: 'p', spreadsheetId: 'SHEET-1', driveFolderId: 'D', title: 'T' },
    });
    fetchMock.mockImplementation(async (url: string) => {
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
      getHash: () => '#/validate',
      onHashChange: jest.fn().mockReturnValue(() => undefined),
      setHash: jest.fn(),
      runtime,
    });
    await flush();
    handle.store.setState((s) => ({
      ...s,
      currentFormulaVersionId: 'v-1',
      currentFormulaMarkdown: '## PubMed/MEDLINE\n\n```\n#1 diabetes\n```\n',
    }));
    const runBtn = doc.querySelector<HTMLButtonElement>('#app-content button')!;
    runBtn.click();
    for (let i = 0; i < 10; i += 1) {
      await flush();
    }
    const appendCalls = fetchMock.mock.calls.filter((c) =>
      (c[0] as string).includes('ValidationLog') && (c[0] as string).includes(':append')
    );
    // line_hits 1 行 + final_query 1 行 + mesh 1 行 = 3 行（formula のブロック数=1 のため）
    expect(appendCalls.length).toBe(3);
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
