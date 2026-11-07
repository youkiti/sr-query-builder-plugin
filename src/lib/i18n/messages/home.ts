// homeView.ts の文言を置く。
export const homeJa = {
  "home.noProject": "プロジェクトが選択されていません。Popup から作成または選択してください。",
  "home.start": "最初に Popup でプロジェクトを選択すると、プロトコル入力から開始できます。",
  "home.overview": "この画面は概要のみです。作業は左の「プロトコル入力」から始めてください。",
  "home.versions": "現在採番済みのバージョン概要です。",
  "home.switch": "別のプロジェクトを開く…",
  "home.switchTitle": "Popup（プロジェクト選択画面）を新しいタブで開きます",
  "home.protocolVersion": "Protocol version",
  "home.formulaVersion": "Formula version",
  "home.project": "現在のプロジェクト: {title} ({id})",
  "home.title": "ホーム",
} as const;

export const homeEn: Record<keyof typeof homeJa, string> = {
  "home.noProject": "No project selected. Create or select one in the popup.",
  "home.start": "Select a project in the popup to start entering your protocol.",
  "home.overview": "This screen shows an overview. Start with Protocol input on the left.",
  "home.versions": "Overview of the current saved versions.",
  "home.switch": "Open another project…",
  "home.switchTitle": "Open the project selection popup in a new tab",
  "home.protocolVersion": "Protocol version",
  "home.formulaVersion": "Formula version",
  "home.project": "Current project: {title} ({id})",
  "home.title": "Home",
};
