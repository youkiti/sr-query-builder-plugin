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
    throw new GoogleApiError(
      `Google API failed: HTTP ${res.status}`,
      res.status,
      url,
      body
    );
  }
  return res;
}
