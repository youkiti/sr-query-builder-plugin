# UI 状態マトリクス

- **作成日**: 2026-04-20
- **位置付け**: [docs/ui-review-strategy.md](ui-review-strategy.md) §3 Tier 1。各画面 × 各状態 × 受入基準を網羅し、目視レビューと AI レビュー（Claude / Codex 等）の共通スペックとする。
- **使い方**: 新規画面・新規状態を実装したら、必ずこの spec に状態を追加してから着手する。AI にレビューを頼むときは「`docs/ui-states.md` の状態 X が満たされているか」を依頼の起点にする。
- **更新ルール**: 表示／非表示・ステータス文言・`hidden` 属性の真偽は **画面ごとの章で 1 行 1 状態** にし、後続の Playwright (Tier 2) で `expect(locator).toBeVisible()` / `toBeHidden()` の根拠として参照する。

## 0. 共通レイヤ

すべての画面で以下を満たすこと。

- `[hidden]` 属性が付いた要素は **画面に出ない**。これは [src/styles/globals.css](../src/styles/globals.css) の `[hidden] { display: none !important }` で固定されている。新規 CSS が `display:` を直書きする場合、stylelint が警告するので Tier 0 のルールに従う。
- `chrome.*` API が未注入の状態でも HTML 単体が読める（Playwright でローカル `file://` 読込み + `addInitScript` で `chrome` を差し替える前提）。
- ステータス領域（`#popup-status` / `#options-status` / `#app-status`）は **空文字にしない**。空のまま残すとユーザーが何待ちか分からない。

---

## 1. Popup (`src/popup/popup.html`)

ポップアップは「未ログイン」「ログイン済」の 2 状態。プロジェクト選択は常にログイン済の中。

### 状態 A: 未ログイン

- **可視**: `#popup-status` / `#popup-auth`（説明文 + Google ログインボタン）/ `#open-options`
- **不可視 (`hidden=true`)**: `#popup-projects`
- **`hidden` 属性**: `#popup-auth` → `false`, `#popup-projects` → `true`
- **ステータス文言**: `ログインが必要です。`
- **入力可能要素**: `#login-button`, `#open-options`
- **回帰観点**: `#login-button` と `#popup-recent` のボタンが**同時に画面に出ない**こと（過去の specificity バグ）

### 状態 B-0: ログイン済 / 最近のプロジェクト 0 件

- **可視**: `#popup-status`, `#popup-projects` 配下：`#popup-account`（email + ログアウト）/ 新規作成フォーム / 既存 ID で開くフォーム / `#open-options`
- **不可視**: `#popup-auth`, `#popup-recent-section`
- **`hidden` 属性**: `#popup-auth` → `true`, `#popup-projects` → `false`, `#popup-recent-section` → `true`
- **ステータス文言**: `新しいプロジェクトを作成するか、スプレッドシート ID から開いてください。`
- **`#popup-email`**: 取得成功時はログイン中の email、失敗時は `(不明)`
- **入力可能要素**: `#popup-create-title`, `#popup-create-form button[type=submit]`, `#popup-open-id`, `#popup-open-form button[type=submit]`, `#logout-button`, `#open-options`

### 状態 B-N: ログイン済 / 最近のプロジェクト N 件 (1 ≤ N ≤ 5)

- **可視**: 状態 B-0 のすべて + `#popup-recent-section`（`#popup-recent` に N 個の `<li><button>`）
- **`hidden` 属性**: `#popup-recent-section` → `false`
- **ステータス文言**: `最近のプロジェクトから選ぶか、新しく作成してください。`
- **回帰観点**: ボタン押下で `currentProject` が当該プロジェクトに更新され、メインビュータブが 1 回開く

### 状態 C: ログイン処理中

- **直前**: 状態 A
- **遷移**: `#login-button` クリック直後 → `#login-button.disabled = true`、`#login-error` は空、Google 認可ウィンドウが開く前提
- **遷移後**: `signIn()` の結果で状態 A（失敗）または 状態 B-* （成功）

### 状態 D: ログイン失敗（再表示）

- **可視/不可視**: 状態 A と同じ
- **`#login-error`**: `ログインに失敗しました。ブラウザに Google アカウントが追加されているか確認してください。`
- **`#login-button.disabled`**: `false` に戻り再操作可能

### エッジ

| ID | 入力例 | 期待される挙動 |
|---|---|---|
| E-Popup-1 | `#popup-create-title` が空のまま submit | `#popup-create-error` に「タイトルが必須」系メッセージ。メインビュータブは開かない |
| E-Popup-2 | `#popup-open-id` に存在しないシート ID | `#popup-open-error` に Meta タブ未検出メッセージ。タブは開かない |
| E-Popup-3 | プロジェクトタイトル 100 文字 | 横スクロール禁止。折返しか省略どちらでも良いが、`#open-options` ボタンに被ってはいけない |
| E-Popup-4 | `signOut()` 中に再クリック | `#logout-button.disabled` が一時的に `true`、完了後 `false` に戻る |

---

## 2. Options (`src/options/options.html`)

設定画面は単一状態。BYOK のキー入力のみ。

### 状態 A: 通常表示

- **可視**: `.options__section` 全部 / `#gemini-api-key` / `#ncbi-api-key` / `#save-keys`
- **`#options-status`**: 起動時 `読み込み中…`、`chrome.storage.local` 読込完了後は **保存済キーがあれば** マスク表示メッセージ、無ければ案内文
- **`type="password"`**: 両 input が必ず password 型（`autocomplete="off"`）
- **回帰観点**: `Gemini API Key` が空のまま「保存」してもクラッシュしない

### 状態 B: 保存実行中 / 完了

- **遷移**: `#save-keys` クリック → 一時的に disabled → 保存後に `#options-status` を成功メッセージに更新
- **エラー**: `chrome.storage.local.set` が失敗したら `#options-status` を赤系（`.options__error` クラス相当）にし、ボタンは押し直せる

### エッジ

| ID | 入力例 | 期待される挙動 |
|---|---|---|
| E-Opt-1 | API Key に空白文字を含む長文 | `trim()` した上で保存。空文字保存はしない |
| E-Opt-2 | NCBI Key だけ未入力 | OK。Gemini Key のみ保存される |

---

## 3. App / メインビュー (`src/app/app.html`)

ハッシュルートで切り替わる。ルートは [src/app/router.ts](../src/app/router.ts) の `ROUTES` を正典とする。

共通レイアウト:

- `header.app__header`: タイトル + `#app-status` + `#app-context`（aria-live=polite）
- `aside.app__sidebar > nav.app__nav`: SIDEBAR_ROUTES の各リンク
- `section#app-content`: 現在のビューがここに描画される

### 状態 A: プロジェクト未選択（不正アクセス）

- **遷移条件**: `chrome.storage.local.currentProject` が無い状態で `app.html` を直接開いた
- **可視**: `#app-status` にプロジェクト未選択を示すメッセージ。`#app-content` はガード経由で「ホームに戻る」案内
- **回帰観点**: タブが落ちず、ポップアップに戻る導線が必ず 1 つ以上ある

### 状態 B: ホーム (`#/home`)

- **可視**: `home` ビュー（プロジェクトメタ情報・最終更新日時・ナビ説明）
- **サイドバー**: 全 10 項目がレンダリングされる。`home` 自体はサイドバーに含めない（`SIDEBAR_ROUTES`）

### 状態 C: 各ステップ（protocol / blocks / seeds / draft / validate / expand / edit / export / done / history）

| ルート | 主な可視要素 | エッジ |
|---|---|---|
| `#/protocol` | 手入力タブ / `protocol.md` アップロード / `.docx` アップロードの 3 ソース選択。組入除外基準入力 | docx パース失敗で UI が固まらない |
| `#/blocks` | LLM 抽出のブロック候補一覧。承認 / 編集ボタン | 0 ブロックでも空状態 UI を出す |
| `#/seeds` | PMID リスト + include/exclude/maybe ボタン + interactive 拡張ログ | 0 件と N 件で見た目が分岐する |
| `#/draft` | LLM ドラフト検索式の表示 + 再生成ボタン | エラー時はスケルトンを残しエラーメッセージを別領域に出す |
| `#/validate` | 行ごとヒット数 / 捕捉率 / missed PMIDs | 結果待ちはスピナ、失敗時はリトライボタン |
| `#/expand` | 境界事例論文の対話判定 UI | 0 件のときは「再検証可能」案内のみ |
| `#/edit` | 検索式編集（diff 表示） | diff ペインが空でも縦スクロールが出ない |
| `#/export` | 各 DB 変換結果（CENTRAL / Embase(Dialog) / ClinicalTrials.gov / ICTRP）+ コピー / DL ボタン | 1 つも変換結果が無い時は完了ボタンを出さない |
| `#/done` | PubMed nbib DL 案内 + 次ステップ（tiab-review-plugin への引き継ぎ） | 「もう一度エクスポート」リンクで `#/export` に戻る |
| `#/history` | FormulaVersions の一覧 | 0 件のとき「まだバージョンがありません」を出す |

すべての状態で、サイドバーから別ルートへ遷移しても `#app-status` のラベルが正しく更新される（aria-live=polite）。

---

## 4. キーボードショートカット

`docs/ui-flow.md` で定義された i / e / m を含むキー操作は、対応するビューがアクティブな時のみ反応する。Tier 2 で `page.keyboard.press('i')` 等の基本確認を行う。

---

## 5. レビュー時のチェックリスト（人 + AI 共通）

新しい画面 PR をレビューする時は次の順で見る:

1. 該当画面の章をこの spec から探す
2. 状態 ID（例: B-N）を 1 つずつ手元 / Playwright で再現できるか確認
3. 「`hidden` 属性のもの」が本当に**画面に見えていない**か確認（DOM 属性ではなく **bounding box** または `getComputedStyle().display !== 'none'` で見る）
4. ステータス文言・エラーメッセージの文字列がここに書いてある通りか
5. アクセシビリティは Tier 3 axe で自動検出するが、`aria-live` / `<label for>` の書き忘れだけは目視でも見る

不一致を見つけたら、まずこの spec が正しいかを疑い、両者を一緒に直す。
