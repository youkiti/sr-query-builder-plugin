import { GoogleApiError, isAccessDeniedStatus } from '@/lib/google';
import { LlmProviderError } from '@/lib/llm';
import { EutilsError } from '@/lib/ncbi';

/**
 * 外部 API の失敗を「利用者が次に取るべき行動」で分類する（issue #109）。
 *
 * 画面はこの分類だけを見て案内を出し分ける。HTTP ステータスの解釈を各ビューへ散らすと、
 * 同じ 403 が画面ごとに違う文言になる（実際に `#/expand` は生の
 * `Google API failed: HTTP 403` を出すだけで、共有設定を直す以外に復帰手段が無いことを
 * 伝えられていなかった）。
 *
 * - `permission`: 許可の問題。同じ操作を繰り返しても結果は変わらない
 * - `rate_limit`: 呼び出し過多。時間を置けば復帰しうる
 * - `temporary`: 相手側の一時障害。再試行が正しい対応
 * - `other`: 上記に当てはまらない（入力エラー・パースエラー・分類できない例外）
 */
export type ApiErrorKind = 'permission' | 'rate_limit' | 'temporary' | 'other';

/** 相手側の一時障害とみなす HTTP ステータス。429 は `rate_limit` として別に扱う。 */
const TEMPORARY_STATUSES: ReadonlySet<number> = new Set([500, 502, 503, 504]);

function fromStatus(status: number): ApiErrorKind {
  if (status === 429) return 'rate_limit';
  if (TEMPORARY_STATUSES.has(status)) return 'temporary';
  return 'other';
}

/**
 * 例外を {@link ApiErrorKind} に分類する。判別できない例外は `other`。
 *
 * `permission` の判定は Google API にだけ適用する。`drive.file` スコープでは未選択の
 * スプレッドシートが 403 とは限らず 404 でも返るため、{@link isAccessDeniedStatus} の
 * 両方を含める（削除済み・ID 誤りでも 404 になるので、文言は断定しないこと）。
 * LLM の 403 は多くが API キーの誤りで、共有設定の話ではないため `other` に落とす。
 */
export function classifyApiError(err: unknown): ApiErrorKind {
  if (err instanceof GoogleApiError) {
    return isAccessDeniedStatus(err.status) ? 'permission' : fromStatus(err.status);
  }
  if (err instanceof EutilsError) {
    // 恒久エラー（構文エラー等の in-band エラー）は再試行しても解消しない。
    return err.permanent ? 'other' : fromStatus(err.status);
  }
  if (err instanceof LlmProviderError) {
    return err.status === null ? 'other' : fromStatus(err.status);
  }
  return 'other';
}
