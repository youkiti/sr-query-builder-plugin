/**
 * tests/harness-contract/contract.ts に宣言した契約を、実際に描画して検証する（issue #183）。
 *
 * 消費側が操作する状態ごとに、要素の有効性・一意性・排他性と再描画時の変化を検証する。
 * 消費側が依存しない兄弟順序や装飾クラスは固定しない。
 *
 * `contractTest()` は宣言（HARNESS_CONTRACT）と実行を紐づけるための薄いラッパーで、
 * 末尾の「宣言とテストの対応（coverage）」が、verified: true の項目すべてに対応する
 * test() が実際に走ったことを機械的に確認する。
 */

import { createDraftView } from '@/app/views/draftView';
import { INITIAL_STATE, type AppState, type BlocksDraft } from '@/app/store';
import type { ChromeRuntimeDeps } from '@/app/services/factories';
import { sharedEutilsRateLimiters } from '@/lib/ncbi';
import { demoFetch } from '@/demo/fetchMock';
import { applyDemoSeed } from '@/demo/seeds';
import { startPopup, type PopupDeps } from '@/popup/bootstrap';
import { startOptions, type OptionsDeps } from '@/options/bootstrap';
import { createSettingsView, type SettingsViewCallbacks } from '@/app/views/settingsView';
import type { ViewContext } from '@/app/views/types';
import { startApp } from '@/app/bootstrap';
import { getContract, HARNESS_CONTRACT } from './contract';
import { loadHtmlBody } from './loadHtmlBody';

/**
 * `__BUILD_DATE__` は webpack の DefinePlugin が本番ビルド時にのみ埋め込むグローバル定数
 * （popup/options/app 各 bootstrap.ts が参照する）。webpack を経由しない ts-jest では未定義の
 * ままなので、実 HTML（*-build-date 要素を含む）を読み込むこのテストでは自分で用意する。
 * 既存の bootstrap.test.ts 系は build-date 要素自体を含まない fabricated スケルトンで
 * この参照を素通りさせているが、ここでは実ファイルを検証対象にするためその回避が使えない。
 */
(globalThis as typeof globalThis & { __BUILD_DATE__: string }).__BUILD_DATE__ =
  'harness-contract-test';

/** verified: true の contract を検証する test()。実行された id を記録し、末尾の coverage で使う。 */
const verifiedRan = new Set<string>();
function contractTest(id: string, fn: () => void | Promise<void>): void {
  const entry = getContract(id);
  if (!entry.verified) {
    throw new Error(
      `[harness-contract] "${id}" は contract.ts で verified:false です。` +
        'このヘルパーは verified:true の契約専用です（宣言のみの項目はテストを書かない）。'
    );
  }
  test(`[${id}] ${entry.verifiedBy ?? entry.expectation}`, async () => {
    verifiedRan.add(id);
    await fn();
  });
}

// ── #/draft ──────────────────────────────────────────────────────────────

function buildContainer(): HTMLElement {
  const doc = document.implementation.createHTMLDocument('harness-contract-draft');
  const div = doc.createElement('div');
  doc.body.appendChild(div);
  return div;
}

const DRAFT_BLOCKS: BlocksDraft = {
  blocks: [{ blockLabel: 'P', description: 'p', aiGenerated: true, note: '' }],
  combinationExpression: '#1',
};

function draftState(extra: Partial<AppState> = {}): AppState {
  return {
    ...INITIAL_STATE,
    project: { projectId: 'p', spreadsheetId: 's', driveFolderId: 'd', title: 'T' },
    protocolDraftPersisted: true,
    blocksDraft: DRAFT_BLOCKS,
    queryOptimizationSetup: {
      projectId: 'p',
      status: 'ready',
      maxHits: '2000',
      maxIterations: '5',
      seedCount: 1,
      seedPmids: ['12345678'],
      error: null,
    },
    ...extra,
  };
}

const EXISTING_MD = '## PubMed/MEDLINE\n\n```\n#1 x\n```\n';

describe('harness contract > #/draft', () => {
  contractTest('draft.no-formula.single-primary-action', () => {
    const container = buildContainer();
    const onOptimize = jest.fn(async () => undefined);
    createDraftView({ onOptimize })(container, { state: draftState(), navigate: jest.fn() });
    const doc = container.ownerDocument;
    const starts = doc.querySelectorAll<HTMLButtonElement>('.optimization__start');
    expect(starts).toHaveLength(1);
    const start = starts[0]!;
    expect(start.matches(':disabled')).toBe(false);
    expect(start.closest('[hidden]')).toBeNull();
    const setup = container.querySelector('section.optimization__setup')!;
    const details = setup.querySelector('details')!;
    expect(details).not.toBeNull();
    const summary = details.querySelector('summary')!;
    expect(summary).not.toBeNull();
    if (!details.open) summary.click();
    expect(details.open).toBe(true);
    for (const [text, value] of [['目安件数', '100'], ['反復上限', '1']]) {
      const labels = Array.from(setup.querySelectorAll('label')).filter(
        (label) => label.textContent?.trim() === text
      );
      expect(labels).toHaveLength(1);
      const label = labels[0]!;
      const input = label.querySelector<HTMLInputElement>(':scope > input');
      expect(input).not.toBeNull();
      expect(Array.from(input!.labels ?? [])).toContain(label);
      expect(input!.matches(':disabled')).toBe(false);
      expect(input!.readOnly).toBe(false);
      expect(input!.closest('[hidden], details:not([open])')).toBeNull();
      if (text === '反復上限') expect(details.contains(input)).toBe(true);
      input!.value = value!;
    }
    expect(container.querySelector('.draft__actions')).toBeNull();
    expect(doc.querySelectorAll('.draft__revalidate')).toHaveLength(0);
    expect(doc.querySelectorAll('.draft__generate')).toHaveLength(0);
    start.click();
    expect(onOptimize).toHaveBeenCalledWith({ maxHits: 100, maxIterations: 1 });
  });

  contractTest('draft.formula-exists.unique-secondary-actions', () => {
    const container = buildContainer();
    const onGenerate = jest.fn(async () => undefined);
    const render = createDraftView({ onGenerate });
    const state = draftState({
      currentFormulaMarkdown: EXISTING_MD,
      currentFormulaVersionId: 'v-1',
      currentFormulaCreatedBy: 'auto_optimize',
    });
    render(container, { state, navigate: jest.fn() });
    const doc = container.ownerDocument;
    expect(doc.querySelectorAll('.draft__revalidate')).toHaveLength(1);
    expect(doc.querySelectorAll('.draft__generate')).toHaveLength(1);
    doc.querySelector<HTMLButtonElement>('.draft__generate')!.click();
    expect(onGenerate).toHaveBeenCalledTimes(1);
    expect(doc.querySelector('.draft__discard-confirm:not([hidden])')).toBeNull();

    // 手編集の版では再生成前の確認が必要になる。
    onGenerate.mockClear();
    render(container, {
      state: draftState({
        ...state,
        currentFormulaCreatedBy: 'user_edit',
      }),
      navigate: jest.fn(),
    });
    doc.querySelector<HTMLButtonElement>('.draft__generate')!.click();
    expect(doc.querySelector('.draft__discard-confirm:not([hidden])')).not.toBeNull();
    expect(onGenerate).not.toHaveBeenCalled();
  });

  contractTest('draft.block-hits.generation-only', async () => {
    const originalFetch = globalThis.fetch;
    const data: Record<string, unknown> = {};
    const storageGet = jest.spyOn(chrome.storage.local, 'get').mockImplementation(async () => data);
    const storageSet = jest.spyOn(chrome.storage.local, 'set').mockImplementation(async (items) => {
      Object.assign(data, items);
    });
    const rateLimit = jest.spyOn(sharedEutilsRateLimiters.withoutApiKey, 'acquire')
      .mockResolvedValue(undefined);
    // 外部通信はデモの応答に置換し、生成・検証・完了処理は実アプリを通す。
    globalThis.fetch = demoFetch;
    const runtime: ChromeRuntimeDeps = {
      google: { fetch: demoFetch, getAccessToken: async () => 'demo-access-token' },
      profile: { getProfileUserInfo: async () => ({ email: 'demo@example.com', id: 'demo' }) },
      store: {
        read: async <T>(key: string) => data[key] as T | undefined,
        write: async (items) => { Object.assign(data, items); },
      },
    };
    const doc = document.implementation.createHTMLDocument('harness-contract-generation');
    doc.body.innerHTML = loadHtmlBody('src/app/app.html');
    const container = doc.getElementById('app-content')!;
    let app: ReturnType<typeof startApp> | undefined;
    let unsubscribe: (() => void) | undefined;
    const waitUntil = async (ready: () => boolean): Promise<void> => {
      for (let i = 0; i < 500; i++) {
        if (ready()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`生成・検証が完了しません: ${container.textContent}`);
    };
    try {
      await applyDemoSeed('08-validation');
      app = startApp(doc, {
        runtime,
        getHash: () => '#/draft',
        onHashChange: () => () => undefined,
        setHash: jest.fn(),
      });
      const store = app.store;
      await waitUntil(() => store.getState().queryOptimizationSetup?.status === 'ready');
      const protocol = store.getState().protocolDraft!;
      // デモ既定の入力は通知なし。混在する研究デザインでは本番の生成処理が
      // filterNotice を作るため、通知を保持する完了分岐も通せる。
      for (const studyDesign of [protocol.studyDesign, 'RCT / observational']) {
        store.setState((state) => ({
          ...state,
          protocolDraft: { ...protocol, studyDesign },
        }));
        const beforeVersion = store.getState().currentFormulaVersionId;
        expect(container.querySelector('.draft__block-hits')).toBeNull();
        const liveHits: number[] = [];
        unsubscribe = store.subscribe(() => {
          const run = store.getState().draftRun;
          if (run?.status === 'running' && run.phase === 'generating') {
            liveHits.push(container.querySelectorAll('.draft__block-hits .draft__block-hit--done').length);
          }
        });
        container.querySelector<HTMLButtonElement>('.draft__generate')!.click();
        expect(store.getState().draftRun?.status).toBe('running');
        expect(container.querySelector('.draft__block-hits')).not.toBeNull();
        await waitUntil(() => {
          const state = store.getState();
          return state.draftRun?.status === 'error' || (
            state.draftRun?.status !== 'running' && state.validationResult !== null &&
            state.validationResult.formulaVersionId !== beforeVersion
          );
        });
        unsubscribe();
        unsubscribe = undefined;
        expect(store.getState().draftRun?.error).toBeFalsy();
        expect(liveHits).toContain(3);
        expect(container.querySelector('.draft__validate-status')).not.toBeNull();
        expect(container.querySelector('.draft__block-hits')).toBeNull();
        if (studyDesign === protocol.studyDesign) {
          expect(store.getState().draftRun).toBeNull();
        } else {
          expect(store.getState().draftRun).toMatchObject({
            status: 'done',
            filterNotice: expect.stringContaining('RCT'),
            blockHits: [],
          });
          expect(container.querySelector('.draft__mesh-notice')?.textContent).toContain('RCT');
        }
      }
    } finally {
      unsubscribe?.();
      app?.dispose();
      globalThis.fetch = originalFetch;
      storageGet.mockRestore();
      storageSet.mockRestore();
      rateLimit.mockRestore();
    }
  });
});

// ── popup（プロジェクト作成・選択） ───────────────────────────────────────

describe('harness contract > popup', () => {
  function buildPopupDoc(): Document {
    const doc = document.implementation.createHTMLDocument('harness-contract-popup');
    doc.body.innerHTML = loadHtmlBody('src/popup/popup.html');
    return doc;
  }

  function buildPopupDeps(authed: boolean): PopupDeps {
    return {
      openAppTab: jest.fn(),
      openOptions: jest.fn(),
      runtime: {
        google: { fetch: jest.fn() as unknown as typeof fetch, getAccessToken: async () => 'token' },
        profile: { getProfileUserInfo: async () => ({ email: 'demo@example.com', id: 'demo' }) },
        store: { read: async () => undefined, write: async () => undefined },
      },
      isAuthenticated: async () => authed,
      signIn: async () => true,
      signOut: async () => undefined,
      requestPickerGrant: async () => ({ status: 'cancelled' }),
    };
  }

  contractTest('popup.auth-gate', async () => {
    const unauthedDoc = buildPopupDoc();
    await startPopup(unauthedDoc, buildPopupDeps(false));
    expect((unauthedDoc.getElementById('popup-auth') as HTMLElement).hidden).toBe(false);
    expect((unauthedDoc.getElementById('popup-projects') as HTMLElement).hidden).toBe(true);
    expect(unauthedDoc.getElementById('login-button')).not.toBeNull();

    const authedDoc = buildPopupDoc();
    await startPopup(authedDoc, buildPopupDeps(true));
    expect((authedDoc.getElementById('popup-auth') as HTMLElement).hidden).toBe(true);
    expect((authedDoc.getElementById('popup-projects') as HTMLElement).hidden).toBe(false);
    expect(authedDoc.getElementById('popup-create-title')).not.toBeNull();
    const email = authedDoc.getElementById('popup-email');
    expect(email).not.toBeNull();
    expect(email!.textContent).toContain('@');
    expect(email!.closest('[hidden]')).toBeNull();
    const submit = authedDoc.querySelector<HTMLButtonElement>(
      '#popup-create-form button[type="submit"]'
    );
    expect(submit).not.toBeNull();
    expect(submit!.closest('[hidden]')).toBeNull();
    expect(submit!.matches(':disabled')).toBe(false);
  });
});

// ── options（Chrome 拡張の options_ui 本体。#/settings とは別入口） ─────────

describe('harness contract > options', () => {
  function buildOptionsDoc(): Document {
    const doc = document.implementation.createHTMLDocument('harness-contract-options');
    doc.body.innerHTML = loadHtmlBody('src/options/options.html');
    return doc;
  }

  function buildOptionsDeps(): OptionsDeps {
    const data: Record<string, string> = {};
    return {
      readKey: async (key) => data[key],
      writeKey: async (key, value) => {
        data[key] = value;
      },
      removeKey: async (key) => {
        delete data[key];
      },
      openAppTab: jest.fn(),
    };
  }

  async function flush(times = 5): Promise<void> {
    for (let i = 0; i < times; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  contractTest('options.provider-cards-and-save-status', async () => {
    const doc = buildOptionsDoc();
    const deps = buildOptionsDeps();
    await startOptions(doc, deps);
    expect(doc.getElementById('gemini-card')).not.toBeNull();
    expect(doc.getElementById('openrouter-card')).not.toBeNull();
    const select = doc.getElementById('llm-model-select') as HTMLSelectElement;
    expect(select.options.length).toBeGreaterThanOrEqual(1);
    expect(select.value).not.toBe('');

    (doc.getElementById('save-keys') as HTMLButtonElement).click();
    await flush();
    expect(doc.getElementById('options-status')?.textContent).toContain('保存しました');
  });
});

// ── #/settings（アプリ内設定。popup の「設定を開く」がここへ飛ぶ） ──────────

describe('harness contract > #/settings', () => {
  function buildSettingsDeps(): SettingsViewCallbacks {
    const data: Record<string, string> = {};
    return {
      readKey: async (key) => data[key],
      writeKey: async (key, value) => {
        data[key] = value;
      },
      removeKey: async (key) => {
        delete data[key];
      },
    };
  }

  function buildCtx(): ViewContext {
    return { state: {} as AppState, navigate: jest.fn() };
  }

  async function flush(times = 5): Promise<void> {
    for (let i = 0; i < times; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  afterEach(() => {
    document.body.innerHTML = '';
  });

  contractTest('settings.provider-cards-ids-and-custom-model', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    createSettingsView(buildSettingsDeps())(container, buildCtx());
    await flush();

    for (const id of [
      'settings-gemini-card',
      'settings-gemini-key',
      'settings-gemini-tier-badge',
      'settings-openrouter-card',
      'settings-llm-model',
      'settings-ncbi-key',
      'settings-save',
      'settings-custom-model-id',
      'settings-custom-models-list',
    ]) {
      expect(document.getElementById(id)).not.toBeNull();
    }
    // 消費側と同じ class ベースのセレクタで追加ボタンを操作する。
    const addBtn = container.querySelector<HTMLButtonElement>('.settings__custom-model-form button');
    expect(addBtn).not.toBeNull();

    (document.getElementById('settings-custom-model-id') as HTMLInputElement).value =
      'meta-llama/llama-3.3-70b';
    addBtn!.click();
    await flush();
    expect(
      container.querySelectorAll('#settings-custom-models-list .settings__custom-model-item')
    ).toHaveLength(1);
  });
});

// ── home（プロジェクト未選択時のサイドナビ。00-smoke.mjs・01-intro.mjs が依存） ─

describe('harness contract > home', () => {
  function buildAppDoc(): Document {
    const doc = document.implementation.createHTMLDocument('harness-contract-home');
    doc.body.innerHTML = loadHtmlBody('src/app/app.html');
    return doc;
  }

  contractTest('home.sidebar-nav-always-renders', () => {
    const doc = buildAppDoc();
    const handle = startApp(doc, {
      getHash: () => '#/home',
      onHashChange: jest.fn().mockReturnValue(() => undefined),
      setHash: jest.fn(),
      runtime: null,
    });
    try {
      const buttons = doc.querySelectorAll('#app-sidebar .app__nav-list button');
      expect(buttons.length).toBeGreaterThan(0);
      const disabled = doc.querySelectorAll('#app-sidebar .app__nav-list button.is-disabled');
      expect(disabled.length).toBeGreaterThan(0);
      for (const button of buttons) {
        expect(button.closest('[hidden]')).toBeNull();
      }
    } finally {
      handle.dispose();
    }
  });
});

// ── 宣言とテストの対応（coverage） ────────────────────────────────────────

describe('harness contract > 宣言とテストの対応（coverage）', () => {
  test('verified:true の項目はすべて実際に test() で検証されている', () => {
    const missing = HARNESS_CONTRACT.filter((entry) => entry.verified && !verifiedRan.has(entry.id)).map(
      (entry) => entry.id
    );
    expect(missing).toEqual([]);
  });

  test('verified:false の項目には unverifiedReason が書かれている（黙って落とさない）', () => {
    const missing = HARNESS_CONTRACT.filter(
      (entry) => !entry.verified && !entry.unverifiedReason
    ).map((entry) => entry.id);
    expect(missing).toEqual([]);
  });

  test('宣言はすべて 1 件以上の consumer（依存元ファイル）を持つ', () => {
    const empty = HARNESS_CONTRACT.filter((entry) => entry.consumers.length === 0).map(
      (entry) => entry.id
    );
    expect(empty).toEqual([]);
  });

  test('id は重複しない', () => {
    const ids = HARNESS_CONTRACT.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
