/**
 * tests/harness-contract/contract.ts に宣言した契約を、実際に描画して検証する（issue #183）。
 *
 * 「セレクタが存在するか」ではなく「どの状態で・何が・どの順で描画されるか」という
 * 条件つきの構造を検証する。#177 / #180 で壊れたのはまさにこの契約（存在ではなく順序・
 * 排他性）だったため、単なる存在チェックは書かない（詳細は contract.ts のヘッダコメント）。
 *
 * `contractTest()` は宣言（HARNESS_CONTRACT）と実行を紐づけるための薄いラッパーで、
 * 末尾の「宣言とテストの対応（coverage）」が、verified: true の項目すべてに対応する
 * test() が実際に走ったことを機械的に確認する。
 */

import { createDraftView } from '@/app/views/draftView';
import { INITIAL_STATE, type AppState, type BlocksDraft } from '@/app/store';
import type { ValidationSummary } from '@/app/services';
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
    ...extra,
  };
}

const EXISTING_MD = '## PubMed/MEDLINE\n\n```\n#1 x\n```\n';

function minimalValidationSummary(): ValidationSummary {
  return {
    lineHits: [],
    finalQuery: { finalQuery: '(x)', totalHits: 10, captureRate: 1, capturedPmids: [], missedPmids: [] },
    finalQueryError: null,
    mesh: [],
    meshFrequency: [],
    meshError: null,
    meshHierarchy: [],
    meshMermaid: '',
    meshHierarchyError: null,
    eligibleSeedCount: 0,
    totalSeedCount: 0,
    loggedValidationIds: [],
  };
}

describe('harness contract > #/draft', () => {
  contractTest('draft.no-formula.single-primary-action', () => {
    const container = buildContainer();
    createDraftView()(container, { state: draftState(), navigate: jest.fn() });
    expect(container.querySelector('.optimization__start')).not.toBeNull();
    expect(container.querySelector('.draft__actions')).toBeNull();
    expect(container.querySelector('.draft__revalidate')).toBeNull();
    expect(container.querySelector('.draft__generate')).toBeNull();
  });

  contractTest('draft.formula-exists.secondary-actions-order', () => {
    const container = buildContainer();
    createDraftView()(container, {
      state: draftState({
        currentFormulaMarkdown: EXISTING_MD,
        currentFormulaVersionId: 'v-1',
        currentFormulaCreatedBy: 'ai_draft',
      }),
      navigate: jest.fn(),
    });
    const actions = container.querySelector('.draft__actions--secondary');
    expect(actions).not.toBeNull();
    const childClasses = Array.from(actions!.children).map((el) => el.className);
    const labelIndex = childClasses.indexOf('draft__actions-label');
    expect(labelIndex).toBeGreaterThanOrEqual(0);
    // ラベルの直後が .draft__revalidate、その次が .draft__generate（この順序に
    // tools/selenium/manualCheck.mjs と video/scenes/07-draft.mjs が別々に依存している）
    expect(childClasses[labelIndex + 1]).toBe('draft__revalidate');
    expect(childClasses[labelIndex + 2]).toBe('draft__generate');
  });

  contractTest('draft.block-hits.generation-only', () => {
    const base: Partial<AppState> = {
      currentFormulaMarkdown: EXISTING_MD,
      currentFormulaVersionId: 'v-1',
      currentFormulaCreatedBy: 'ai_draft',
    };

    // 1) 検証済み・実行前: 出ない
    const beforeContainer = buildContainer();
    createDraftView()(beforeContainer, { state: draftState(base), navigate: jest.fn() });
    expect(beforeContainer.querySelector('.draft__block-hits')).toBeNull();

    // 2) 生成中: 出る
    const runningContainer = buildContainer();
    createDraftView()(runningContainer, {
      state: draftState({
        ...base,
        draftRun: {
          status: 'running',
          phase: 'generating',
          progressLabel: 'MeSH を提案中',
          startedAtMs: Date.now(),
          error: null,
          removedMeshHeadings: [],
          replacedMeshHeadings: [],
          blockHits: [],
        },
      }),
      navigate: jest.fn(),
    });
    expect(runningContainer.querySelector('.draft__block-hits')).not.toBeNull();

    // 3) 検証完了後（draftRun は null に戻り、validationResult が入る）: 残らない
    const afterContainer = buildContainer();
    createDraftView()(afterContainer, {
      state: draftState({
        ...base,
        draftRun: null,
        validationResult: { formulaVersionId: 'v-1', summary: minimalValidationSummary() },
      }),
      navigate: jest.fn(),
    });
    expect(afterContainer.querySelector('.draft__block-hits')).toBeNull();
    // 検証結果自体は出ている（「検証は終わっている」状態であることの確認。単に
    // 未実行なだけで block-hits が無いのではないことを区別する）
    expect(afterContainer.querySelector('.draft__validate-status')).not.toBeNull();
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
    expect(select.options.length).toBeGreaterThanOrEqual(4);

    (doc.getElementById('save-keys') as HTMLButtonElement).click();
    await flush();
    expect(doc.getElementById('options-status')?.textContent).toBe('保存しました。');
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
    // 13-history.mjs の注記どおり、追加ボタンは id を持たず class でのみ取れる
    expect(document.getElementById('settings-add-custom-model')).toBeNull();
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
