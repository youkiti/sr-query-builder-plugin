// doneView.ts の文言を置く。
export const doneJa = {
  "done.centralLink": "Cochrane CENTRAL で開く",
  "done.centralNote": "Advanced search → 変換後の検索式を貼り付け",
  "done.dialogLink": "Embase (Dialog) で開く",
  "done.dialogNote": "契約機関のアカウントでログイン → Advanced Search に変換後の検索式（S1〜）を 1 行ずつ入力",
  "done.clinicaltrialsLink": "ClinicalTrials.gov で開く",
  "done.clinicaltrialsNote": "Condition / Intervention / Other Terms に変換後のキーワードを分けて入力",
  "done.ictrpLink": "ICTRP で開く",
  "done.ictrpNote": "Basic search に変換後のキーワードを貼り付け（自由語のみ対応）",
  "done.noProject": "先にプロジェクトを選択してください。",
  "done.noFormula": "先に /draft で検索式を生成してください。",
  "done.lead": "検索式の開発が完了しました。各データベースで検索を実行して、結果を nbib / RIS 形式でダウンロードしてください。",
  "done.downloadNote": "PubMed は「Send to → Citation manager → PubMed format (NBIB)」、CT.gov / ICTRP は各画面の XML / CSV から書き出せます。",
  "done.pubmedLink": "PubMed で直接開く: ",
} as const;

export const doneEn: Record<keyof typeof doneJa, string> = {
  "done.centralLink": "Open Cochrane CENTRAL",
  "done.centralNote": "Advanced search → Paste the converted search formula",
  "done.dialogLink": "Open Embase (Dialog)",
  "done.dialogNote": "Sign in with your institutional account → Enter each converted line (S1 onward) in Advanced Search",
  "done.clinicaltrialsLink": "Open ClinicalTrials.gov",
  "done.clinicaltrialsNote": "Enter the converted keywords in Condition / Intervention / Other Terms as appropriate",
  "done.ictrpLink": "Open ICTRP",
  "done.ictrpNote": "Paste the converted keywords into Basic search (free-text terms only)",
  "done.noProject": "Select a project first.",
  "done.noFormula": "Generate a search formula in /draft first.",
  "done.lead": "Your search formula is ready. Run it in each database and download the results in nbib / RIS format.",
  "done.downloadNote": "For PubMed, use “Send to → Citation manager → PubMed format (NBIB)”. For CT.gov / ICTRP, export XML / CSV from each site.",
  "done.pubmedLink": "Open directly in PubMed: ",
};
