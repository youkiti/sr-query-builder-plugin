import {
  createProject,
  loadProjectMeta,
  setCurrentProject,
  type CreateProjectResult,
  type CurrentProjectEntry,
  type ProjectStoreDeps,
} from '@/features/project';
import {
  getCurrentUserEmail,
  type GoogleApiDeps,
  type ProfileDeps,
} from '@/lib/google';

/**
 * プロジェクト作成 / 既存読み込み / 現在プロジェクト切替を司るサービス層。
 *
 * - lib/google + features/project + chrome.storage を 1 段抽象化し、
 *   UI レイヤ（Popup / app）から 1 関数呼び出しで完結させる
 * - 全依存は引数で受け取り、テスト時に差し替え可能
 */

export interface ProjectServiceDeps {
  google: GoogleApiDeps;
  profile: ProfileDeps;
  store: ProjectStoreDeps;
}

/**
 * 新規プロジェクトを作成し、Sheets / Drive を初期化して
 * chrome.storage の currentProject / recentProjects に登録する。
 *
 * @returns 登録した CurrentProjectEntry と、低レベルの作成結果（テスト / デバッグ用）
 */
export async function createNewProject(
  projectTitle: string,
  deps: ProjectServiceDeps
): Promise<{ entry: CurrentProjectEntry; raw: CreateProjectResult }> {
  const trimmed = projectTitle.trim();
  if (trimmed === '') {
    throw new Error('プロジェクトタイトルは必須です');
  }
  const createdBy = (await getCurrentUserEmail(deps.profile)) ?? '';
  const result = await createProject({ projectTitle: trimmed, createdBy }, deps.google);
  const entry = toEntry(result);
  await setCurrentProject(entry, deps.store);
  return { entry, raw: result };
}

/**
 * 既存スプレッドシートを開いてプロジェクトとして登録する。
 *
 * - Meta タブを読み schemaVersion / 列構成を検証（loadProjectMeta が ProjectSchemaError）
 * - 通れば currentProject / recentProjects を更新
 */
export async function loadExistingProject(
  spreadsheetId: string,
  deps: ProjectServiceDeps
): Promise<CurrentProjectEntry> {
  const trimmed = spreadsheetId.trim();
  if (trimmed === '') {
    throw new Error('スプレッドシート ID は必須です');
  }
  const meta = await loadProjectMeta(trimmed, deps.google);
  const entry: CurrentProjectEntry = {
    projectId: meta.projectId,
    spreadsheetId: meta.spreadsheetId,
    driveFolderId: meta.driveFolderId,
    title: meta.projectTitle,
  };
  await setCurrentProject(entry, deps.store);
  return entry;
}

function toEntry(result: CreateProjectResult): CurrentProjectEntry {
  return {
    projectId: result.meta.projectId,
    spreadsheetId: result.meta.spreadsheetId,
    driveFolderId: result.meta.driveFolderId,
    title: result.meta.projectTitle,
  };
}
