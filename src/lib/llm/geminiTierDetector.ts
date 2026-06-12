/**
 * Google AI Studio API キーが無料プランか有料プランかを検出する。
 *
 * 有料モデル（gemini-3.5-flash）へ最小プロンプトを送り、
 * レスポンスのエラーコードからプランを判定する。
 *
 * | 状態                                          | 戻り値        |
 * |----------------------------------------------|---------------|
 * | HTTP 200（モデル使用可）                       | 'paid'        |
 * | FAILED_PRECONDITION（課金未設定）              | 'free'        |
 * | PERMISSION_DENIED / NOT_FOUND                 | 'free'        |
 * | 429 RESOURCE_EXHAUSTED（free quota tier なし） | 'free'        |
 * | 429（通常のレートリミット）                     | 'unknown'     |
 * | 503 UNAVAILABLE（モデル混雑。リトライ後も継続）  | 'unavailable' |
 * | 無効キー・ネットワークエラー等                  | 'unknown'     |
 *
 * 503（モデル混雑）はプランと無関係な一時エラーなので、短いバックオフ付きで
 * 自動リトライし、それでも続く場合は 'unavailable' を返す。呼び出し側は
 * 'unavailable' を永続化せず、次回表示時に再判定させること。
 */

export type GeminiTier = 'paid' | 'free' | 'unknown' | 'unavailable';

/** 無料プラン検出時に自動設定するモデル ID */
export const FREE_TIER_MODEL_ID = 'gemini-2.0-flash';

/** プラン判定に用いる有料モデル ID */
const PROBE_MODEL_ID = 'gemini-3.5-flash';
const ENDPOINT_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

interface GeminiErrorBody {
  error?: { code?: number; message?: string; status?: string };
}

const PROBE_TIMEOUT_MS = 10_000;
/** 503 混雑時のリトライ間隔（リトライ回数 = 配列長） */
const RETRY_DELAYS_MS = [1_000, 2_000];

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function detectGeminiTier(
  apiKey: string,
  fetchImpl: typeof fetch = globalThis.fetch,
  sleepImpl: (ms: number) => Promise<void> = defaultSleep
): Promise<GeminiTier> {
  if (!apiKey.trim()) return 'unknown';

  for (let attempt = 0; ; attempt++) {
    const result = await probeOnce(apiKey, fetchImpl);
    if (result !== 'unavailable') return result;
    if (attempt >= RETRY_DELAYS_MS.length) {
      console.warn(
        '[geminiTierDetector] 判定用モデルが混雑中（503 UNAVAILABLE）。リトライ上限に達したため判定を中断'
      );
      return 'unavailable';
    }
    await sleepImpl(RETRY_DELAYS_MS[attempt] ?? 1_000);
  }
}

async function probeOnce(apiKey: string, fetchImpl: typeof fetch): Promise<GeminiTier> {
  const url = `${ENDPOINT_BASE}/${encodeURIComponent(PROBE_MODEL_ID)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  let res: Response;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        generationConfig: { maxOutputTokens: 1 },
      }),
      signal: controller.signal,
    });
  } catch {
    return 'unknown';
  } finally {
    clearTimeout(timer);
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

  // 無料キーで有料専用モデルを叩くと 429 RESOURCE_EXHAUSTED で
  // 「doesn't have a free quota tier」（quota limit = 0）が返る。
  // 通常のレートリミット（limit > 0）とはエラー内容で区別する
  if (res.status === 429 || status === 'RESOURCE_EXHAUSTED') {
    const errorText = JSON.stringify(body.error ?? {});
    if (/free quota tier/i.test(errorText) || /"quotaValue"\s*:\s*"0"/.test(errorText)) {
      return 'free';
    }
  }

  // モデル混雑（プランと無関係な一時エラー）→ 呼び出し元でリトライする
  if (res.status === 503 || status === 'UNAVAILABLE') {
    return 'unavailable';
  }

  // INVALID_ARGUMENT や UNAUTHENTICATED は無効キーの可能性が高い
  console.warn(
    '[geminiTierDetector] プラン判定不可:',
    res.status,
    status,
    body.error?.message ?? ''
  );
  return 'unknown';
}
