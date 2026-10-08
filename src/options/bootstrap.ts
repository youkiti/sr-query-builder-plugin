/**
 * Options 画面の起動ロジック。
 *
 * - Gemini API キー（LLM プロバイダ）
 * - OpenRouter API キー（OSS / 多プロバイダモデル用）
 * - Anthropic API キー（Claude 用）
 * - 使用モデルの選択（ビルトイン + ユーザー追加のカスタムモデル）
 * - NCBI API キー（E-utilities の 3→10 req/s 引き上げ用、任意）
 *
 * をそれぞれ chrome.storage.local に保存する。API キーと NCBI キーは 1 つの
 * 「保存」ボタンでまとめて書き込み、UI 上はステータス文字列にまとめて結果を出す。
 * 使用モデルの選択とカスタムモデルの追加/削除は即時保存する。
 *
 * 保存時に Gemini API キーが設定されている場合、プラン（無料/有料）を自動判定し、
 * 無料プランが検出されたときはモデルを gemini-2.0-flash に自動切り替えする。
 * 保存済みキーがあるのにプラン未判定（ティア判定機能の導入前に保存した等）の場合は、
 * ページ読み込み時にも自動判定してバッジへ反映する。
 */

import {
  BUILTIN_MODELS as BUILTIN_MODELS_DISPLAY,
  DEFAULT_MODEL as DEFAULT_MODEL_ID,
  MAX_CUSTOM_MODELS as MAX_CUSTOM_MODELS_LIMIT,
  resolveProviderId,
  resolveEffectiveModel,
  type CustomModel as CustomModelEntry,
} from '@/lib/llm/modelRegistry';
import { detectGeminiTier, FREE_TIER_MODEL_ID } from '@/lib/llm/geminiTierDetector';

// webpack DefinePlugin が注入するビルド日付（YYYY-MM-DD）
declare const __BUILD_DATE__: string;

export interface OptionsDeps {
  /** chrome.storage.local から既存値を読み取る */
  readKey: (key: string) => Promise<string | undefined>;
  /** chrome.storage.local へ書き込む */
  writeKey: (key: string, value: string) => Promise<void>;
  /** chrome.storage.local からキーを削除する（pending フラグのクリア用） */
  removeKey: (key: string) => Promise<void>;
  /** メインビュー（app.html）を新規タブで開く。pending フラグが立っているときのみ呼ばれる */
  openAppTab: () => void;
  /**
   * Gemini API キーのプランを確認する。
   * 省略時はプラン確認をスキップする（テスト用途）。
   */
  detectGeminiTier?: (apiKey: string) => Promise<'paid' | 'free' | 'unknown' | 'unavailable'>;
}

export const STORAGE_KEY_GEMINI = 'apiKeys.gemini';
export const STORAGE_KEY_OPENROUTER = 'apiKeys.openrouter';
export const STORAGE_KEY_ANTHROPIC = 'apiKeys.anthropic';
export const STORAGE_KEY_LLM_MODEL = 'llm.selectedModel';
export const STORAGE_KEY_CUSTOM_MODELS = 'llm.customModels';
export const STORAGE_KEY_NCBI = 'apiKeys.ncbi';
/** Popup で API キー未設定を検知したときに立てるフラグ。保存成功で畳む。 */
export const STORAGE_KEY_PENDING_APP_TAB = 'pendingOpenAppTab';
/** 最後に検出した Gemini プラン（'paid' | 'free'）。ページリロード後もバッジ復元に使う */
export const STORAGE_KEY_GEMINI_TIER = 'gemini.detectedTier';

function populateModelSelect(
  selectEl: HTMLSelectElement,
  customModels: CustomModelEntry[],
  selectedModelId: string
): void {
  selectEl.innerHTML = '';
  // Gemini optgroup（ビルトイン + カスタム Gemini）
  const geminiGroup = document.createElement('optgroup');
  geminiGroup.label = 'Gemini';
  BUILTIN_MODELS_DISPLAY.filter((m) => m.provider === 'gemini').forEach((m) => {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.label;
    if (m.id === selectedModelId) opt.selected = true;
    geminiGroup.appendChild(opt);
  });
  customModels.filter((m) => resolveProviderId(m.id) === 'gemini').forEach((m) => {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.label ? m.label + ' (' + m.id + ')' : m.id;
    if (m.id === selectedModelId) opt.selected = true;
    geminiGroup.appendChild(opt);
  });
  selectEl.appendChild(geminiGroup);
  // OpenRouter optgroup（ビルトイン + カスタム OpenRouter）
  const orGroup = document.createElement('optgroup');
  orGroup.label = 'OpenRouter';
  BUILTIN_MODELS_DISPLAY.filter((m) => m.provider === 'openrouter').forEach((m) => {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.label;
    if (m.id === selectedModelId) opt.selected = true;
    orGroup.appendChild(opt);
  });
  customModels.filter((m) => resolveProviderId(m.id) === 'openrouter').forEach((m) => {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.label ? m.label + ' (' + m.id + ')' : m.id;
    if (m.id === selectedModelId) opt.selected = true;
    orGroup.appendChild(opt);
  });
  selectEl.appendChild(orGroup);
  // Anthropic optgroup（ビルトイン + カスタム Anthropic）
  const anthropicGroup = document.createElement('optgroup');
  anthropicGroup.label = 'Anthropic';
  BUILTIN_MODELS_DISPLAY.filter((m) => m.provider === 'anthropic').forEach((m) => {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.label;
    if (m.id === selectedModelId) opt.selected = true;
    anthropicGroup.appendChild(opt);
  });
  customModels.filter((m) => resolveProviderId(m.id) === 'anthropic').forEach((m) => {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.label ? m.label + ' (' + m.id + ')' : m.id;
    if (m.id === selectedModelId) opt.selected = true;
    anthropicGroup.appendChild(opt);
  });
  selectEl.appendChild(anthropicGroup);
}

function refreshProviderCards(doc: Document, selectedModelId: string): void {
  const provider = resolveProviderId(selectedModelId);
  doc
    .getElementById('gemini-card')
    ?.classList.toggle('options__provider-card--active', provider === 'gemini');
  doc
    .getElementById('openrouter-card')
    ?.classList.toggle('options__provider-card--active', provider === 'openrouter');
  doc
    .getElementById('anthropic-card')
    ?.classList.toggle('options__provider-card--active', provider === 'anthropic');
}

function updateTierBadge(
  doc: Document,
  state: 'checking' | 'paid' | 'free' | 'unknown' | 'unavailable'
): void {
  const badge = doc.getElementById('gemini-tier-badge');
  if (!badge) return;
  badge.className = 'options__tier-badge';
  switch (state) {
    case 'checking':
      badge.classList.add('options__tier-badge--checking');
      badge.textContent = '確認中...';
      break;
    case 'paid':
      badge.classList.add('options__tier-badge--paid');
      badge.textContent = '有料プラン';
      break;
    case 'free':
      badge.classList.add('options__tier-badge--free');
      badge.textContent = '無料プラン';
      break;
    default:
      badge.textContent = '';
  }
}

function renderCustomModelsList(
  listEl: HTMLElement,
  customModels: CustomModelEntry[],
  onRemove: (id: string) => void
): void {
  listEl.innerHTML = '';
  customModels.forEach((m) => {
    const item = listEl.ownerDocument.createElement('div');
    item.className = 'options__custom-model-item';
    const span = listEl.ownerDocument.createElement('span');
    span.textContent = m.label ? m.label + ' (' + m.id + ')' : m.id;
    const btn = listEl.ownerDocument.createElement('button');
    btn.type = 'button';
    btn.textContent = '削除';
    btn.addEventListener('click', () => onRemove(m.id));
    item.appendChild(span);
    item.appendChild(btn);
    listEl.appendChild(item);
  });
}

function parseCustomModels(raw: string | undefined): CustomModelEntry[] {
  if (!raw) return [];
  try {
    return JSON.parse(raw) as CustomModelEntry[];
  } catch {
    return [];
  }
}

function buildInitialStatus(
  gemini: string | undefined,
  openrouter: string | undefined,
  ncbi: string | undefined,
  anthropic: string | undefined
): string {
  const parts: string[] = [];
  parts.push(gemini ? 'Gemini: 保存済み' : 'Gemini: 未設定');
  parts.push(openrouter ? 'OpenRouter: 保存済み' : 'OpenRouter: 未設定');
  parts.push(anthropic ? 'Anthropic: 保存済み' : 'Anthropic: 未設定');
  parts.push(ncbi ? 'NCBI: 保存済み' : 'NCBI: 未設定（3 req/s 枠）');
  return parts.join(' / ');
}

export function createChromeOptionsDeps(): OptionsDeps {
  return {
    readKey: async (key) => {
      const result = await chrome.storage.local.get(key);
      const value = result[key];
      return typeof value === 'string' ? value : undefined;
    },
    writeKey: async (key, value) => {
      await chrome.storage.local.set({ [key]: value });
    },
    removeKey: async (key) => {
      await chrome.storage.local.remove(key);
    },
    openAppTab: () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('app/app.html') });
    },
    detectGeminiTier: (apiKey) => detectGeminiTier(apiKey),
  };
}

export async function startOptions(doc: Document, deps: OptionsDeps): Promise<void> {
  const buildDateEl = doc.getElementById('options-build-date');
  if (buildDateEl) {
    buildDateEl.textContent = `build: ${__BUILD_DATE__}`;
  }
  const status = doc.getElementById('options-status');
  const geminiInput = doc.getElementById('gemini-api-key') as HTMLInputElement | null;
  const openrouterInput = doc.getElementById('openrouter-api-key') as HTMLInputElement | null;
  const anthropicInput = doc.getElementById('anthropic-api-key') as HTMLInputElement | null;
  const ncbiInput = doc.getElementById('ncbi-api-key') as HTMLInputElement | null;
  const selectEl = doc.getElementById('llm-model-select') as HTMLSelectElement | null;
  const customModelIdInput = doc.getElementById('custom-model-id') as HTMLInputElement | null;
  const customModelLabelInput = doc.getElementById('custom-model-label') as HTMLInputElement | null;
  const addCustomModelBtn = doc.getElementById('add-custom-model');
  const customModelsListEl = doc.getElementById('custom-models-list');
  const saveBtn = doc.getElementById('save-keys');

  const existingGemini = await deps.readKey(STORAGE_KEY_GEMINI);
  const existingOpenRouter = await deps.readKey(STORAGE_KEY_OPENROUTER);
  const existingAnthropic = await deps.readKey(STORAGE_KEY_ANTHROPIC);
  const existingNcbi = await deps.readKey(STORAGE_KEY_NCBI);
  const existingModel = resolveEffectiveModel(await deps.readKey(STORAGE_KEY_LLM_MODEL), {
    anthropic: existingAnthropic,
    gemini: existingGemini,
  });
  const customModels = parseCustomModels(await deps.readKey(STORAGE_KEY_CUSTOM_MODELS));
  const savedTier = await deps.readKey(STORAGE_KEY_GEMINI_TIER);

  if (geminiInput && existingGemini !== undefined) {
    geminiInput.value = existingGemini;
  }
  if (openrouterInput && existingOpenRouter !== undefined) {
    openrouterInput.value = existingOpenRouter;
  }
  if (anthropicInput && existingAnthropic !== undefined) {
    anthropicInput.value = existingAnthropic;
  }
  if (ncbiInput && existingNcbi !== undefined) {
    ncbiInput.value = existingNcbi;
  }

  if (selectEl) {
    populateModelSelect(selectEl, customModels, existingModel);
  }
  refreshProviderCards(doc, existingModel);

  // 前回保存済みの tier をバッジに復元（ページリロード後も表示を維持するため）
  if (savedTier === 'paid' || savedTier === 'free') {
    updateTierBadge(doc, savedTier);
  } else if (deps.detectGeminiTier && existingGemini !== undefined && existingGemini.trim() !== '') {
    // キーは保存済みなのに tier 未判定（ティア判定機能の導入前に保存した等）
    // → 読み込み時に自動判定する。ネットワーク待ちで UI を塞がないよう非同期で流す
    const detect = deps.detectGeminiTier;
    updateTierBadge(doc, 'checking');
    void (async () => {
      let tier: 'paid' | 'free' | 'unknown' | 'unavailable';
      try {
        tier = await detect(existingGemini);
      } catch {
        tier = 'unknown';
      }
      updateTierBadge(doc, tier);
      if (tier === 'paid' || tier === 'free') {
        await deps.writeKey(STORAGE_KEY_GEMINI_TIER, tier);
      }
    })();
  }

  function handleRemoveCustomModel(id: string): void {
    void (async () => {
      const raw = await deps.readKey(STORAGE_KEY_CUSTOM_MODELS);
      const models = parseCustomModels(raw).filter((m) => m.id !== id);
      await deps.writeKey(STORAGE_KEY_CUSTOM_MODELS, JSON.stringify(models));
      const currentModel = selectEl?.value ?? DEFAULT_MODEL_ID;
      if (selectEl) {
        populateModelSelect(selectEl, models, currentModel);
      }
      if (customModelsListEl) {
        renderCustomModelsList(customModelsListEl, models, handleRemoveCustomModel);
      }
      if (status) {
        status.textContent = 'カスタムモデルを削除しました。';
      }
    })();
  }

  if (customModelsListEl) {
    renderCustomModelsList(customModelsListEl, customModels, handleRemoveCustomModel);
  }

  if (status) {
    status.textContent = buildInitialStatus(existingGemini, existingOpenRouter, existingNcbi, existingAnthropic);
  }

  selectEl?.addEventListener('change', () => {
    const selectedModel = selectEl.value;
    void deps.writeKey(STORAGE_KEY_LLM_MODEL, selectedModel);
    refreshProviderCards(doc, selectedModel);
  });

  addCustomModelBtn?.addEventListener('click', async () => {
    const id = customModelIdInput?.value.trim() ?? '';
    const label = customModelLabelInput?.value.trim();
    if (!id) {
      if (status) status.textContent = 'モデルIDを入力してください。';
      return;
    }
    const raw = await deps.readKey(STORAGE_KEY_CUSTOM_MODELS);
    const models = parseCustomModels(raw);
    if (models.length >= MAX_CUSTOM_MODELS_LIMIT) {
      if (status) status.textContent = 'カスタムモデルの上限（20件）に達しています。';
      return;
    }
    if (models.some((m) => m.id === id)) {
      if (status) status.textContent = 'そのモデルIDはすでに登録されています。';
      return;
    }
    const newEntry: CustomModelEntry = label ? { id, label } : { id };
    models.push(newEntry);
    await deps.writeKey(STORAGE_KEY_CUSTOM_MODELS, JSON.stringify(models));
    if (customModelIdInput) customModelIdInput.value = '';
    if (customModelLabelInput) customModelLabelInput.value = '';
    const currentModel = selectEl?.value ?? DEFAULT_MODEL_ID;
    if (selectEl) {
      populateModelSelect(selectEl, models, currentModel);
    }
    if (customModelsListEl) {
      renderCustomModelsList(customModelsListEl, models, handleRemoveCustomModel);
    }
    if (status) status.textContent = 'カスタムモデルを追加しました。';
  });

  saveBtn?.addEventListener('click', () => {
    const geminiVal = geminiInput?.value ?? '';
    const openrouterVal = openrouterInput?.value ?? '';
    const anthropicVal = anthropicInput?.value ?? '';
    const ncbiVal = ncbiInput?.value ?? '';
    let selectedModel = selectEl?.value ?? DEFAULT_MODEL_ID;

    if (status) status.textContent = '保存中...';

    void (async () => {
      try {
        const savedModel = await deps.readKey(STORAGE_KEY_LLM_MODEL);
        const shouldSaveModel = !!savedModel || !!anthropicVal.trim() || !!geminiVal.trim();
        if (!savedModel && shouldSaveModel) {
          selectedModel = resolveEffectiveModel(undefined, { anthropic: anthropicVal, gemini: geminiVal });
          if (selectEl) selectEl.value = selectedModel;
          refreshProviderCards(doc, selectedModel);
        }
        await Promise.all([
          deps.writeKey(STORAGE_KEY_GEMINI, geminiVal),
          deps.writeKey(STORAGE_KEY_OPENROUTER, openrouterVal),
          deps.writeKey(STORAGE_KEY_ANTHROPIC, anthropicVal),
          deps.writeKey(STORAGE_KEY_NCBI, ncbiVal),
          ...(shouldSaveModel ? [deps.writeKey(STORAGE_KEY_LLM_MODEL, selectedModel)] : []),
        ]);

        // Gemini キーが設定されており Gemini モデルが選択されている場合にプラン自動判定
        let modelSwitchedToFree = false;
        let tierUndetermined = false;
        let tierUnavailable = false;
        const provider = resolveProviderId(selectedModel);
        if (geminiVal.trim() === '') {
          // キーが空になったので保存済み tier をクリア
          await deps.removeKey(STORAGE_KEY_GEMINI_TIER);
          updateTierBadge(doc, 'unknown');
        }
        if (deps.detectGeminiTier && geminiVal.trim() !== '' && provider === 'gemini') {
          if (status) status.textContent = 'APIプランを確認中...';
          updateTierBadge(doc, 'checking');

          let tier: 'paid' | 'free' | 'unknown' | 'unavailable';
          try {
            tier = await deps.detectGeminiTier(geminiVal);
          } catch {
            tier = 'unknown';
          }

          if (tier === 'free') {
            updateTierBadge(doc, 'free');
            await deps.writeKey(STORAGE_KEY_GEMINI_TIER, 'free');
            if (selectEl && selectEl.value !== FREE_TIER_MODEL_ID) {
              selectEl.value = FREE_TIER_MODEL_ID;
              await deps.writeKey(STORAGE_KEY_LLM_MODEL, FREE_TIER_MODEL_ID);
              refreshProviderCards(doc, FREE_TIER_MODEL_ID);
              modelSwitchedToFree = true;
            }
          } else if (tier === 'paid') {
            updateTierBadge(doc, 'paid');
            await deps.writeKey(STORAGE_KEY_GEMINI_TIER, 'paid');
          } else if (tier === 'unavailable') {
            updateTierBadge(doc, 'unavailable');
            tierUnavailable = true;
          } else {
            updateTierBadge(doc, 'unknown');
            tierUndetermined = true;
          }
        }

        const pendingNow = await deps.readKey(STORAGE_KEY_PENDING_APP_TAB);
        const currentModel = selectEl?.value ?? DEFAULT_MODEL_ID;
        const currentProvider = resolveProviderId(currentModel);
        const keyForProvider = currentProvider === 'openrouter' ? openrouterVal
          : currentProvider === 'anthropic' ? anthropicVal : geminiVal;

        if (pendingNow === '1' && keyForProvider.trim() !== '') {
          await deps.removeKey(STORAGE_KEY_PENDING_APP_TAB);
          if (status) {
            status.textContent = '保存しました。トップ画面に戻ります…';
          }
          deps.openAppTab();
          return;
        }

        if (status) {
          if (modelSwitchedToFree) {
            status.textContent = '保存しました。無料プランを検出。Gemini 2.0 Flash に切り替えました。';
          } else if (tierUnavailable) {
            status.textContent =
              '保存しました。（Gemini が混雑中のためプランを判定できませんでした。時間をおいてこの画面を開くと自動で再判定されます）';
          } else if (tierUndetermined) {
            status.textContent =
              '保存しました。（Gemini プランを自動判定できませんでした。コンソールログを確認してください）';
          } else {
            status.textContent = '保存しました。';
          }
        }
      } catch (err) {
        if (status) {
          status.textContent = `保存に失敗しました: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    })();
  });
}
