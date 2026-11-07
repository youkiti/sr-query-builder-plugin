import { t } from '@/lib/i18n';
import { buildUiLanguageSection } from './uiLanguageSection';
import { ROUTE_LABELS } from '../router';
import { addLlmPermissionButtons, requestLlmHosts, type LlmHostPermissions } from '@/lib/llm/hostPermissions';
import { AiConsentDeclinedError } from '../services/aiConsentService';
import { updateGeminiDataNotice } from '@/lib/llm/aiDisclosure';
import {
  BUILTIN_MODELS,
  DEFAULT_MODEL,
  MODEL_BENCHMARK_URL,
  resolveEffectiveModel,
  MAX_CUSTOM_MODELS,
  resolveProviderId as resolveProvider,
  type CustomModel,
} from '@/lib/llm/modelRegistry';
import {
  detectGeminiTier as defaultDetectGeminiTier,
  FREE_TIER_MODEL_ID,
} from '@/lib/llm/geminiTierDetector';
import type { RenderView } from './types';

const KEY_GEMINI = 'apiKeys.gemini';
const KEY_OPENROUTER = 'apiKeys.openrouter';
const KEY_ANTHROPIC = 'apiKeys.anthropic';
const KEY_NCBI = 'apiKeys.ncbi';
const KEY_LLM_MODEL = 'llm.selectedModel';
const KEY_CUSTOM_MODELS = 'llm.customModels';
const KEY_PENDING = 'pendingOpenAppTab';
/** 最後に検出した Gemini プラン（'paid' | 'free'）。Options 画面と共有する */
const KEY_GEMINI_TIER = 'gemini.detectedTier';

export interface SettingsViewCallbacks {
  hostPermissions?: LlmHostPermissions;
  readKey: (key: string) => Promise<string | undefined>;
  writeKey: (key: string, value: string) => Promise<void>;
  removeKey: (key: string) => Promise<void>;
  /**
   * Gemini API キーのプラン（無料/有料）を確認する。
   * 省略時は本物の detectGeminiTier を使う（テストではモックを注入する）。
   */
  detectGeminiTier?: (apiKey: string) => Promise<'paid' | 'free' | 'unknown' | 'unavailable'>;
}

function parseCustomModels(raw: string | undefined): CustomModel[] {
  if (!raw) return [];
  try {
    return JSON.parse(raw) as CustomModel[];
  } catch {
    return [];
  }
}

function populateModelSelect(
  selectEl: HTMLSelectElement,
  customModels: CustomModel[],
  selectedModelId: string | undefined
): void {
  selectEl.innerHTML = '';
  const geminiGroup = selectEl.ownerDocument.createElement('optgroup');
  geminiGroup.label = 'Google AI Studio';
  BUILTIN_MODELS.filter((m) => m.provider === 'gemini').forEach((m) => {
    const opt = selectEl.ownerDocument.createElement('option');
    opt.value = m.id;
    opt.textContent = m.label;
    if (m.id === selectedModelId) opt.selected = true;
    geminiGroup.appendChild(opt);
  });
  customModels.filter((m) => resolveProvider(m.id) === 'gemini').forEach((m) => {
    const opt = selectEl.ownerDocument.createElement('option');
    opt.value = m.id;
    opt.textContent = m.label ? `${m.label} (${m.id})` : m.id;
    if (m.id === selectedModelId) opt.selected = true;
    geminiGroup.appendChild(opt);
  });
  selectEl.appendChild(geminiGroup);

  const orGroup = selectEl.ownerDocument.createElement('optgroup');
  orGroup.label = 'OpenRouter';
  BUILTIN_MODELS.filter((m) => m.provider === 'openrouter').forEach((m) => {
    const opt = selectEl.ownerDocument.createElement('option');
    opt.value = m.id;
    opt.textContent = m.label;
    if (m.id === selectedModelId) opt.selected = true;
    orGroup.appendChild(opt);
  });
  customModels.filter((m) => resolveProvider(m.id) === 'openrouter').forEach((m) => {
    const opt = selectEl.ownerDocument.createElement('option');
    opt.value = m.id;
    opt.textContent = m.label ? `${m.label} (${m.id})` : m.id;
    if (m.id === selectedModelId) opt.selected = true;
    orGroup.appendChild(opt);
  });
  selectEl.appendChild(orGroup);

  const anthropicGroup = selectEl.ownerDocument.createElement('optgroup');
  anthropicGroup.label = 'Anthropic';
  BUILTIN_MODELS.filter((m) => m.provider === 'anthropic').forEach((m) => {
    const opt = selectEl.ownerDocument.createElement('option');
    opt.value = m.id;
    opt.textContent = m.label;
    if (m.id === selectedModelId) opt.selected = true;
    anthropicGroup.appendChild(opt);
  });
  customModels.filter((m) => resolveProvider(m.id) === 'anthropic').forEach((m) => {
    const opt = selectEl.ownerDocument.createElement('option');
    opt.value = m.id;
    opt.textContent = m.label ? `${m.label} (${m.id})` : m.id;
    if (m.id === selectedModelId) opt.selected = true;
    anthropicGroup.appendChild(opt);
  });
  selectEl.appendChild(anthropicGroup);
  if (selectedModelId && !Array.from(selectEl.options).some((option) => option.value === selectedModelId)) {
    const option = selectEl.ownerDocument.createElement('option');
    option.value = selectedModelId;
    option.textContent = t('settings.unlistedModel', { id: selectedModelId });
    option.selected = true;
    selectEl.appendChild(option);
  }
}

function refreshProviderCards(doc: Document, selectedModelId: string): void {
  const provider = resolveProvider(selectedModelId);
  doc
    .getElementById('settings-gemini-card')
    ?.classList.toggle('settings__provider-card--active', provider === 'gemini');
  doc
    .getElementById('settings-openrouter-card')
    ?.classList.toggle('settings__provider-card--active', provider === 'openrouter');
  doc
    .getElementById('settings-anthropic-card')
    ?.classList.toggle('settings__provider-card--active', provider === 'anthropic');
}

function updateTierBadge(
  badge: HTMLElement,
  state: 'checking' | 'paid' | 'free' | 'unknown' | 'unavailable'
): void {
  updateGeminiDataNotice(badge, state === 'free');
  badge.className = 'settings__tier-badge';
  switch (state) {
    case 'checking':
      badge.classList.add('settings__tier-badge--checking');
      badge.textContent = t('settings.checking');
      break;
    case 'paid':
      badge.classList.add('settings__tier-badge--paid');
      badge.textContent = t('settings.paid');
      break;
    case 'free':
      badge.classList.add('settings__tier-badge--free');
      badge.textContent = t('settings.free');
      break;
    default:
      badge.textContent = '';
  }
}

function renderCustomModelsList(
  listEl: HTMLElement,
  customModels: CustomModel[],
  onRemove: (id: string) => void
): void {
  listEl.innerHTML = '';
  customModels.forEach((m) => {
    const item = listEl.ownerDocument.createElement('div');
    item.className = 'settings__custom-model-item';
    const span = listEl.ownerDocument.createElement('span');
    span.textContent = m.label ? `${m.label} (${m.id})` : m.id;
    const btn = listEl.ownerDocument.createElement('button');
    btn.type = 'button';
    btn.textContent = t('settings.remove');
    btn.addEventListener('click', () => onRemove(m.id));
    item.appendChild(span);
    item.appendChild(btn);
    listEl.appendChild(item);
  });
}

export function createSettingsView(callbacks: SettingsViewCallbacks): RenderView {
  const unsavedInputs = new Map<string, string>();
  return (container, ctx) => {
    container.innerHTML = '';
    const doc = container.ownerDocument;

    // ヘッダー行（タイトル + 戻るボタン）
    const header = doc.createElement('div');
    header.className = 'settings__header';
    const h2 = doc.createElement('h2');
    h2.textContent = ROUTE_LABELS.settings;
    h2.className = 'settings__title';
    const backBtn = doc.createElement('button');
    backBtn.type = 'button';
    backBtn.className = 'settings__back-btn';
    backBtn.textContent = t('settings.back');
    backBtn.addEventListener('click', () => ctx.navigate('home'));
    header.appendChild(h2);
    header.appendChild(backBtn);
    container.appendChild(header);

    // 強制遷移時のアラートバナー（非同期で表示）
    const banner = doc.createElement('div');
    banner.className = 'settings__alert';
    banner.setAttribute('role', 'alert');
    banner.hidden = true;
    container.appendChild(banner);

    // ステータス行
    const status = doc.createElement('p');
    status.className = 'settings__status';
    status.textContent = t('settings.loading');
    container.appendChild(status);

    container.appendChild(buildUiLanguageSection(doc));

    // LLM プロバイダセクション
    const llmSection = doc.createElement('section');
    llmSection.className = 'settings__section';
    const llmHeading = doc.createElement('h3');
    llmHeading.textContent = t('settings.providers');
    llmSection.appendChild(llmHeading);

    // Gemini カード
    const geminiCard = doc.createElement('div');
    geminiCard.className = 'settings__provider-card';
    geminiCard.id = 'settings-gemini-card';
    const geminiTitle = doc.createElement('h4');
    geminiTitle.className = 'settings__provider-title';
    const geminiTitleText = doc.createElement('span');
    geminiTitleText.textContent = 'Google AI Studio';
    const geminiLink = doc.createElement('a');
    geminiLink.href = 'https://aistudio.google.com/apikey';
    geminiLink.target = '_blank';
    geminiLink.rel = 'noreferrer';
    geminiLink.className = 'settings__provider-link';
    geminiLink.textContent = t('settings.getKey');
    const tierBadge = doc.createElement('span');
    tierBadge.id = 'settings-gemini-tier-badge';
    tierBadge.className = 'settings__tier-badge';
    tierBadge.setAttribute('aria-live', 'polite');
    geminiTitle.appendChild(geminiTitleText);
    geminiTitle.appendChild(geminiLink);
    geminiTitle.appendChild(tierBadge);
    geminiCard.appendChild(geminiTitle);
    const geminiLabel = doc.createElement('label');
    geminiLabel.className = 'settings__field';
    const geminiLabelText = doc.createElement('span');
    geminiLabelText.textContent = t('settings.apiKey');
    const geminiInput = doc.createElement('input');
    geminiInput.type = 'password';
    geminiInput.id = 'settings-gemini-key';
    geminiInput.autocomplete = 'off';
    geminiLabel.appendChild(geminiLabelText);
    geminiLabel.appendChild(geminiInput);
    geminiCard.appendChild(geminiLabel);
    const geminiMuted = doc.createElement('p');
    geminiMuted.className = 'settings__muted';
    geminiMuted.textContent =
      t('settings.geminiHint');
    geminiCard.appendChild(geminiMuted);
    llmSection.appendChild(geminiCard);

    // OpenRouter カード
    const orCard = doc.createElement('div');
    orCard.className = 'settings__provider-card';
    orCard.id = 'settings-openrouter-card';
    const orTitle = doc.createElement('h4');
    orTitle.className = 'settings__provider-title';
    const orTitleText = doc.createElement('span');
    orTitleText.textContent = 'OpenRouter';
    const orLink = doc.createElement('a');
    orLink.href = 'https://openrouter.ai/settings/keys';
    orLink.target = '_blank';
    orLink.rel = 'noreferrer';
    orLink.className = 'settings__provider-link';
    orLink.textContent = t('settings.getKey');
    orTitle.appendChild(orTitleText);
    orTitle.appendChild(orLink);
    orCard.appendChild(orTitle);
    const orMuted = doc.createElement('p');
    orMuted.className = 'settings__muted';
    orMuted.textContent = t('settings.openrouterHint');
    orCard.appendChild(orMuted);
    const orLabel = doc.createElement('label');
    orLabel.className = 'settings__field';
    const orLabelText = doc.createElement('span');
    orLabelText.textContent = t('settings.apiKey');
    const orInput = doc.createElement('input');
    orInput.type = 'password';
    orInput.id = 'settings-openrouter-key';
    orInput.autocomplete = 'off';
    orLabel.appendChild(orLabelText);
    orLabel.appendChild(orInput);
    orCard.appendChild(orLabel);

    // カスタムモデル追加フォーム
    const customForm = doc.createElement('div');
    customForm.className = 'settings__custom-model-form';
    const customHeading = doc.createElement('h5');
    customHeading.textContent = t('settings.customHeading');
    const customMuted = doc.createElement('p');
    customMuted.className = 'settings__muted';
    customMuted.textContent = t('settings.customHint');
    const customFieldRow = doc.createElement('div');
    customFieldRow.className = 'settings__field-row';
    const customIdLabel = doc.createElement('label');
    customIdLabel.className = 'settings__field';
    const customIdLabelText = doc.createElement('span');
    customIdLabelText.textContent = t('settings.modelId');
    const customModelIdInput = doc.createElement('input');
    customModelIdInput.type = 'text';
    customModelIdInput.id = 'settings-custom-model-id';
    customModelIdInput.placeholder = 'provider/model-name';
    customModelIdInput.autocomplete = 'off';
    customIdLabel.appendChild(customIdLabelText);
    customIdLabel.appendChild(customModelIdInput);
    const customLabelLabel = doc.createElement('label');
    customLabelLabel.className = 'settings__field';
    const customLabelLabelText = doc.createElement('span');
    customLabelLabelText.textContent = t('settings.modelLabel');
    const customModelLabelInput = doc.createElement('input');
    customModelLabelInput.type = 'text';
    customModelLabelInput.id = 'settings-custom-model-label';
    customModelLabelInput.placeholder = 'My Model';
    customModelLabelInput.autocomplete = 'off';
    customLabelLabel.appendChild(customLabelLabelText);
    customLabelLabel.appendChild(customModelLabelInput);
    customFieldRow.appendChild(customIdLabel);
    customFieldRow.appendChild(customLabelLabel);
    const addCustomModelBtn = doc.createElement('button');
    addCustomModelBtn.type = 'button';
    addCustomModelBtn.className = 'settings__btn';
    addCustomModelBtn.textContent = t('settings.add');
    const customModelsList = doc.createElement('div');
    customModelsList.id = 'settings-custom-models-list';
    customModelsList.className = 'settings__custom-models-list';
    customForm.appendChild(customHeading);
    customForm.appendChild(customMuted);
    customForm.appendChild(customFieldRow);
    customForm.appendChild(addCustomModelBtn);
    customForm.appendChild(customModelsList);
    orCard.appendChild(customForm);
    llmSection.appendChild(orCard);

    // Anthropic カード
    const anthropicCard = doc.createElement('div');
    anthropicCard.className = 'settings__provider-card';
    anthropicCard.id = 'settings-anthropic-card';
    const anthropicTitle = doc.createElement('h4');
    anthropicTitle.className = 'settings__provider-title';
    const anthropicTitleText = doc.createElement('span');
    anthropicTitleText.textContent = 'Anthropic';
    const anthropicLink = doc.createElement('a');
    anthropicLink.href = 'https://console.anthropic.com/settings/keys';
    anthropicLink.target = '_blank';
    anthropicLink.rel = 'noreferrer';
    anthropicLink.className = 'settings__provider-link';
    anthropicLink.textContent = t('settings.getKey');
    anthropicTitle.appendChild(anthropicTitleText);
    anthropicTitle.appendChild(anthropicLink);
    anthropicCard.appendChild(anthropicTitle);
    const anthropicMuted = doc.createElement('p');
    anthropicMuted.className = 'settings__muted';
    anthropicMuted.textContent = t('settings.anthropicHint');
    anthropicCard.appendChild(anthropicMuted);
    const anthropicLabel = doc.createElement('label');
    anthropicLabel.className = 'settings__field';
    const anthropicLabelText = doc.createElement('span');
    anthropicLabelText.textContent = t('settings.apiKey');
    const anthropicInput = doc.createElement('input');
    anthropicInput.type = 'password';
    anthropicInput.id = 'settings-anthropic-key';
    anthropicInput.autocomplete = 'off';
    anthropicLabel.appendChild(anthropicLabelText);
    anthropicLabel.appendChild(anthropicInput);
    anthropicCard.appendChild(anthropicLabel);

    llmSection.appendChild(anthropicCard);

    // 使用モデル選択
    const modelLabel = doc.createElement('div');
    modelLabel.className = 'settings__field';
    const modelHead = doc.createElement('div');
    modelHead.className = 'settings__field-head';
    const modelLabelText = doc.createElement('label');
    modelLabelText.htmlFor = 'settings-llm-model';
    modelLabelText.textContent = t('settings.model');
    const modelSelect = doc.createElement('select');
    modelSelect.id = 'settings-llm-model';
    const modelHelp = doc.createElement('a');
    modelHelp.className = 'settings__help-link';
    modelHelp.href = MODEL_BENCHMARK_URL;
    modelHelp.target = '_blank';
    modelHelp.rel = 'noreferrer';
    modelHelp.title = t('settings.benchmark');
    modelHelp.setAttribute('aria-label', modelHelp.title);
    modelHelp.textContent = '?';
    modelHead.appendChild(modelLabelText);
    modelHead.appendChild(modelHelp);
    modelLabel.appendChild(modelHead);
    modelLabel.appendChild(modelSelect);
    llmSection.appendChild(modelLabel);
    container.appendChild(llmSection);

    // NCBI セクション
    const ncbiSection = doc.createElement('section');
    ncbiSection.className = 'settings__section';
    const ncbiHeading = doc.createElement('h3');
    ncbiHeading.textContent = 'NCBI E-utilities';
    const ncbiMuted = doc.createElement('p');
    ncbiMuted.className = 'settings__muted';
    ncbiMuted.innerHTML =
      t('settings.ncbiIntro') +
      ' <a href="https://www.ncbi.nlm.nih.gov/account/settings/" target="_blank" rel="noreferrer">' + t('settings.ncbiAccount') + '</a>' + t('settings.ncbiEnd');
    const ncbiLabel = doc.createElement('label');
    ncbiLabel.className = 'settings__field';
    const ncbiLabelText = doc.createElement('span');
    ncbiLabelText.textContent = t('settings.ncbiKey');
    const ncbiInput = doc.createElement('input');
    ncbiInput.type = 'password';
    ncbiInput.id = 'settings-ncbi-key';
    ncbiInput.autocomplete = 'off';
    ncbiLabel.appendChild(ncbiLabelText);
    ncbiLabel.appendChild(ncbiInput);
    ncbiSection.appendChild(ncbiHeading);
    ncbiSection.appendChild(ncbiMuted);
    ncbiSection.appendChild(ncbiLabel);
    container.appendChild(ncbiSection);

    // 保存ボタン
    const actions = doc.createElement('div');
    actions.className = 'settings__actions';
    const saveBtn = doc.createElement('button');
    saveBtn.type = 'button';
    saveBtn.id = 'settings-save';
    saveBtn.className = 'settings__btn settings__btn--primary';
    saveBtn.textContent = t('settings.save');
    actions.appendChild(saveBtn);
    container.appendChild(actions);

    const detectTier = callbacks.detectGeminiTier ?? defaultDetectGeminiTier;

    const textInputs = [geminiInput, orInput, anthropicInput, ncbiInput,
      customModelIdInput, customModelLabelInput];
    const savedInputs = new Map<string, string>();
    for (const input of textInputs) {
      input.addEventListener('input', () => {
        if (input.value === savedInputs.get(input.id)) unsavedInputs.delete(input.id);
        else unsavedInputs.set(input.id, input.value);
      });
    }

    function clearSavedInput(input: HTMLInputElement, value: string): void {
      savedInputs.set(input.id, value);
      // 保存中に新たに入力された値は保持する。
      if (unsavedInputs.get(input.id) === value) unsavedInputs.delete(input.id);
    }

    // ---- 非同期初期化 ----
    void (async () => {
      const [pending, gemini, openrouter, anthropic, ncbi, rawModel, rawCustom, savedTier] =
        await Promise.all([
          callbacks.readKey(KEY_PENDING),
          callbacks.readKey(KEY_GEMINI),
          callbacks.readKey(KEY_OPENROUTER),
          callbacks.readKey(KEY_ANTHROPIC),
          callbacks.readKey(KEY_NCBI),
          callbacks.readKey(KEY_LLM_MODEL),
          callbacks.readKey(KEY_CUSTOM_MODELS),
          callbacks.readKey(KEY_GEMINI_TIER),
        ]);

      if (pending === '1') {
        banner.textContent =
          t('settings.pending');
        banner.hidden = false;
      }

      if (gemini) geminiInput.value = gemini;
      if (openrouter) orInput.value = openrouter;
      if (anthropic) anthropicInput.value = anthropic;
      if (ncbi) ncbiInput.value = ncbi;

      // 保存値の非同期読み込み後に、未保存の入力を復元する。
      const savedValues = [gemini ?? '', openrouter ?? '', anthropic ?? '', ncbi ?? '', '', ''];
      for (const [index, input] of textInputs.entries()) {
        const savedValue = savedValues[index]!;
        savedInputs.set(input.id, savedValue);
        const draft = unsavedInputs.get(input.id);
        if (draft === savedValue) unsavedInputs.delete(input.id);
        else if (draft !== undefined) input.value = draft;
      }

      const selectedModel = resolveEffectiveModel(rawModel, { anthropic, gemini });
      const customModels = parseCustomModels(rawCustom);
      populateModelSelect(modelSelect, customModels, selectedModel);
      renderCustomModelsList(customModelsList, customModels, handleRemoveCustomModel);
      refreshProviderCards(doc, selectedModel);

      const parts: string[] = [];
      parts.push(gemini ? t('settings.geminiSaved') : t('settings.geminiUnset'));
      parts.push(openrouter ? t('settings.orSaved') : t('settings.orUnset'));
      parts.push(anthropic ? t('settings.anthropicSaved') : t('settings.anthropicUnset'));
      parts.push(ncbi ? t('settings.ncbiSaved') : t('settings.ncbiUnset'));
      status.textContent = parts.join(' / ');

      // 保存済み tier をバッジへ復元。未判定でキーがあれば読み込み時に自動判定する
      if (savedTier === 'paid' || savedTier === 'free') {
        updateTierBadge(tierBadge, savedTier);
      } else if (gemini && gemini.trim() !== '') {
        updateTierBadge(tierBadge, 'checking');
        let tier: 'paid' | 'free' | 'unknown' | 'unavailable';
        try {
          tier = await detectTier(gemini);
        } catch (err) {
          if (err instanceof AiConsentDeclinedError) {
            updateTierBadge(tierBadge, 'unknown');
            status.textContent = err.message;
            return;
          }
          tier = 'unknown';
        }
        updateTierBadge(tierBadge, tier);
        if (tier === 'paid' || tier === 'free') {
          await callbacks.writeKey(KEY_GEMINI_TIER, tier);
        }
      }
    })();

    function handleRemoveCustomModel(id: string): void {
      void (async () => {
        const raw = await callbacks.readKey(KEY_CUSTOM_MODELS);
        const models = parseCustomModels(raw).filter((m) => m.id !== id);
        await callbacks.writeKey(KEY_CUSTOM_MODELS, JSON.stringify(models));
        const currentModel = modelSelect.value ?? DEFAULT_MODEL;
        populateModelSelect(modelSelect, models, currentModel);
        renderCustomModelsList(customModelsList, models, handleRemoveCustomModel);
        status.textContent = t('settings.removed');
      })();
    }

    modelSelect.addEventListener('change', () => {
      const selectedModel = modelSelect.value;
      const hostPermission = requestLlmHosts([resolveProvider(selectedModel)], callbacks.hostPermissions);
      void callbacks.writeKey(KEY_LLM_MODEL, selectedModel);
      refreshProviderCards(doc, selectedModel);
      void hostPermission.then((allowed) => {
        if (!allowed) status.textContent = t('settings.permissionDenied');
      });
    });

    addCustomModelBtn.addEventListener('click', () => {
      void (async () => {
        const id = customModelIdInput.value.trim();
        const label = customModelLabelInput.value.trim();
        if (!id.includes('/') && !id.startsWith('claude-')) {
          status.textContent = t('settings.invalidId');
          return;
        }
        const raw = await callbacks.readKey(KEY_CUSTOM_MODELS);
        const models = parseCustomModels(raw);
        if (models.length >= MAX_CUSTOM_MODELS) {
          status.textContent = t('settings.limit');
          return;
        }
        if (models.some((m) => m.id === id)) {
          status.textContent = t('settings.duplicate');
          return;
        }
        const newEntry: CustomModel = label ? { id, label } : { id };
        models.push(newEntry);
        await callbacks.writeKey(KEY_CUSTOM_MODELS, JSON.stringify(models));
        customModelIdInput.value = '';
        customModelLabelInput.value = '';
        unsavedInputs.delete(customModelIdInput.id);
        unsavedInputs.delete(customModelLabelInput.id);
        populateModelSelect(modelSelect, models, modelSelect.value ?? DEFAULT_MODEL);
        renderCustomModelsList(customModelsList, models, handleRemoveCustomModel);
        status.textContent = t('settings.added');
      })();
    });

    if (saveBtn?.parentElement) addLlmPermissionButtons(saveBtn.parentElement, callbacks.hostPermissions, 'settings__btn');
    saveBtn.addEventListener('click', () => {
      const hostPermission = requestLlmHosts([
        ...((orInput.value ?? '').trim() ? ['openrouter' as const] : []),
        ...((anthropicInput.value ?? '').trim() ? ['anthropic' as const] : []),
      ], callbacks.hostPermissions);
      void (async () => {
        const savedModel = await callbacks.readKey(KEY_LLM_MODEL);
        const geminiVal = geminiInput.value;
        const orVal = orInput.value;
        const anthropicVal = anthropicInput.value;
        const ncbiVal = ncbiInput.value;
        let selectedModel = modelSelect.value ?? DEFAULT_MODEL;
        const shouldSaveModel = !!savedModel || !!anthropicVal.trim() || !!geminiVal.trim();
        if (!savedModel && shouldSaveModel) {
          selectedModel = resolveEffectiveModel(undefined, { anthropic: anthropicVal, gemini: geminiVal });
          modelSelect.value = selectedModel;
          refreshProviderCards(doc, selectedModel);
        }

        await Promise.all([
          callbacks.writeKey(KEY_GEMINI, geminiVal).then(() => clearSavedInput(geminiInput, geminiVal)),
          callbacks.writeKey(KEY_OPENROUTER, orVal).then(() => clearSavedInput(orInput, orVal)),
          callbacks.writeKey(KEY_ANTHROPIC, anthropicVal).then(() => clearSavedInput(anthropicInput, anthropicVal)),
          callbacks.writeKey(KEY_NCBI, ncbiVal).then(() => clearSavedInput(ncbiInput, ncbiVal)),
          ...(shouldSaveModel ? [callbacks.writeKey(KEY_LLM_MODEL, selectedModel)] : []),
        ]);

        const hostAllowed = await hostPermission;
        if (!hostAllowed) {
          const notice = doc.createElement('p');
          notice.setAttribute('role', 'alert');
          notice.textContent = t('settings.permissionDenied');
          saveBtn?.parentElement?.appendChild(notice);
        }

        // Gemini キーが設定されており Gemini モデルが選択されている場合にプラン自動判定
        let modelSwitchedToFree = false;
        let tierUndetermined = false;
        let tierUnavailable = false;
        if (geminiVal.trim() === '') {
          // キーが空になったので保存済み tier をクリア
          await callbacks.removeKey(KEY_GEMINI_TIER);
          updateTierBadge(tierBadge, 'unknown');
        } else if (resolveProvider(selectedModel) === 'gemini') {
          status.textContent = t('settings.checkingPlan');
          updateTierBadge(tierBadge, 'checking');

          let tier: 'paid' | 'free' | 'unknown' | 'unavailable';
          try {
            tier = await detectTier(geminiVal);
          } catch (err) {
            if (err instanceof AiConsentDeclinedError) {
              updateTierBadge(tierBadge, 'unknown');
              throw err;
            }
            tier = 'unknown';
          }

          if (tier === 'free') {
            updateTierBadge(tierBadge, 'free');
            await callbacks.writeKey(KEY_GEMINI_TIER, 'free');
            if (modelSelect.value !== FREE_TIER_MODEL_ID) {
              modelSelect.value = FREE_TIER_MODEL_ID;
              await callbacks.writeKey(KEY_LLM_MODEL, FREE_TIER_MODEL_ID);
              refreshProviderCards(doc, FREE_TIER_MODEL_ID);
              modelSwitchedToFree = true;
            }
          } else if (tier === 'paid') {
            updateTierBadge(tierBadge, 'paid');
            await callbacks.writeKey(KEY_GEMINI_TIER, 'paid');
          } else if (tier === 'unavailable') {
            updateTierBadge(tierBadge, 'unavailable');
            tierUnavailable = true;
          } else {
            updateTierBadge(tierBadge, 'unknown');
            tierUndetermined = true;
          }
        }

        const pendingNow = await callbacks.readKey(KEY_PENDING);
        const currentModel = modelSelect.value ?? DEFAULT_MODEL;
        const provider = resolveProvider(currentModel);
        const keyForProvider = provider === 'openrouter' ? orVal
          : provider === 'anthropic' ? anthropicVal : geminiVal;

        if (hostAllowed && pendingNow === '1' && keyForProvider.trim() !== '') {
          await callbacks.removeKey(KEY_PENDING);
          status.textContent = t('settings.returning');
          banner.hidden = true;
          ctx.navigate('home');
          return;
        }

        if (modelSwitchedToFree) {
          status.textContent =
            t('settings.switched');
        } else if (tierUnavailable) {
          status.textContent =
            t('settings.unavailable');
        } else if (tierUndetermined) {
          status.textContent =
            t('settings.undetermined');
        } else {
          status.textContent = t('settings.saved');
        }
      })();
    });
  };
}
