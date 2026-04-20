/**
 * 画面間で共有する軽量な表示フォーマッタ。
 * 現状は top-bar / home view で使う「FormulaVersions.version_id の短縮表示」のみ。
 */

const FORMULA_VERSION_SHORT_LENGTH = 8;

/**
 * `FormulaVersions.version_id`（UUID v4 想定）を頭 8 桁に短縮して返す。
 * null / 空文字 / 8 文字以下の値はそのままの入力でバイパスし、
 * 呼び出し側で「表示対象なし」と判定しやすいように null を返す。
 */
export function formatFormulaVersionShort(versionId: string | null): string | null {
  if (versionId === null) {
    return null;
  }
  const trimmed = versionId.trim();
  if (trimmed === '') {
    return null;
  }
  if (trimmed.length <= FORMULA_VERSION_SHORT_LENGTH) {
    return trimmed;
  }
  return trimmed.slice(0, FORMULA_VERSION_SHORT_LENGTH);
}
