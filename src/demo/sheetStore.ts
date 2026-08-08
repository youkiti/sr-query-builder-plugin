/**
 * Google Sheets / Drive API（`sheets.googleapis.com` / `www.googleapis.com/drive`）の
 * in-memory モック。`chrome.storage.local` に永続化するので、章をまたいで
 * `app.html` を開き直しても状態が保たれる（同じ拡張プロファイル内であれば）。
 *
 * `src/lib/google/sheets.ts` / `drive.ts` が実際に組み立てる URL・body の形に
 * 忠実に合わせて実装する（実装を読み替えず、そのまま受けられる形にする）。
 */

import { jsonResponse as jsonResponseOf, textResponse as textResponseOf } from './fakeResponse';

const STORAGE_KEY = '__demoBackend__';

interface SpreadsheetRecord {
  spreadsheetId: string;
  spreadsheetUrl: string;
  title: string;
  /** タブ名 → 行の 2 次元配列（0 行目がヘッダとは限らない。書き込み側の規約に従う） */
  tabs: Record<string, string[][]>;
}

interface DriveFileRecord {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  webViewLink: string;
  /** テキストファイルの内容（フォルダには存在しない） */
  content?: string;
}

interface DemoBackend {
  spreadsheets: Record<string, SpreadsheetRecord>;
  driveFiles: Record<string, DriveFileRecord>;
  nextId: number;
}

function createEmptyBackend(): DemoBackend {
  return { spreadsheets: {}, driveFiles: {}, nextId: 1 };
}

let cache: DemoBackend | null = null;
let loadPromise: Promise<DemoBackend> | null = null;

async function load(): Promise<DemoBackend> {
  if (cache) {
    return cache;
  }
  if (!loadPromise) {
    loadPromise = (async () => {
      const stored = (await chrome.storage.local.get(STORAGE_KEY)) as Record<string, unknown>;
      const data = (stored[STORAGE_KEY] as DemoBackend | undefined) ?? createEmptyBackend();
      cache = data;
      return data;
    })();
  }
  return loadPromise;
}

async function persist(): Promise<void> {
  /* istanbul ignore if -- persist は load 済みの後にしか呼ばれない */
  if (!cache) return;
  await chrome.storage.local.set({ [STORAGE_KEY]: cache });
}

function issueId(prefix: string, backend: DemoBackend): string {
  const id = `demo-${prefix}-${backend.nextId}`;
  backend.nextId += 1;
  return id;
}

/**
 * デモバックエンド（Sheets/Drive の in-memory 状態）を空に戻す。
 * `?demoSeed=` 切り替え時に、前章の状態を持ち越さないために使う。
 */
export async function resetDemoBackend(): Promise<void> {
  cache = createEmptyBackend();
  await persist();
}

/* ------------------------------------------------------------------------ */
/* Sheets API                                                                */
/* ------------------------------------------------------------------------ */

function parseRange(rangeSegment: string): { tab: string; rowIndex: number | null } {
  const decoded = decodeURIComponent(rangeSegment);
  const [tab] = decoded.split('!');
  const rowMatch = /!A(\d+)/.exec(decoded);
  return { tab: tab ?? '', rowIndex: rowMatch ? Number.parseInt(rowMatch[1] as string, 10) : null };
}

async function handleCreateSpreadsheet(bodyText: string): Promise<Response> {
  const backend = await load();
  const body = JSON.parse(bodyText) as { properties?: { title?: string }; sheets?: Array<{ properties?: { title?: string } }> };
  const title = body.properties?.title ?? '(無題)';
  const spreadsheetId = issueId('sheet', backend);
  const tabs: Record<string, string[][]> = {};
  for (const sheet of body.sheets ?? []) {
    const tabTitle = sheet.properties?.title;
    if (tabTitle) {
      tabs[tabTitle] = [];
    }
  }
  const spreadsheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
  backend.spreadsheets[spreadsheetId] = { spreadsheetId, spreadsheetUrl, title, tabs };
  // 実際の Sheets API は spreadsheet も Drive 上のファイルとして存在する
  // （`spreadsheets.create` は常にマイドライブ直下に作る）。`moveFileToFolder` が
  // spreadsheetId をそのまま Drive fileId として GET/PATCH するため、
  // ここで対応する DriveFileRecord も一緒に登録しておく（createProject.ts 参照）。
  backend.driveFiles[spreadsheetId] = {
    id: spreadsheetId,
    name: title,
    mimeType: 'application/vnd.google-apps.spreadsheet',
    parents: ['root'],
    webViewLink: spreadsheetUrl,
  };
  await persist();
  return jsonResponseOf({ spreadsheetId, spreadsheetUrl });
}

function getSpreadsheetOrThrow(backend: DemoBackend, spreadsheetId: string): SpreadsheetRecord {
  const sheet = backend.spreadsheets[spreadsheetId];
  if (!sheet) {
    throw new Error(`[demo] sheetStore: 存在しない spreadsheetId です（シードの順序を確認してください）: ${spreadsheetId}`);
  }
  return sheet;
}

async function handleGetValues(spreadsheetId: string, tab: string): Promise<Response> {
  const backend = await load();
  const sheet = getSpreadsheetOrThrow(backend, spreadsheetId);
  return jsonResponseOf({ values: sheet.tabs[tab] ?? [] });
}

async function handlePutValues(spreadsheetId: string, tab: string, rowIndex: number, bodyText: string): Promise<Response> {
  const backend = await load();
  const sheet = getSpreadsheetOrThrow(backend, spreadsheetId);
  const body = JSON.parse(bodyText) as { values?: string[][] };
  const row = body.values?.[0] ?? [];
  const rows = sheet.tabs[tab] ?? (sheet.tabs[tab] = []);
  while (rows.length < rowIndex) {
    rows.push([]);
  }
  rows[rowIndex - 1] = row.map(String);
  await persist();
  return jsonResponseOf({ updatedRange: `${tab}!A${rowIndex}` });
}

async function handleAppendValues(spreadsheetId: string, tab: string, bodyText: string): Promise<Response> {
  const backend = await load();
  const sheet = getSpreadsheetOrThrow(backend, spreadsheetId);
  const body = JSON.parse(bodyText) as { values?: string[][] };
  const row = (body.values?.[0] ?? []).map(String);
  const rows = sheet.tabs[tab] ?? (sheet.tabs[tab] = []);
  rows.push(row);
  await persist();
  return jsonResponseOf({ updates: { updatedRange: `${tab}!A${rows.length}` } });
}

/** `https://sheets.googleapis.com/v4/spreadsheets*` 宛リクエストを処理する。 */
export async function handleSheetsRequest(
  rawUrl: string,
  method: string,
  bodyText: string
): Promise<Response> {
  const url = new URL(rawUrl);
  const segments = url.pathname.split('/').filter((s) => s !== '');
  // segments: ['v4','spreadsheets'] または ['v4','spreadsheets', id, 'values', rangeSeg[:append]]
  if (segments.length === 2 && method === 'POST') {
    return handleCreateSpreadsheet(bodyText);
  }
  if (segments.length === 5 && segments[3] === 'values') {
    const spreadsheetId = segments[2] as string;
    const rawSegment = segments[4] as string;
    const isAppend = rawSegment.endsWith(':append');
    const rangeSegment = isAppend ? rawSegment.slice(0, -':append'.length) : rawSegment;
    const { tab, rowIndex } = parseRange(rangeSegment);
    if (method === 'GET') {
      return handleGetValues(spreadsheetId, tab);
    }
    if (method === 'PUT' && rowIndex !== null) {
      return handlePutValues(spreadsheetId, tab, rowIndex, bodyText);
    }
    if (method === 'POST' && isAppend) {
      return handleAppendValues(spreadsheetId, tab, bodyText);
    }
  }
  throw new Error(`[demo] sheetStore: 未対応の Sheets API 呼び出しです: ${method} ${rawUrl}`);
}

/* ------------------------------------------------------------------------ */
/* Drive API                                                                 */
/* ------------------------------------------------------------------------ */

function parseDriveQuery(q: string): { name: string | null; parent: string | null } {
  const nameMatch = /name='((?:[^'\\]|\\.)*)'/.exec(q);
  const parentMatch = /'((?:[^'\\]|\\.)*)'\s+in\s+parents/.exec(q);
  return {
    name: nameMatch ? nameMatch[1]!.replace(/\\'/g, "'") : null,
    parent: parentMatch ? parentMatch[1]!.replace(/\\'/g, "'") : null,
  };
}

async function handleCreateFolder(bodyText: string): Promise<Response> {
  const backend = await load();
  const body = JSON.parse(bodyText) as { name: string; mimeType: string; parents?: string[] };
  const id = issueId('drive', backend);
  const webViewLink = `https://drive.google.com/drive/folders/${id}`;
  const record: DriveFileRecord = {
    id,
    name: body.name,
    mimeType: body.mimeType,
    parents: body.parents && body.parents.length > 0 ? body.parents : ['root'],
    webViewLink,
  };
  backend.driveFiles[id] = record;
  await persist();
  return jsonResponseOf({ id, webViewLink });
}

async function handleListFiles(url: URL): Promise<Response> {
  const backend = await load();
  const q = url.searchParams.get('q') ?? '';
  const { name, parent } = parseDriveQuery(q);
  const files = Object.values(backend.driveFiles).filter((f) => {
    if (name !== null && f.name !== name) return false;
    if (parent !== null && !f.parents.includes(parent)) return false;
    return true;
  });
  return jsonResponseOf({ files: files.map((f) => ({ id: f.id, webViewLink: f.webViewLink })) });
}

async function handleGetFileMeta(url: URL, fileId: string): Promise<Response> {
  const backend = await load();
  const file = backend.driveFiles[fileId];
  if (!file) {
    throw new Error(`[demo] sheetStore: 存在しない Drive fileId です: ${fileId}`);
  }
  if (url.searchParams.get('alt') === 'media') {
    return textResponseOf(file.content ?? '');
  }
  return jsonResponseOf({ id: file.id, parents: file.parents, webViewLink: file.webViewLink });
}

async function handlePatchFile(url: URL, fileId: string): Promise<Response> {
  const backend = await load();
  const file = backend.driveFiles[fileId];
  if (!file) {
    throw new Error(`[demo] sheetStore: 存在しない Drive fileId です: ${fileId}`);
  }
  const addParents = (url.searchParams.get('addParents') ?? '').split(',').filter((v) => v !== '');
  const removeParents = new Set(
    (url.searchParams.get('removeParents') ?? '').split(',').filter((v) => v !== '')
  );
  file.parents = [...file.parents.filter((p) => !removeParents.has(p)), ...addParents];
  await persist();
  return jsonResponseOf({ id: file.id, parents: file.parents });
}

async function handleUploadMultipart(bodyText: string, contentTypeHeader: string): Promise<Response> {
  const backend = await load();
  const boundaryMatch = /boundary=(.+)$/.exec(contentTypeHeader);
  if (!boundaryMatch) {
    throw new Error('[demo] sheetStore: multipart アップロードの boundary を特定できません');
  }
  const { metadata, content } = parseMultipartUpload(bodyText, boundaryMatch[1] as string);
  const id = issueId('drive', backend);
  const webViewLink = `https://drive.google.com/file/d/${id}/view`;
  backend.driveFiles[id] = {
    id,
    name: metadata.name,
    mimeType: 'text/plain',
    parents: metadata.parents ?? [],
    webViewLink,
    content,
  };
  await persist();
  return jsonResponseOf({ id, webViewLink });
}

function extractPartBody(part: string): { headerSection: string; body: string } {
  const idx = part.indexOf('\r\n\r\n');
  if (idx < 0) {
    return { headerSection: part, body: '' };
  }
  return { headerSection: part.slice(0, idx), body: part.slice(idx + 4).replace(/\r\n$/, '') };
}

function parseMultipartUpload(
  raw: string,
  boundary: string
): { metadata: { name: string; parents: string[] }; content: string } {
  const marker = `--${boundary}`;
  const parts = raw.split(marker).filter((p) => p.trim() !== '' && p.trim() !== '--');
  const [metaRaw, contentRaw] = parts;
  const metaBody = extractPartBody(metaRaw ?? '').body;
  const metadata = JSON.parse(metaBody) as { name: string; parents: string[] };
  const content = extractPartBody(contentRaw ?? '').body;
  return { metadata, content };
}

/** `https://www.googleapis.com/drive/v3/files*` / `https://www.googleapis.com/upload/drive/v3/files*` を処理する。 */
export async function handleDriveRequest(
  rawUrl: string,
  method: string,
  bodyText: string,
  contentTypeHeader: string
): Promise<Response> {
  const url = new URL(rawUrl);
  if (url.pathname === '/upload/drive/v3/files' && method === 'POST') {
    return handleUploadMultipart(bodyText, contentTypeHeader);
  }
  if (url.pathname === '/drive/v3/files' && method === 'POST') {
    return handleCreateFolder(bodyText);
  }
  if (url.pathname === '/drive/v3/files' && method === 'GET') {
    return handleListFiles(url);
  }
  const fileMatch = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
  if (fileMatch && method === 'GET') {
    return handleGetFileMeta(url, decodeURIComponent(fileMatch[1] as string));
  }
  if (fileMatch && method === 'PATCH') {
    return handlePatchFile(url, decodeURIComponent(fileMatch[1] as string));
  }
  throw new Error(`[demo] sheetStore: 未対応の Drive API 呼び出しです: ${method} ${rawUrl}`);
}
