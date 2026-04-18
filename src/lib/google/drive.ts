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

/**
 * Drive にフォルダを作成する。`parentId` を指定すると配下に、null で「マイドライブ直下」。
 */
export async function createFolder(
  name: string,
  parentId: string | null,
  deps: GoogleApiDeps
): Promise<DriveFileRef> {
  const body = {
    name,
    mimeType: 'application/vnd.google-apps.folder',
    parents: parentId ? [parentId] : undefined,
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
 * ファイル ID を指定してテキスト本文を取得する。`alt=media` で実体を返す。
 */
export async function getFileText(fileId: string, deps: GoogleApiDeps): Promise<string> {
  const url = `${METADATA_API}/${encodeURIComponent(fileId)}?alt=media`;
  const res = await googleFetch(url, { method: 'GET' }, deps);
  return await res.text();
}
