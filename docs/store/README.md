# Chrome ウェブストア 提出物一式（docs/store/）

Chrome Web Store 提出フェーズ1（manifest / アイコン配線 / 提出物ドキュメント整備）の成果物置き場。**まだストアには提出していない**（本フェーズの範囲外）。

## このフォルダの中身

| ファイル | 用途 | 状態 |
|---|---|---|
| [privacy-policy.md](privacy-policy.md) | プライバシーポリシー（審査必須。公開 URL が要る → 下記参照） | 原稿完成 |
| [permissions-justification.md](permissions-justification.md) | 各権限の使用理由（審査フォームへ貼り付け。日英併記） | 原稿完成 |

## ストア掲載メタ情報（登録フォームへ入力予定）

- **名称**: SR Query Builder Plugin（確定）
  - 出典: [src/_locales/ja/messages.json](../../src/_locales/ja/messages.json) の `extName`。en 側も同じ値。
- **概要（日本語）**: 研究プロトコルから PubMed 検索式を生成・検証し、各データベース向けに変換する Chrome 拡張
  - 出典: [src/_locales/ja/messages.json](../../src/_locales/ja/messages.json) の `extDescription`。
- **カテゴリ**: 仕事効率化（Productivity）
- **言語**: 日本語（`default_locale: "ja"`）
- **公開範囲**: **一般公開（public）**（確定）— ストア検索・リンクのどちらからでも誰でもインストールできる。同シリーズの sr-data-extraction-plugin と同じ方針
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
- [x] 提出用 zip の作成・検証ツール整備（[tools/release/](../../tools/release/)。`npm run release` / `npm run pack:release`）
- [ ] スクリーンショット取得
- [ ] クリーンな Chrome プロファイルでの実 Google 認証つき dist smoke
- [ ] Chrome ウェブストア デベロッパーアカウントで提出
- [ ] 審査通過・一般公開

## manifest レビュー結果

[src/manifest.json](../../src/manifest.json) に対して本フェーズ（フェーズ1）で行った変更点。

- **`icons` / `action.default_icon` を追加**: `16` / `48` / `128` の 3 サイズ（[src/icons/](../../src/icons/)）。Chrome ウェブストアはストアアイコン（128×128）と拡張機能アイコンの配線を要求するため。webpack の CopyPlugin（[webpack.config.js](../../webpack.config.js)）に `src/icons` → `dist/icons` のコピー設定を追加し、dev / production 両ビルドで反映されるようにした。
- **`oauth2.scopes` を `https://www.googleapis.com/auth/drive.file` の 1 本に変更**（`https://www.googleapis.com/auth/spreadsheets` を削除）: センシティブスコープ（`spreadsheets` 等）を含むアプリを Production（一般公開）で運用するには Google の OAuth 検証（app verification）を通す必要があり、検証を通さないまま Production に出すと「確認されていないアプリ」の警告が出たうえ利用者 100 人で打ち止めになる（tiab-review-plugin が実際にこの上限に到達した実績がある）。一方 `drive.file` は非センシティブ（推奨）スコープのため、これ 1 本に絞れば OAuth 検証そのものが不要になり利用者数の上限も付かない。Sheets API v4 は `drive.file` を正式な認可スコープとして受理する（公式ドキュメントに明記）ため、本拡張は Sheets の読み書きも `drive.file`（利用者が選択した/拡張が作成したファイルのみへのアクセス）で機能上の損失なく行える。
- **`permissions` から `"tabs"` を削除**: メインビューは `chrome.tabs.create({ url: chrome.runtime.getURL('app.html') })` で開いており、これは `"tabs"` permission が無くても動作する（`"tabs"` は他タブの URL / title / favicon など機微情報を読み取る場合にのみ必要）。typecheck / test / lint / dev / test:e2e のすべてが通ることを確認した上で削除した。

## `key.pem` の扱い（確定事項）

拡張 ID は現行の **`bckokafmjighegpjiocopkagghppnjld`** を維持できる。production ビルド（`npm run build`）は manifest から `key` フィールドを削除する（Chrome ウェブストアは manifest に `key` があるとアップロードを拒否するため）が、**初回ストアアップロード時だけ**、対応する秘密鍵を `key.pem` として zip ルートに同梱すれば、Store がその `key.pem` から同じ拡張 ID を導出する。したがって、ストア用に別の OAuth client_id を新規発行する必要はなく、既存の `client_id`（アルファ配布と共通）がそのまま使える。秘密鍵の実体はリポジトリ外で管理し、コミットしないこと。2 回目以降の更新 zip には `key.pem` は不要（ID はストアのアイテムに固定される）。

## 既知のリスク・要検証

`oauth2.scopes` を `drive.file` 1 本へ縮小したことに伴い、本フェーズでは未解決で、実機確認または後続フェーズで対応が必要な事項が 2 点ある。

1. **既存プロジェクトへの影響（要実機検証）**: 旧スコープ（`spreadsheets`）を持った状態で作成された既存のスプレッドシート（アルファ配布中のテスターが作成済みのもの）に対し、`drive.file` のファイル単位のアクセス付与が引き継がれるかは未検証。引き継がれない場合、既存プロジェクトを開くと 403 になり得るため、実機（実 Google 認証）での確認が必要。403 になる場合は移行導線（下記の Picker、またはプロジェクト再作成）が要る。
2. **「スプレッドシート ID から開く」の制約**: `drive.file` は「本拡張が作成したファイル + 利用者が Picker で明示的に選択したファイル」に限られるため、popup の「スプレッドシート ID から開く」導線（[src/popup/bootstrap.ts](../../src/popup/bootstrap.ts)）は、他人が作成した共有スプレッドシートに対しては 403 になる。後続フェーズで Google Picker を移植して解消する予定（同シリーズの sr-data-extraction-plugin が `hosted/picker.html` を GitHub Pages に置き `externally_connectable` で拡張と通信する方式で実装済み。これを移植する）。
