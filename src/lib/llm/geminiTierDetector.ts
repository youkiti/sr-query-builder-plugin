/**
 * Google AI Studio API キーが無料プランか有料プランかを検出する。
 *
 * 有料モデル（gemini-3.5-flash）へ最小プロンプトを送り、
 * レスポンスのエラーコードからプランを判定する。
 *
 * | 状態                            | 戻り値    |
 * |--------------------------------|-----------|
 * | HTTP 200（モデル使用可）         | 'paid'    |
 * | FAILED_PRECONDITION（課金未設定）| 'free'    |
 * | PERMISSION_DENIED / NOT_FOUND  | 'free'    |
 * | 無効キー・ネットワークエラー等   | 'unknown' |
 */

export type GeminiTier = 'paid' | 'free' | 'unknown';

/** 無料プラン検出時に自動設定するモデル ID */
export const FREE_TIER_MODEL_ID = 'gemini-2.0-flash';

/** プラン判定に用いる有料モデル ID */
const PROBE_MODEL_ID = 'gemini-3.5-flash';
const ENDPOINT_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

interface GeminiErrorBody {
  error?: { code?: number; message?: string; status?: string };
}

export async function detectGeminiTier(
  apiKey: string,
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<GeminiTier> {
  if (!apiKey.trim()) return 'unknown';

  const url = `${ENDPOINT_BASE}/${encodeURIComponent(PROBE_MODEL_ID)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        generationConfig: { maxOutputTokens: 1 },
      }),
    });
  } catch {
    return 'unknown';
  }

  if (res.ok) return 'paid';

  let body: GeminiErrorBody = {};
  try {
    body = (await res.json()) as GeminiErrorBody;
  } catch {
    // レスポンスボディが JSON でない場合は無視
  }

  const status = body.error?.status ?? '';

  // 課金未設定エラー → 無料プラン
  if (status === 'FAILED_PRECONDITION') return 'free';

  // モデルへのアクセス権なし → 無料プランには有料モデルへのアクセス権がない
  if (status === 'PERMISSION_DENIED' || res.status === 403) return 'free';
  if (status === 'NOT_FOUND' || res.status === 404) return 'free';

  // INVALID_ARGUMENT や UNAUTHENTICATED は無効キーの可能性が高い
  return 'unknown';
}
