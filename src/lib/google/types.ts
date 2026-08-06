/**
 * Google API 呼び出しに共通で必要な依存。
 * fetch / OAuth トークン取得を注入することで OAuth 無しでも単体テスト可能。
 */
export interface GoogleApiDeps {
  fetch: typeof fetch;
  /** アクセストークンを取得する関数。失効時は再取得も行う */
  getAccessToken: () => Promise<string>;
}

/** Google API が 4xx/5xx を返したときの型付きエラー */
export class GoogleApiError extends Error {
  readonly status: number;
  readonly endpoint: string;
  readonly responseBody: string;

  constructor(message: string, status: number, endpoint: string, responseBody: string) {
    super(message);
    this.name = 'GoogleApiError';
    this.status = status;
    this.endpoint = endpoint;
    this.responseBody = responseBody;
  }
}

/** 生レスポンス本文をメッセージに埋め込む際の切り詰め長（文字数） */
const RESPONSE_BODY_PREVIEW_LIMIT = 200;

/**
 * エラーレスポンス本文から画面表示用の詳細メッセージを抽出する。
 * Google API は `{"error":{"message":"..."}}` 形式の JSON を返すことが多いので
 * それを優先し、JSON として解釈できない場合は本文をそのまま（切り詰めて）使う。
 */
function extractErrorDetail(responseBody: string): string {
  if (!responseBody) return '';
  try {
    const parsed = JSON.parse(responseBody) as { error?: { message?: string } };
    if (parsed?.error?.message) {
      return parsed.error.message;
    }
  } catch {
    // JSON ではない（HTML エラーページ等）。生本文にフォールバックする。
  }
  return responseBody.length > RESPONSE_BODY_PREVIEW_LIMIT
    ? `${responseBody.slice(0, RESPONSE_BODY_PREVIEW_LIMIT)}...`
    : responseBody;
}

/**
 * 認証ヘッダ付きで fetch し、非 2xx を GoogleApiError に変換する共通ラッパ。
 */
export async function googleFetch(
  url: string,
  init: RequestInit,
  deps: GoogleApiDeps
): Promise<Response> {
  const token = await deps.getAccessToken();
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  const res = await deps.fetch(url, { ...init, headers });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const method = init.method ?? 'GET';
    const detail = extractErrorDetail(body);
    const detailSegment = detail ? ` - ${detail}` : '';
    throw new GoogleApiError(
      `Google API failed: HTTP ${res.status}${detailSegment} (${method} ${url})`,
      res.status,
      url,
      body
    );
  }
  return res;
}
