import { googleFetch, type GoogleApiDeps } from './types';

const METADATA_API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';

/**
 * Drive API v3 の薄いラッパ。MVP で必要なのはフォルダ作成・テキスト
 * ファイル保存・テキスト取得の 3 本だけ。
 */

export interface DriveFileRef {
  id: string;
  webViewLink: string;
}

interface DriveListResponse {
  files?: DriveFileRef[];
}

export interface CreateFolderOptions {
  /**
   * フォルダ色（RGB hex）。Drive のパレットに無い色を指定した場合は
   * Drive 側が最も近いパレット色へ自動で丸める。
   */
  colorRgb?: string;
}

/**
 * Drive にフォルダを作成する。`parentId` を指定すると配下に、null で「マイドライブ直下」。
 */
export async function createFolder(
  name: string,
  parentId: string | null,
  deps: GoogleApiDeps,
  options: CreateFolderOptions = {}
): Promise<DriveFileRef> {
  const body = {
    name,
    mimeType: 'application/vnd.google-apps.folder',
    parents: parentId ? [parentId] : undefined,
    folderColorRgb: options.colorRgb,
  };
  const url = `${METADATA_API}?fields=id,webViewLink`;
  const res = await googleFetch(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    deps
  );
  return (await res.json()) as DriveFileRef;
}

export async function ensureChildFolder(
  name: string,
  parentId: string,
  deps: GoogleApiDeps
): Promise<DriveFileRef> {
  const escapedName = name.replace(/'/g, "\\'");
  const query = [
    `name='${escapedName}'`,
    `mimeType='application/vnd.google-apps.folder'`,
    `'${parentId}' in parents`,
    'trashed=false',
  ].join(' and ');
  const url =
    `${METADATA_API}?fields=files(id,webViewLink)` +
    `&pageSize=1&q=${encodeURIComponent(query)}`;
  const res = await googleFetch(url, { method: 'GET' }, deps);
  const body = (await res.json()) as DriveListResponse;
  const existing = body.files?.[0];
  if (existing) {
    return existing;
  }
  return createFolder(name, parentId, deps);
}

/**
 * プレーンテキストや JSON をファイルとして指定フォルダにアップロードする。
 * multipart upload を手動で組み立てる（copy-webpack-plugin などの追加依存不要）。
 */
export async function uploadTextFile(
  params: {
    name: string;
    content: string;
    parentId: string;
    mimeType?: string;
  },
  deps: GoogleApiDeps
): Promise<DriveFileRef> {
  const mimeType = params.mimeType ?? 'text/plain';
  const metadata = {
    name: params.name,
    parents: [params.parentId],
  };
  const boundary = `boundary-${Math.random().toString(36).slice(2)}`;
  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${mimeType}; charset=UTF-8\r\n\r\n` +
    `${params.content}\r\n` +
    `--${boundary}--`;
  const url = `${UPLOAD_API}?uploadType=multipart&fields=id,webViewLink`;
  const res = await googleFetch(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    },
    deps
  );
  return (await res.json()) as DriveFileRef;
}

/**
 * フォルダのメタデータ（名前・色）を更新する。
 */
export async function updateFolder(
  fileId: string,
  patch: { name?: string; folderColorRgb?: string },
  deps: GoogleApiDeps
): Promise<DriveFileRef> {
  const url = `${METADATA_API}/${encodeURIComponent(fileId)}?fields=id,webViewLink`;
  const res = await googleFetch(
    url,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    },
    deps
  );
  return (await res.json()) as DriveFileRef;
}

/** My Drive ルート直下で指定名のフォルダを検索する（無ければ null）。 */
async function findRootFolder(
  name: string,
  deps: GoogleApiDeps
): Promise<DriveFileRef | null> {
  const escapedName = name.replace(/'/g, "\\'");
  const query = [
    `name='${escapedName}'`,
    `mimeType='application/vnd.google-apps.folder'`,
    `'root' in parents`,
    'trashed=false',
  ].join(' and ');
  const url =
    `${METADATA_API}?fields=files(id,webViewLink)` +
    `&pageSize=1&q=${encodeURIComponent(query)}`;
  const res = await googleFetch(url, { method: 'GET' }, deps);
  const body = (await res.json()) as DriveListResponse;
  return body.files?.[0] ?? null;
}

export interface EnsureRootFolderOptions {
  /** 新規作成・旧名称からの移行時に適用するフォルダ色 */
  colorRgb?: string;
  /**
   * 旧名称。指定名のフォルダが無く旧名称のフォルダがあれば、
   * 新規作成せずそのフォルダを改名（＋色変更）して再利用する。
   */
  legacyName?: string;
}

/**
 * My Drive ルート直下で指定名のフォルダを探し、なければ新規作成して返す。
 * 複数回プロジェクト作成してもルートフォルダが増殖しない。
 */
export async function ensureRootFolder(
  name: string,
  deps: GoogleApiDeps,
  options: EnsureRootFolderOptions = {}
): Promise<DriveFileRef> {
  const existing = await findRootFolder(name, deps);
  if (existing) {
    return existing;
  }
  if (options.legacyName) {
    const legacy = await findRootFolder(options.legacyName, deps);
    if (legacy) {
      return updateFolder(
        legacy.id,
        { name, folderColorRgb: options.colorRgb },
        deps
      );
    }
  }
  return createFolder(name, null, deps, { colorRgb: options.colorRgb });
}

/**
 * ファイル ID を指定してテキスト本文を取得する。`alt=media` で実体を返す。
 */
export async function getFileText(fileId: string, deps: GoogleApiDeps): Promise<string> {
  const url = `${METADATA_API}/${encodeURIComponent(fileId)}?alt=media`;
  const res = await googleFetch(url, { method: 'GET' }, deps);
  return await res.text();
}
