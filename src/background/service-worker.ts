/**
 * MV3 Service Worker（起動フックのみ）。
 * インストール時・起動時のログ出力程度に留め、実処理は別モジュールで実装する。
 */

chrome.runtime.onInstalled.addListener((details) => {
  console.warn(`[sr-query-builder] installed: ${details.reason}`);
});
