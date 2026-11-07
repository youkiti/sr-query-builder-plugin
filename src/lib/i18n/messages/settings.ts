// settingsView.ts の文言を置く。
export const settingsJa = {
  "settings.language": "表示言語",
  "settings.languageDescription": "画面の文言の言語を切り替えます。AI に送る指示と Sheets に保存する値は変わりません。",
  "settings.languageJa": "日本語",
  "settings.languageEn": "English",
} as const;

export const settingsEn: Record<keyof typeof settingsJa, string> = {
  "settings.language": "Display language",
  "settings.languageDescription": "Changes the language of the screens. Instructions sent to the AI and values saved to Sheets do not change.",
  "settings.languageJa": "日本語",
  "settings.languageEn": "English",
};
