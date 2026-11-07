// historyView.ts の文言を置く。
export const historyJa = {
  "history.noProject": "先にプロジェクトを選択してください。",
  "history.loading": "履歴を読み込み中…",
  "history.empty": "まだバージョンが登録されていません。",
  "history.found": "{count} 件のバージョンが見つかりました。",
  "history.active": "読み込み中",
  "history.load": "このバージョンを読み込む",
} as const;

export const historyEn: Record<keyof typeof historyJa, string> = {
  "history.noProject": "Select a project first.",
  "history.loading": "Loading version history…",
  "history.empty": "No versions have been saved yet.",
  "history.found": "Versions found: {count}.",
  "history.active": "Currently loaded",
  "history.load": "Load this version",
};
