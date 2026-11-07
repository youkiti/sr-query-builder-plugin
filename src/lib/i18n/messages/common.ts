// hydrateErrorBanner.ts、formatHelpers.ts の文言を置く。
export const commonJa = {
  "common.hydrateError": "プロジェクトデータの読み込みに失敗しました: {message}",
  "common.hydrateHint": "保存済みのプロトコル・検索式が表示されていない可能性があります。再試行してください。共有されたスプレッドシートの場合は、拡張機能のポップアップにある「スプレッドシート ID で開く」からやり直すと、Google での許可の案内が表示されます。",
  "common.retry": "再試行",
} as const;

export const commonEn: Record<keyof typeof commonJa, string> = {
  "common.hydrateError": "Could not load project data: {message}",
  "common.hydrateHint": "Your saved protocol and formula may be missing from this screen. Try again. For a shared spreadsheet, use “Open by spreadsheet ID” in the extension popup to grant access through Google.",
  "common.retry": "Try again",
};
