/**
 * 現在時刻を ISO 8601 文字列で返す。
 * Sheets に書き込む `created_at` 等で使用。
 */
export function nowIso(date: Date = new Date()): string {
  return date.toISOString();
}

/**
 * ISO 8601 文字列が妥当かを判定する（`Date.parse` 経由）。
 */
export function isValidIso(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0) {
    return false;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return false;
  }
  // ラウンドトリップで元文字列と一致することを確認する（空白や不正フォーマットの排除）
  return new Date(parsed).toISOString() === value;
}
