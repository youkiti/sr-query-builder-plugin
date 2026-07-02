/**
 * 起動時 hydrate（Sheets からの状態復元）失敗のエラーバナー（fix-plan 1-3）。
 * home / protocol で共用する。Sheets の一時障害が「空プロジェクト」に見えないよう、
 * 失敗を明示して再試行ボタンを出す。
 */
export function buildHydrateErrorBanner(
  doc: Document,
  message: string,
  onRetry?: () => void
): HTMLElement {
  const banner = doc.createElement('div');
  banner.className = 'view__hydrate-error';
  banner.setAttribute('role', 'alert');

  const text = doc.createElement('p');
  text.className = 'view__hydrate-error-message';
  text.textContent = `プロジェクトデータの読み込みに失敗しました: ${message}`;
  banner.appendChild(text);

  const hint = doc.createElement('p');
  hint.className = 'view__hydrate-error-hint';
  hint.textContent =
    '保存済みのプロトコル・検索式が表示されていない可能性があります。再試行してください。';
  banner.appendChild(hint);

  if (onRetry) {
    const retryBtn = doc.createElement('button');
    retryBtn.type = 'button';
    retryBtn.className = 'view__hydrate-error-retry';
    retryBtn.textContent = '再試行';
    retryBtn.addEventListener('click', () => {
      retryBtn.disabled = true;
      onRetry();
    });
    banner.appendChild(retryBtn);
  }

  return banner;
}
