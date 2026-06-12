import type { RenderView } from './types';

const KEY_GEMINI = 'apiKeys.gemini';
const KEY_OPENROUTER = 'apiKeys.openrouter';
const KEY_NCBI = 'apiKeys.ncbi';
const KEY_LLM_MODEL = 'llm.selectedModel';
const KEY_CUSTOM_MODELS = 'llm.customModels';
const KEY_PENDING = 'pendingOpenAppTab';
const DEFAULT_MODEL = 'gemini-3.5-flash';
const MAX_CUSTOM_MODELS = 20;

const BUILTIN_MODELS = [
  { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', provider: 'gemini' as const },
  { id: 'qwen/qwen3-235b-a22b-2507', label: 'Qwen3 235B Instruct', provider: 'openrouter' as const },
  { id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash', provider: 'openrouter' as const },
];

type Provider = 'gemini' | 'openrouter';

interface CustomModel {
  id: string;
  label?: string;
}

export interface SettingsViewCallbacks {
  readKey: (key: string) => Promise<string | undefined>;
  writeKey: (key: string, value: string) => Promise<void>;
  removeKey: (key: string) => Promise<void>;
}

function resolveProvider(modelId: string): Provider {
  const found = BUILTIN_MODELS.find((m) => m.id === modelId);
  if (found) return found.provider;
  return modelId.includes('/') ? 'openrouter' : 'gemini';
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
  selectedModelId: string
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
  customModels.forEach((m) => {
    const opt = selectEl.ownerDocument.createElement('option');
    opt.value = m.id;
    opt.textContent = m.label ? `${m.label} (${m.id})` : m.id;
    if (m.id === selectedModelId) opt.selected = true;
    orGroup.appendChild(opt);
  });
  selectEl.appendChild(orGroup);
}

function refreshProviderCards(doc: Document, selectedModelId: string): void {
  const provider = resolveProvider(selectedModelId);
  doc
    .getElementById('settings-gemini-card')
    ?.classList.toggle('settings__provider-card--active', provider === 'gemini');
  doc
    .getElementById('settings-openrouter-card')
    ?.classList.toggle('settings__provider-card--active', provider === 'openrouter');
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
    btn.textContent = '削除';
    btn.addEventListener('click', () => onRemove(m.id));
    item.appendChild(span);
    item.appendChild(btn);
    listEl.appendChild(item);
  });
}

export function createSettingsView(callbacks: SettingsViewCallbacks): RenderView {
  return (container, ctx) => {
    container.innerHTML = '';
    const doc = container.ownerDocument;

    // ヘッダー行（タイトル + 戻るボタン）
    const header = doc.createElement('div');
    header.className = 'settings__header';
    const h2 = doc.createElement('h2');
    h2.textContent = '設定';
    h2.className = 'settings__title';
    const backBtn = doc.createElement('button');
    backBtn.type = 'button';
    backBtn.className = 'settings__back-btn';
    backBtn.textContent = '← ホームへ戻る';
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
    status.textContent = '読み込み中…';
    container.appendChild(status);

    // LLM プロバイダセクション
    const llmSection = doc.createElement('section');
    llmSection.className = 'settings__section';
    const llmHeading = doc.createElement('h3');
    llmHeading.textContent = 'LLM プロバイダ';
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
    geminiLink.textContent = 'APIキーを取得 ↗';
    geminiTitle.appendChild(geminiTitleText);
    geminiTitle.appendChild(geminiLink);
    geminiCard.appendChild(geminiTitle);
    const geminiLabel = doc.createElement('label');
    geminiLabel.className = 'settings__field';
    const geminiLabelText = doc.createElement('span');
    geminiLabelText.textContent = 'API キー';
    const geminiInput = doc.createElement('input');
    geminiInput.type = 'password';
    geminiInput.id = 'settings-gemini-key';
    geminiInput.autocomplete = 'off';
    geminiLabel.appendChild(geminiLabelText);
    geminiLabel.appendChild(geminiInput);
    geminiCard.appendChild(geminiLabel);
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
    orLink.textContent = 'APIキーを取得 ↗';
    orTitle.appendChild(orTitleText);
    orTitle.appendChild(orLink);
    orCard.appendChild(orTitle);
    const orMuted = doc.createElement('p');
    orMuted.className = 'settings__muted';
    orMuted.textContent = 'Qwen / DeepSeek などの OSS モデルや多プロバイダを利用できます。';
    orCard.appendChild(orMuted);
    const orLabel = doc.createElement('label');
    orLabel.className = 'settings__field';
    const orLabelText = doc.createElement('span');
    orLabelText.textContent = 'API キー';
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
    customHeading.textContent = 'カスタムモデルを追加（上限 20 件）';
    const customMuted = doc.createElement('p');
    customMuted.className = 'settings__muted';
    customMuted.textContent = 'OpenRouter の任意のモデルIDを追加できます（例: meta-llama/llama-3.3-70b）。';
    const customFieldRow = doc.createElement('div');
    customFieldRow.className = 'settings__field-row';
    const customIdLabel = doc.createElement('label');
    customIdLabel.className = 'settings__field';
    const customIdLabelText = doc.createElement('span');
    customIdLabelText.textContent = 'モデルID';
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
    customLabelLabelText.textContent = '表示名（任意）';
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
    addCustomModelBtn.textContent = '追加';
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

    // 使用モデル選択
    const modelLabel = doc.createElement('label');
    modelLabel.className = 'settings__field';
    const modelLabelText = doc.createElement('span');
    modelLabelText.textContent = '使用モデル';
    const modelSelect = doc.createElement('select');
    modelSelect.id = 'settings-llm-model';
    modelLabel.appendChild(modelLabelText);
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
      'APIキーを設定してください（任意）。登録すると PubMed API のレート上限が 3 req/s → 10 req/s に上がります。未設定でも動作しますが、検証フェーズで rate limit に当たる場合は' +
      ' <a href="https://www.ncbi.nlm.nih.gov/account/settings/" target="_blank" rel="noreferrer">NCBI アカウント設定</a> で取得して設定してください。';
    const ncbiLabel = doc.createElement('label');
    ncbiLabel.className = 'settings__field';
    const ncbiLabelText = doc.createElement('span');
    ncbiLabelText.textContent = 'NCBI APIキー';
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
    saveBtn.textContent = '保存';
    actions.appendChild(saveBtn);
    container.appendChild(actions);

    // ---- 非同期初期化 ----
    void (async () => {
      const [pending, gemini, openrouter, ncbi, rawModel, rawCustom] = await Promise.all([
        callbacks.readKey(KEY_PENDING),
        callbacks.readKey(KEY_GEMINI),
        callbacks.readKey(KEY_OPENROUTER),
        callbacks.readKey(KEY_NCBI),
        callbacks.readKey(KEY_LLM_MODEL),
        callbacks.readKey(KEY_CUSTOM_MODELS),
      ]);

      if (pending === '1') {
        banner.textContent =
          'LLMプロバイダのAPIキーが未設定です。入力して保存すると作業画面に戻ります。';
        banner.hidden = false;
      }

      if (gemini) geminiInput.value = gemini;
      if (openrouter) orInput.value = openrouter;
      if (ncbi) ncbiInput.value = ncbi;

      const selectedModel = rawModel ?? DEFAULT_MODEL;
      const customModels = parseCustomModels(rawCustom);
      populateModelSelect(modelSelect, customModels, selectedModel);
      renderCustomModelsList(customModelsList, customModels, handleRemoveCustomModel);
      refreshProviderCards(doc, selectedModel);

      const parts: string[] = [];
      parts.push(gemini ? 'Google AI Studio: 保存済み' : 'Google AI Studio: 未設定');
      parts.push(openrouter ? 'OpenRouter: 保存済み' : 'OpenRouter: 未設定');
      parts.push(ncbi ? 'NCBI: 保存済み' : 'NCBI: 未設定（3 req/s 枠）');
      status.textContent = parts.join(' / ');
    })();

    function handleRemoveCustomModel(id: string): void {
      void (async () => {
        const raw = await callbacks.readKey(KEY_CUSTOM_MODELS);
        const models = parseCustomModels(raw).filter((m) => m.id !== id);
        await callbacks.writeKey(KEY_CUSTOM_MODELS, JSON.stringify(models));
        const currentModel = modelSelect.value ?? DEFAULT_MODEL;
        populateModelSelect(modelSelect, models, currentModel);
        renderCustomModelsList(customModelsList, models, handleRemoveCustomModel);
        status.textContent = 'カスタムモデルを削除しました。';
      })();
    }

    modelSelect.addEventListener('change', () => {
      void callbacks.writeKey(KEY_LLM_MODEL, modelSelect.value);
      refreshProviderCards(doc, modelSelect.value);
    });

    addCustomModelBtn.addEventListener('click', () => {
      void (async () => {
        const id = customModelIdInput.value.trim();
        const label = customModelLabelInput.value.trim();
        if (!id.includes('/')) {
          status.textContent = 'モデルID は "provider/model-name" 形式で入力してください。';
          return;
        }
        const raw = await callbacks.readKey(KEY_CUSTOM_MODELS);
        const models = parseCustomModels(raw);
        if (models.length >= MAX_CUSTOM_MODELS) {
          status.textContent = 'カスタムモデルの上限（20件）に達しています。';
          return;
        }
        if (models.some((m) => m.id === id)) {
          status.textContent = 'そのモデルIDはすでに登録されています。';
          return;
        }
        const newEntry: CustomModel = label ? { id, label } : { id };
        models.push(newEntry);
        await callbacks.writeKey(KEY_CUSTOM_MODELS, JSON.stringify(models));
        customModelIdInput.value = '';
        customModelLabelInput.value = '';
        populateModelSelect(modelSelect, models, modelSelect.value ?? DEFAULT_MODEL);
        renderCustomModelsList(customModelsList, models, handleRemoveCustomModel);
        status.textContent = 'カスタムモデルを追加しました。';
      })();
    });

    saveBtn.addEventListener('click', () => {
      void (async () => {
        const geminiVal = geminiInput.value;
        const orVal = orInput.value;
        const ncbiVal = ncbiInput.value;
        const selectedModel = modelSelect.value ?? DEFAULT_MODEL;

        await Promise.all([
          callbacks.writeKey(KEY_GEMINI, geminiVal),
          callbacks.writeKey(KEY_OPENROUTER, orVal),
          callbacks.writeKey(KEY_NCBI, ncbiVal),
          callbacks.writeKey(KEY_LLM_MODEL, selectedModel),
        ]);

        const pendingNow = await callbacks.readKey(KEY_PENDING);
        const provider = resolveProvider(selectedModel);
        const keyForProvider = provider === 'openrouter' ? orVal : geminiVal;

        if (pendingNow === '1' && keyForProvider.trim() !== '') {
          await callbacks.removeKey(KEY_PENDING);
          status.textContent = '保存しました。ホーム画面に戻ります…';
          banner.hidden = true;
          ctx.navigate('home');
          return;
        }

        status.textContent = '保存しました。';
      })();
    });
  };
}
