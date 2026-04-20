/**
 * `chrome.storage.local` に現在のプロジェクトと最近のプロジェクト一覧を保存する
 * 薄いラッパ。requirements.md §3.2 の `currentProject` / `recentProjects` を担当。
 *
 * Chrome storage アクセスの基盤は `lib/storage/chromeStorage.ts` に移動したので、
 * ここでは「プロジェクトリストというドメインの読み書きロジック」だけを残す。
 */

import {
  createChromeStorageDeps,
  type ChromeStorageDeps,
} from '@/lib/storage';

export interface CurrentProjectEntry {
  projectId: string;
  spreadsheetId: string;
  driveFolderId: string;
  title: string;
}

const CURRENT_KEY = 'currentProject';
const RECENT_KEY = 'recentProjects';
const RECENT_MAX = 10;

/**
 * @deprecated `ChromeStorageDeps` を直接使うことを推奨。
 * 既存コードとの後方互換のため別名で残す。
 */
export type ProjectStoreDeps = ChromeStorageDeps;

/**
 * @deprecated `createChromeStorageDeps` を直接使うことを推奨。
 */
export const createChromeStoreDeps = createChromeStorageDeps;

export async function setCurrentProject(
  entry: CurrentProjectEntry,
  deps: ProjectStoreDeps
): Promise<void> {
  const recent = (await deps.read<CurrentProjectEntry[]>(RECENT_KEY)) ?? [];
  const filtered = recent.filter((r) => r.projectId !== entry.projectId);
  const nextRecent = [entry, ...filtered].slice(0, RECENT_MAX);
  await deps.write({ [CURRENT_KEY]: entry, [RECENT_KEY]: nextRecent });
}

export async function getCurrentProject(
  deps: ProjectStoreDeps
): Promise<CurrentProjectEntry | undefined> {
  return await deps.read<CurrentProjectEntry>(CURRENT_KEY);
}

export async function getRecentProjects(
  deps: ProjectStoreDeps
): Promise<CurrentProjectEntry[]> {
  return (await deps.read<CurrentProjectEntry[]>(RECENT_KEY)) ?? [];
}

export async function clearCurrentProject(deps: ProjectStoreDeps): Promise<void> {
  await deps.write({ [CURRENT_KEY]: null });
}
