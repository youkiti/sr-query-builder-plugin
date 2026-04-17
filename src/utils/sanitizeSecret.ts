/**
 * API キーやアクセストークンなどのシークレットをログ出力用に短縮する。
 *
 * - null / undefined / 空文字は `(empty)` を返す
 * - 12 文字未満の値は `(too-short)` を返す（マスク目的を達成できないため）
 * - それ以上の長さの値は先頭 8 文字 + `...` を返す
 *
 * 呼び出し側は本関数の戻り値を直接ログに出して OK。元の値は絶対にログ出力しないこと。
 */
export function sanitizeSecret(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') {
    return '(empty)';
  }
  if (value.length < 12) {
    return '(too-short)';
  }
  return `${value.slice(0, 8)}...`;
}
