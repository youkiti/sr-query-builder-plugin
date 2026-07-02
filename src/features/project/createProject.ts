import { CURRENT_SCHEMA_VERSION, type ProjectMeta } from '@/domain/project';
import { SHEET_HEADERS, SHEET_TABS } from '@/domain/sheetsSchema';
import {
  appendRow,
  createFolder,
  ensureRootFolder,
  createSpreadsheet,
  writeHeaderRow,
  type CreatedSpreadsheet,
  type DriveFileRef,
  type GoogleApiDeps,
} from '@/lib/google';
import { nowIso } from '@/utils/iso8601';
import { newUuid, shortUuid } from '@/utils/uuid';

/**
 * 新規プロジェクトを作成する。
 * requirements.md §4.1 の手順を TS で実装：
 *
 * 1. project_id（UUID v4）発行
 * 2. Drive トップフォルダ作成（`マイドライブ/SR Query Builder/{title}_{id_short}/`）
 * 3. サブフォルダ（raw_protocols / logs/llm / logs/validation）作成
 * 4. トップフォルダ内にスプレッドシート作成（9 タブを一括初期化）
 * 5. 各タブのヘッダ行書き込み
 * 6. Meta タブに 1 行追記
 */

/** ルートフォルダ名（アプリの正式名称に合わせる） */
const ROOT_FOLDER_NAME = 'SR Query Builder';
/** 旧ルートフォルダ名。既存ユーザーのフォルダは改名して再利用する */
const LEGACY_ROOT_FOLDER_NAME = 'sr-query-builder';
/** アイコン背景色（src/icons/icon128.png）。Drive パレットの最も近い色に丸められる */
const ROOT_FOLDER_COLOR_RGB = '#45afd7';

export interface CreateProjectInput {
  projectTitle: string;
  createdBy: string;
}

export interface CreateProjectResult {
  meta: ProjectMeta;
  spreadsheet: CreatedSpreadsheet;
  driveFolder: DriveFileRef;
  subfolders: {
    rawProtocols: DriveFileRef;
    logsLlm: DriveFileRef;
    logsValidation: DriveFileRef;
  };
}

/**
 * テスト時に注入するヘルパの集合。UUID・時刻・ルートフォルダ ID 取得など、
 * 純粋でない関数はここから注入する。
 */
export interface CreateProjectHelpers {
  /** ルート `SR Query Builder/` フォルダの ID を取得（無ければ作る）。null でマイドライブ直下にする */
  ensureRootFolder?: (deps: GoogleApiDeps) => Promise<string | null>;
  newUuid?: () => string;
  now?: () => string;
}

export async function createProject(
  input: CreateProjectInput,
  deps: GoogleApiDeps,
  helpers: CreateProjectHelpers = {}
): Promise<CreateProjectResult> {
  const uuid = helpers.newUuid ?? newUuid;
  const now = helpers.now ?? nowIso;
  const ensureRoot = helpers.ensureRootFolder ?? defaultEnsureRootFolder;

  const projectId = uuid();
  const rootFolderId = await ensureRoot(deps);
  const topFolderName = `${input.projectTitle}_${shortUuid(projectId)}`;
  const driveFolder = await createFolder(topFolderName, rootFolderId, deps);

  const rawProtocols = await createFolder('raw_protocols', driveFolder.id, deps);
  const logsParent = await createFolder('logs', driveFolder.id, deps);
  const logsLlm = await createFolder('llm', logsParent.id, deps);
  const logsValidation = await createFolder('validation', logsParent.id, deps);

  const spreadsheet = await createSpreadsheet(
    input.projectTitle,
    SHEET_TABS,
    deps
  );

  // 新規スプレッドシートをプロジェクトフォルダ配下に移動することは本 MVP では省略する
  // （Drive API files.update の parents 操作が必要。§9 では要件に含めない）

  for (const tab of SHEET_TABS) {
    await writeHeaderRow(spreadsheet.spreadsheetId, tab, SHEET_HEADERS[tab], deps);
  }

  const meta: ProjectMeta = {
    projectId,
    projectTitle: input.projectTitle,
    spreadsheetId: spreadsheet.spreadsheetId,
    driveFolderId: driveFolder.id,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    createdAt: now(),
    createdBy: input.createdBy,
  };

  await appendRow(
    spreadsheet.spreadsheetId,
    'Meta',
    [
      meta.projectId,
      meta.projectTitle,
      meta.spreadsheetId,
      meta.driveFolderId,
      meta.schemaVersion,
      meta.createdAt,
      meta.createdBy,
    ],
    deps
  );

  return {
    meta,
    spreadsheet,
    driveFolder,
    subfolders: { rawProtocols, logsLlm, logsValidation },
  };
}

/**
 * `SR Query Builder` ルートフォルダを確保する既定実装。
 * My Drive ルート直下を検索して既存フォルダを再利用し、旧名称
 * `sr-query-builder` のフォルダがあれば改名＋アイコン色の適用で引き継ぐ。
 * どちらも無ければアイコン色付きで新規作成する。テスト時は helpers で差し替え可能。
 */
async function defaultEnsureRootFolder(deps: GoogleApiDeps): Promise<string> {
  const folder = await ensureRootFolder(ROOT_FOLDER_NAME, deps, {
    colorRgb: ROOT_FOLDER_COLOR_RGB,
    legacyName: LEGACY_ROOT_FOLDER_NAME,
  });
  return folder.id;
}
