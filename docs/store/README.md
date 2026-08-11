# Chrome ウェブストア 提出物一式（docs/store/）

Chrome Web Store 提出物ドキュメント（manifest / アイコン配線 / プライバシーポリシー / 掲載文言など）の置き場。当初はフェーズ1（初回提出）の成果物置き場として作られたが、**公開後は更新提出のたびに参照する運用ドキュメント**になっている。

**v0.2.0 が 2026-08-10 に公開され、続いて v0.3.0 が審査を通過し、現在の配信版として公開中**。公開 URL: <https://chromewebstore.google.com/detail/sr-query-builder-plugin/bckokafmjighegpjiocopkagghppnjld>

## このフォルダの中身

| ファイル | 用途 | 状態 |
|---|---|---|
| [privacy-policy.md](privacy-policy.md) | プライバシーポリシー（審査必須。公開 URL が要る → 下記参照） | 原稿完成 |
| [permissions-justification.md](permissions-justification.md) | 各権限の使用理由（審査フォームへ貼り付け。日英併記） | 原稿完成 |
| [store-listing-description.md](store-listing-description.md) | ストア掲載ページの詳細な説明（審査フォームへ貼り付け。日英併記） | 原稿完成 |

ストア掲載ページ（プライバシーポリシー / ヘルプ / 利用規約 / ウェブサイト）の実体は [hosted/](../../hosted/) に作成済み。ホスティング手順は [hosted/README.md](../../hosted/README.md) を参照。

## ストア掲載メタ情報（登録フォームへ入力予定）

- **名称**: SR Query Builder Plugin（確定）
  - 出典: [src/_locales/ja/messages.json](../../src/_locales/ja/messages.json) の `extName`。en 側も同じ値。
- **概要（日本語）**: 研究プロトコルから PubMed 検索式を生成・検証し、各データベース向けに変換する Chrome 拡張
  - 出典: [src/_locales/ja/messages.json](../../src/_locales/ja/messages.json) の `extDescription`。
- **カテゴリ**: 仕事効率化（Productivity）
- **言語**: 日本語（`default_locale: "ja"`）
- **公開範囲**: **一般公開（public）**（確定）— ストア検索・リンクのどちらからでも誰でもインストールできる。同シリーズの sr-data-extraction-plugin と同じ方針
- **プライバシーポリシー URL**: `https://youkiti.github.io/sr-query-builder-plugin/privacy-policy.html`（公開済み。ページの正典は [hosted/](../../hosted/)、デプロイ手順は [hosted/README.md](../../hosted/README.md) 参照）
- **ウェブサイト**: `https://youkiti.github.io/sr-query-builder-plugin/`（公開済み。ページの正典は [hosted/](../../hosted/)）
- **詳細な説明**: 原稿は [store-listing-description.md](store-listing-description.md) を参照

## 必要な画像

Chrome ウェブストアの掲載に必要な画像。スクリーンショットは実データを含めないこと（テスト用プロジェクトで撮影する）。

| 画像 | 仕様 | 状態 |
|---|---|---|
| ストアアイコン | 128×128 PNG | 済 — [src/icons/icon128.png](../../src/icons/icon128.png) を使用可 |
| スクリーンショット | 1280×800、最低 1 枚（最大 5 枚） | 済 — [hosted/screenshots/](../../hosted/screenshots/) に 5 枚（`s1-protocol.png` 〜 `s5-export.png`）。`npm run shots`（Playwright + stub 環境・無人実行）で再生成できる。実 API を叩いた本物の画面で撮り直す場合は `npm run manual:check -- --shots`（詳細は [docs/manual-testing.md](../manual-testing.md)） |
| 小型プロモタイル（任意） | 440×280 PNG | 任意・未設定 |

## 提出前チェック（本フェーズの実施状況）

- [x] manifest の permissions / OAuth スコープを見直し、`icons` / `action.default_icon` を配線（→ [manifest レビュー結果](#manifest-レビュー結果)）
- [x] プライバシーポリシー原稿
- [x] 権限の使用理由原稿（日英）
- [x] 提出用 zip の作成・検証ツール整備（[tools/release/](../../tools/release/)。`npm run release` / `npm run pack:release`）
- [x] GitHub Pages 公開ページの作成・デプロイ（[hosted/](../../hosted/)。**作成・デプロイ済み**で、公開 URL `https://youkiti.github.io/sr-query-builder-plugin/` は有効。**デプロイは GitHub Actions で自動化済み** — `master` の `hosted/**` が変わると [.github/workflows/deploy-pages.yml](../../.github/workflows/deploy-pages.yml) が公開する。運用は [hosted/README.md](../../hosted/README.md)）
- [x] スクリーンショット取得（[hosted/screenshots/](../../hosted/screenshots/) に 1280×800 の 5 枚。`npm run shots` で再生成できる。上記「必要な画像」参照）
- [x] クリーンな Chrome プロファイルでの実 Google 認証つき dist smoke
- [x] Chrome ウェブストア デベロッパーアカウントで提出（**2026-08-07 に v0.2.0 を提出**。`release/sr-query-builder-plugin-0.2.0.zip` を `key.pem` 同梱でアップロード。version バンプはしていない＝0.2.0 は本提出が初出）
- [x] 審査通過・一般公開（**v0.2.0 が 2026-08-10 に公開**。続けて v0.3.0 も審査を通過し公開中）
- [x] 公開後: ストアに表示された拡張 ID が `bckokafmjighegpjiocopkagghppnjld` と一致することを確認する（一致していれば既存の OAuth client_id がそのまま使える）→ **確認済み**。ストア URL がこの ID を含む
- [x] 公開後: [hosted/index.html](../../hosted/index.html) のヒーロー CTA と「はじめかた」を、自前ビルド手順からストアのインストールリンク・手順へ差し替える（[hosted/README.md](../../hosted/README.md) の「更新時に守ること」参照）→ **別 PR `docs/public-pages-v030-published` で実施中**

## v0.3.0 リリース記録

- 提出用 zip: `release/sr-query-builder-plugin-0.3.0.zip`（`key.pem` は同梱していない。更新提出のため不要 — 拡張 ID はストアのアイテムに既に固定されている）
- version バンプ commit: `663677a`
- v0.2.0 からの差分（拡張本体に載るものだけ）:
  - 新機能: `.docx` 形式の研究プロトコル取り込み（fflate ベース）
  - 修正: `#/edit` の AI 改善提案が再描画で消える（issue #39）
  - 修正: `#/edit` の保存ステータス・編集メモが再描画で消える（issue #42）
  - 修正: 編集メモの打鍵で 1 回目のクリックが飲まれる回帰

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
