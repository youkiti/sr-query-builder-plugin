# Chrome ウェブストア 提出物一式（docs/store/）

Chrome Web Store 提出フェーズ1（manifest / アイコン配線 / 提出物ドキュメント整備）の成果物置き場。**まだストアには提出していない**（本フェーズの範囲外）。

## このフォルダの中身

| ファイル | 用途 | 状態 |
|---|---|---|
| [privacy-policy.md](privacy-policy.md) | プライバシーポリシー（審査必須。公開 URL が要る → 下記参照） | 原稿完成 |
| [permissions-justification.md](permissions-justification.md) | 各権限の使用理由（審査フォームへ貼り付け。日英併記） | 原稿完成 |

## ストア掲載メタ情報（登録フォームへ入力予定）

- **名称**: SR Query Builder
  - 出典: [src/_locales/ja/messages.json](../../src/_locales/ja/messages.json) の `extName`。
  - **注記**: 未マージのブランチ `test/pr19-verify` に拡張名を「SR Query Builder Plugin」へ変更するコミットがある。マージ後は `extName` の値を再確認し、本ドキュメントの名称もそれに追随させること。
- **概要（日本語）**: 研究プロトコルから PubMed 検索式を生成・検証し、各データベース向けに変換する Chrome 拡張
  - 出典: [src/_locales/ja/messages.json](../../src/_locales/ja/messages.json) の `extDescription`。
- **カテゴリ**: 仕事効率化（Productivity）
- **言語**: 日本語（`default_locale: "ja"`）
- **公開範囲**: 未定（本フェーズでは決定しない。後続フェーズでユーザーと合意の上で決定する）
- **プライバシーポリシー URL**: `https://youkiti.github.io/sr-query-builder-plugin/privacy-policy.html`（想定 URL。**未公開・予定** — GitHub Pages でのホスティングは後続フェーズで実施する）
- **ウェブサイト**: `https://youkiti.github.io/sr-query-builder-plugin/`（想定 URL。**未公開・予定**）

## 必要な画像

Chrome ウェブストアの掲載に必要な画像。スクリーンショットは実データを含めないこと（テスト用プロジェクトで撮影する）。

| 画像 | 仕様 | 状態 |
|---|---|---|
| ストアアイコン | 128×128 PNG | 済 — [src/icons/icon128.png](../../src/icons/icon128.png) を使用可 |
| スクリーンショット | 1280×800、最低 1 枚（最大 5 枚） | 未取得 |
| 小型プロモタイル（任意） | 440×280 PNG | 任意・未設定 |

## 提出前チェック（本フェーズの実施状況）

- [x] manifest の permissions / OAuth スコープを見直し、`icons` / `action.default_icon` を配線（→ [manifest レビュー結果](#manifest-レビュー結果)）
- [x] プライバシーポリシー原稿
- [x] 権限の使用理由原稿（日英）
- [ ] スクリーンショット取得
- [ ] クリーンな Chrome プロファイルでの実 Google 認証つき dist smoke
- [ ] Chrome ウェブストア デベロッパーアカウントで提出
- [ ] 審査通過・一般公開

## manifest レビュー結果

[src/manifest.json](../../src/manifest.json) に対して本フェーズ（フェーズ1）で行った変更点。

- **`icons` / `action.default_icon` を追加**: `16` / `48` / `128` の 3 サイズ（[src/icons/](../../src/icons/)）。Chrome ウェブストアはストアアイコン（128×128）と拡張機能アイコンの配線を要求するため。webpack の CopyPlugin（[webpack.config.js](../../webpack.config.js)）に `src/icons` → `dist/icons` のコピー設定を追加し、dev / production 両ビルドで反映されるようにした。
- **`oauth2.scopes` を `https://www.googleapis.com/auth/drive.file` の 1 本に変更**（`https://www.googleapis.com/auth/spreadsheets` を削除）: `spreadsheets` はセンシティブスコープに分類され、OAuth 同意画面が Testing 状態の間は登録テストユーザー 100 人までしか使えない（tiab-review-plugin で実際にこの上限に到達した実績がある）。本拡張は Sheets の読み書きも `drive.file`（利用者が選択した/拡張が作成したファイルのみへのアクセス）で行えるため、より狭いスコープへ寄せた。
- **`permissions` から `"tabs"` を削除**: メインビューは `chrome.tabs.create({ url: chrome.runtime.getURL('app.html') })` で開いており、これは `"tabs"` permission が無くても動作する（`"tabs"` は他タブの URL / title / favicon など機微情報を読み取る場合にのみ必要）。typecheck / test / lint / dev / test:e2e のすべてが通ることを確認した上で削除した。

## `key.pem` の扱い（確定事項）

拡張 ID は現行の **`bckokafmjighegpjiocopkagghppnjld`** を維持できる。production ビルド（`npm run build`）は manifest から `key` フィールドを削除する（Chrome ウェブストアは manifest に `key` があるとアップロードを拒否するため）が、**初回ストアアップロード時だけ**、対応する秘密鍵を `key.pem` として zip ルートに同梱すれば、Store がその `key.pem` から同じ拡張 ID を導出する。したがって、ストア用に別の OAuth client_id を新規発行する必要はなく、既存の `client_id`（アルファ配布と共通）がそのまま使える。秘密鍵の実体はリポジトリ外で管理し、コミットしないこと。2 回目以降の更新 zip には `key.pem` は不要（ID はストアのアイテムに固定される）。
