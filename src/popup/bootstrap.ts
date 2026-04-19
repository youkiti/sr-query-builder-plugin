/**
 * Popup 画面の起動ロジック。popup.ts から呼ばれる。
 *
 * - 現在プロジェクトの表示
 * - 新規プロジェクト作成（projectService.createNewProject）
 * - 既存プロジェクト読み込み（projectService.loadExistingProject）
 * - recent project からの切替
 * - 設定 / メインビューを開くボタン
 *
 * すべての deps を引数注入するので OAuth 無しでテスト可能。
 */

import {
  createChromeRuntimeDeps,
  createNewProject,
  loadExistingProject,
  type ChromeRuntimeDeps,
} from '@/app/services';
import {
  getCurrentProject,
  getRecentProjects,
  setCurrentProject,
  type CurrentProjectEntry,
} from '@/features/project';

export interface PopupDeps {
  /** メインビュー（app.html）を新規タブで開く */
  openAppTab: () => void;
  /** 設定画面（options.html）を開く */
  openOptions: () => void;
  /** projectService と chrome.storage 周りの依存をまとめた束 */
  runtime: ChromeRuntimeDeps;
}

export function createChromePopupDeps(): PopupDeps {
  return {
    openAppTab: () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('app/app.html') });
    },
    openOptions: () => {
      chrome.runtime.openOptionsPage();
    },
    runtime: createChromeRuntimeDeps(),
  };
}

export async function startPopup(doc: Document, deps: PopupDeps): Promise<void> {
  bindOpenAppButton(doc, deps);
  bindOpenOptionsButton(doc, deps);
  await refresh(doc, deps);
  bindCreateForm(doc, deps);
  bindOpenForm(doc, deps);
}

async function refresh(doc: Document, deps: PopupDeps): Promise<void> {
  const status = doc.getElementById('popup-status');
  const currentName = doc.getElementById('popup-current-name');
  const openAppBtn = doc.getElementById('open-app') as HTMLButtonElement | null;

  const current = await getCurrentProject(deps.runtime.store);
  if (currentName) {
    currentName.textContent = current ? `${current.title} (${current.projectId.slice(0, 8)})` : '—';
  }
  if (openAppBtn) {
    openAppBtn.disabled = current === undefined;
  }
  if (status) {
    status.textContent = current
      ? '「メインビューを開く」で作業画面に進めます。'
      : 'プロジェクトを作成または既存を開いてから、メインビューを起動してください。';
  }

  const recent = await getRecentProjects(deps.runtime.store);
  renderRecent(doc, recent, deps);
}

function renderRecent(doc: Document, recent: CurrentProjectEntry[], deps: PopupDeps): void {
  const section = doc.getElementById('popup-recent-section') as HTMLElement | null;
  const list = doc.getElementById('popup-recent') as HTMLElement | null;
  if (!section || !list) {
    return;
  }
  list.innerHTML = '';
  if (recent.length === 0) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  for (const entry of recent) {
    const li = doc.createElement('li');
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.textContent = `${entry.title} — ${entry.projectId.slice(0, 8)}`;
    btn.addEventListener('click', () => {
      void switchProject(doc, deps, entry);
    });
    li.appendChild(btn);
    list.appendChild(li);
  }
}

async function switchProject(
  doc: Document,
  deps: PopupDeps,
  entry: CurrentProjectEntry
): Promise<void> {
  await setCurrentProject(entry, deps.runtime.store);
  await refresh(doc, deps);
}

function bindOpenAppButton(doc: Document, deps: PopupDeps): void {
  const btn = doc.getElementById('open-app') as HTMLButtonElement | null;
  btn?.addEventListener('click', () => {
    if (btn.disabled) return;
    deps.openAppTab();
  });
}

function bindOpenOptionsButton(doc: Document, deps: PopupDeps): void {
  doc.getElementById('open-options')?.addEventListener('click', () => {
    deps.openOptions();
  });
}

function bindCreateForm(doc: Document, deps: PopupDeps): void {
  const form = doc.getElementById('popup-create-form') as HTMLFormElement | null;
  const titleInput = doc.getElementById('popup-create-title') as HTMLInputElement | null;
  const error = doc.getElementById('popup-create-error');
  if (!form || !titleInput) return;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (error) error.textContent = '';
    void createNewProject(titleInput.value, deps.runtime)
      .then(async () => {
        titleInput.value = '';
        await refresh(doc, deps);
      })
      .catch((err: unknown) => {
        if (error) error.textContent = formatError(err);
      });
  });
}

function bindOpenForm(doc: Document, deps: PopupDeps): void {
  const form = doc.getElementById('popup-open-form') as HTMLFormElement | null;
  const idInput = doc.getElementById('popup-open-id') as HTMLInputElement | null;
  const error = doc.getElementById('popup-open-error');
  if (!form || !idInput) return;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (error) error.textContent = '';
    void loadExistingProject(idInput.value, deps.runtime)
      .then(async () => {
        idInput.value = '';
        await refresh(doc, deps);
      })
      .catch((err: unknown) => {
        if (error) error.textContent = formatError(err);
      });
  });
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
