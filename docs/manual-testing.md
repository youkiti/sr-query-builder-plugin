# 実機確認手順（Selenium 半自動ハーネス）

- **位置付け**: jest（jsdom）+ Playwright（LLM / Google / NCBI をすべて stub）ではカバーできない
  「本物の Chrome 拡張ランタイム + 本物の Google / Gemini / NCBI API」の結合部を、実機で通し確認するためのチェックリスト。
- **実体**: [tools/selenium/manualCheck.mjs](../tools/selenium/manualCheck.mjs)。操作・検証を自動化し、
  人にしかできない **Google ログイン / OAuth 同意 / API キー入力** の 3 箇所だけコンソールで一時停止する。
  CI では実行しない（`npm run manual:check`）。
- **使い方**: 該当シーンを実行 → 出力の ✔ / ✘ を確認 → NG があれば「結果メモ」に症状を書き残す。

## 0. 前提準備（初回のみ）

### 0-1. ビルドと拡張の読み込み

```bash
# .env に OAuth クライアント ID を設定（LOCAL / dev 用）
npm install            # selenium-webdriver を含む
npm run dev            # dist/ を生成（dist/manifest.json の client_id が実値であること）
npm run manual:check -- prepare   # 専用プロファイルの Chrome が開く
```

`prepare` で開いた Chrome で:

1. `chrome://extensions` の「デベロッパーモード」を ON
2. 「パッケージ化されていない拡張機能を読み込む」で `dist/` を選択
3. 別タブで <https://accounts.google.com> を開き、確認用 Google アカウントにログイン
   （OAuth 同意画面が Testing の場合はテストユーザー登録済みのアカウント）

- Chrome 137+ は `--load-extension` が使えないため、専用プロファイル（`.selenium-profile/`。gitignore 済み）に
  **一度だけ手動で dist/ を読み込む**。以後の実行はこのプロファイルを再利用するので再読込は不要
  （`npm run dev` し直しても同じフォルダを指すため、`chrome://extensions` の「更新」だけでよい）。
- 拡張 ID は manifest.json の `key` から決定的に導出され **`bckokafmjighegpjiocopkagghppnjld`**。
  ハーネスが起動時に表示するので、GCP の OAuth クライアント設定との一致確認に使う。

### 0-2. Gemini API キー / NCBI API キー

`options` シーンで Options 画面の入力を促す（キー本体はログに出さない）。事前に手で入れておいても可。

## 1. シーン一覧

```bash
# 既定（happy path 通し）: login → project → options → protocol → blocks → draft → export
npm run manual:check

# 個別 / 部分実行
npm run manual:check -- export                     # Methods 文案 + 4DB 変換だけ
npm run manual:check -- export modelswitch editmodel   # PR #19 の肝を集中確認
npm run manual:check -- draft export --keep        # 失敗しなくても終了時にブラウザを残す
```

| シーン | 内容 | 対応する手動確認手順（PR #19） |
|---|---|---|
| `prepare` | 専用プロファイルへ拡張を手動読込 + Google ログイン（初回のみ） | — |
| `login` | Popup ログイン（OAuth 同意は手動） | — |
| `project` | 新規プロジェクト作成（Sheets タブ + Drive フォルダ）→ メインビュー表示 | — |
| `options` | Gemini API キー保存 + 使用モデル確認 | — |
| `protocol` | サンプルプロトコル手入力 → `extract-protocol`（LLM）でブロック抽出 | — |
| `blocks` | 抽出ブロックの承認 | — |
| `draft` | 「生成して検証する」→ ブロック展開（LLM）+ ヒット数（NCBI）+ 捕捉率検証 | — |
| `export` | **Methods 文案にモデル ID + version が埋まる / コピー成功** | 手順1・手順2 |
| `reload` | export を再読み込み → モデル ID が Sheets（FormulaVersions.model）から復元される | 手順3 |
| `modelswitch` | Options でモデル変更 → 文案は**生成時のまま**（切替後にならない） | **手順4（肝）** |
| `editmodel` | `#/edit` で手編集して保存 → モデル ID が元ドラフトのまま引き継がれる | 手順5 |

### 目視でのみ確認する項目

ハーネスは DOM 上の検証までを自動化する。以下は Sheets / 別データを直接見て確認する:

- **手順6（旧プロジェクト）**: `model` 列導入前のシートを開くと文案に `{AI model}` が残り、note に置換案内が出る。
  `export` シーンには `--legacy` 相当の自動判定は入れていないため、旧シートを開いた状態で
  `npm run manual:check -- export` を回し、出力の note / プレースホルダの文言を目視で照合する。
- **手順7（FormulaVersions タブ）**: スプレッドシートの `FormulaVersions` タブで、新しい行の末尾に `model` 値が入り、
  旧行はそのまま（空欄）であることを確認する。

## 2. 手動チェックリスト（PR #19: Methods 文案）

| # | シーン | 操作 → 期待結果 | OK |
|---|---|---|---|
| 1 | `export` | `#/draft` 生成後に `#/export` で「Methods 用の文案」が出て、英語文に実モデル ID `(gemini-…)` と `version 0.1.0` が埋まる（`{AI model}` が残らない） | [ ] |
| 2 | `export` | 「英語版をコピー」「日本語版をコピー」で「〜の文案をコピーしました。」→ エディタに全文貼付できる | [ ] |
| 3 | `reload` | タブ再読み込み後もモデル ID が消えず残る（Sheets から復元） | [ ] |
| 4 | `modelswitch` | Options でモデルを切替えても文案のモデル ID は生成時のまま | [ ] |
| 5 | `editmodel` | `#/edit` で手編集保存後もモデル ID が元ドラフトのまま引き継がれる | [ ] |
| 6 | 目視 | 旧プロジェクト（model 列導入前）: 文案に `{AI model}` + note に置換案内 | [ ] |
| 7 | 目視 | `FormulaVersions` タブ: 新規行の末尾に model 値、旧行はそのまま | [ ] |

## 3. トラブルシューティング

| 症状 | 見るところ |
|---|---|
| ログインが `bad client id` 系で失敗 | 拡張 ID（0-1）と GCP の OAuth クライアント設定の一致。同意画面のテストユーザー登録 |
| `dist/manifest.json の client_id が未設定` で即終了 | `.env` の `OAUTH_CLIENT_ID` を設定して `npm run dev` し直す |
| ガード状態のプレースホルダで止まる | 前段シーンが未実行（例: `export` の前に `draft`）。順に実行するか既定通しで回す |
| クリップボード読み取りが取れない | 権限依存。UI の「コピーしました」メッセージで代替確認（ハーネスも fallback 済み） |
| 拡張が読み込まれていない | `.selenium-profile/` の Chrome で `chrome://extensions` から dist/ を再読込 → 「更新」 |

## 4. 結果メモ

| 日付 | 実施者 | 範囲 | 結果 / 症状 |
|---|---|---|---|
| | | | |
