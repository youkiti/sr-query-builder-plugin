/**
 * `chrome.storage.local` に現在のプロジェクトと最近のプロジェクト一覧を保存する
 * 薄いラッパ。requirements.md §3.2 の `currentProject` / `recentProjects` を担当。
 */

export interface CurrentProjectEntry {
  projectId: string;
  spreadsheetId: string;
  driveFolderId: string;
  title: string;
}

const CURRENT_KEY = 'currentProject';
const RECENT_KEY = 'recentProjects';
const RECENT_MAX = 10;

export interface ProjectStoreDeps {
  read: <T>(key: string) => Promise<T | undefined>;
  write: (items: Record<string, unknown>) => Promise<void>;
}

export function createChromeStoreDeps(): ProjectStoreDeps {
  return {
    read: async <T>(key: string): Promise<T | undefined> => {
      const result = await chrome.storage.local.get(key);
      return result[key] as T | undefined;
    },
    write: async (items) => {
      await chrome.storage.local.set(items);
    },
  };
}

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
