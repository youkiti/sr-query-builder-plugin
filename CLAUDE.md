# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 現在のフェーズ

**MVP 実装フェーズ**（2026-06 時点）。要件定義は完了し、`src/` 配下にフルページアプリ・Popup・Options・Background を含む実装と、unit 1100 件規模 / E2E 98 件のテストスイートが存在する。

- ユーザーフロー全 10 ルート（home → protocol → blocks → seeds → draft → expand → edit → export → done + history）の画面実装済み。検索式の生成と検証は `draft` タブに統合され、「生成して検証する」1 操作でブロックごとのヒット数（line_hits）をライブ表示しつつ、完成後に捕捉率・MeSH 検証まで自動実行する（旧 `validate` ルートは廃止）
- P0 の検証ロジック（行ごとのヒット数 / シード捕捉率 / 全 DB 変換 / MeSH 抽出）は TypeScript へ移植済み（[src/features/validation/](src/features/validation/), [src/features/conversion/](src/features/conversion/)）
- 未実装・残タスクは「[未実装・既知のギャップ](#未実装既知のギャップ)」を参照

## 開発コマンド

```bash
npm run dev          # webpack 開発ビルド（dist/ へ出力。完了報告前に必ず通すこと）
npm run watch        # 開発ビルドの watch
npm run build        # 本番ビルド（dist-release/ へ出力。.env の OAUTH_CLIENT_ID 必須）
npm run release:alpha # アルファ配布: dev ビルド → zip 化 → Drive アップロードを一発（詳細は「アルファ配布」節）
npm test             # jest（jsdom）unit テスト
npm run test:e2e     # Playwright E2E（実 Chromium + axe a11y。API はすべて stub）
npm run test:e2e:ui  # Playwright UI モード
npm run shots        # ストア掲載用スクリーンショット 5 枚を無人撮影（tests/shots/・stub 環境。hosted/screenshots/ へ出力）
npm run typecheck    # tsc --noEmit
npm run lint         # eslint（src + tests）
npm run lint:css     # stylelint
npm run manual:check # Selenium 実機確認（本物の Chrome + Google/Gemini/NCBI。手動確認用・CI 非対象）
npm run video:setup  # 操作解説動画の環境構築（ffmpeg / VOICEVOX / 日本語フォント。冪等）
npm run video:record # シーン収録（video/scenes/ → video/build/scenes/。Linux は xvfb 経由）
npm run video:tts    # ナレーション音声合成（video/narration/ → video/build/audio/）
npm run video:assemble # 合成（build/ 一式 → final.mp4 / chapters.txt / 字幕 / 説明文）
```

**CI**: [.github/workflows/ci.yml](.github/workflows/ci.yml) を追加。`pull_request` と `master` への `push` で発火し、`verify` ジョブ（typecheck → lint → lint:css → test → dev ビルド）と `e2e` ジョブ（Playwright Chromium 導入 → test:e2e）を並列実行する。本番ビルド（`npm run build`）は `.env` の `OAUTH_CLIENT_ID` を要求するため CI では回さない。E2E 失敗時は `test-results/`（trace・スクリーンショット）が artifact として 7 日間保持される。

単一テストの実行: `npx jest src/app/views/blocksView.test.ts`、E2E 単体: `npx playwright test tests/e2e/app-blocks.spec.ts`。

**Linux でも `npm test` は全通過する**（2026-08 の CI 整備で対応済み）。`tests/playwright-server.test.ts` の `safeJoin` テストのうち、Windows 形式（バックスラッシュ区切り）の traversal パスを検証する assertion は `process.platform === 'win32'` で条件分岐した別テストに切り出してあり、Linux では自動的にスキップされる（POSIX の `path` はバックスラッシュをパス区切りとして扱わないため、この assertion は Windows 上でしか意味のある検証にならない。`safeJoin` 本体は変更していない）。スラッシュ区切りの traversal 検証（`/../dist-evil/file.txt`）は全プラットフォームで維持している。

**カバレッジ閾値は実際には発火していない**: [jest.config.ts](jest.config.ts) は `coverageThreshold` に global 100%（branches / functions / lines / statements）を宣言しているが、`npm test` は `--coverage` を付けないため**この閾値は通常のテスト実行では一度も評価されない**。`npx jest --coverage` を実行すると実測は 95% 前後（2026-08 時点で stmts 95.3% / branches 91.3%）で、閾値割れとして赤くなる。ビュー層には構造的に到達不可能な catch 節（例: [src/app/views/editView.ts](src/app/views/editView.ts) の `applyBlockImprovement` の失敗経路）が元から残っており、**これは自分の変更が壊したものではない**。カバレッジを気にするときは「global 100% を満たすこと」ではなく「自分が足した分岐にテストが付いていること」を基準にすること。

**リモート / web セッションで E2E を回すとき**: `npx playwright install` はエージェントプロキシに 403 で弾かれるうえ、実行してはいけない。Chromium は `/opt/pw-browsers/` に導入済みだが、ビルド番号がプロジェクトの `@playwright/test` の要求と食い違うと `Executable doesn't exist at ...` で 5 件まとめて落ちる（**環境の問題であって変更の回帰ではない**）。`/opt/pw-browsers/chromium-<build>/chrome-linux/chrome` を指す一時設定を作って `--config` で渡せば通る:

```ts
// playwright.local.config.ts（一時ファイル。コミットしないこと）
import base from './playwright.config';
export default {
  ...base,
  use: { ...base.use, launchOptions: { executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' } },
};
```

**複数の worktree で並行作業するとき、E2E を同時に走らせてはいけない**: [playwright.config.ts](playwright.config.ts) は `webServer` を `localhost:4400`（`E2E_PORT` 未設定時）に立て、`reuseExistingServer: !process.env.CI` を指定している。したがって **2 つ目の worktree で `npm run test:e2e` を始めると、1 つ目が立てたサーバを「既にレディ」とみなして再利用し、別 worktree の `dist/` を配信したままテストが走る**（`tools/playwright-server.js` は起動時の作業ディレクトリ配下の `dist/` を配信する）。自分の変更が反映されていない画面を検証することになり、**しかも普通に green になるので気づけない**。並行させるなら worktree ごとに別ポートを渡す（`E2E_PORT=4401 npm run test:e2e`）。ポートを分けないなら、E2E を回す worktree を 1 つに決めて他では実行しないこと。

**操作解説動画（`video/`）**: YouTube 公開用の解説動画を Playwright 収録 + VOICEVOX 音声合成 + ffmpeg 合成で作るパイプライン。正典は [video/REQUIREMENTS.md](video/REQUIREMENTS.md)（PR 分割・受け入れ基準・QA/QC チェックリスト）、実行手順と過去に踏んだ失敗の再発防止メモは [video/README.md](video/README.md)。収録は dev ビルド（`dist/`）を読み込むので事前に `npm run dev` が要る。Chrome 拡張の録画には仮想ディスプレイが必要なため、Linux では `xvfb-run -a -s "-screen 0 1920x1080x24" node video/scripts/record.mjs` のように xvfb 経由で実行する。

**全 14 章を収録・QA 済みで、YouTube に一般公開済み**（<https://youtu.be/RqUFlmncuIE>。`hosted/index.html` / `hosted/help.html` に埋め込み済み）。収録はデモビルド（`npm run build:demo` → `dist-demo/`）を読み込む（`resolveExtensionDir()` が `dist-demo/` → `dist/` の順で解決する）。章ごとの初期状態は `?demoSeed=<プリセット名>`、進捗表示を映すための人工レイテンシは `?demoLatency=<係数>` で URL から渡す（`src/demo/`。係数の実測表は [video/REQUIREMENTS.md](video/REQUIREMENTS.md) §6-4）。**原稿 → TTS → 収録の順を守ること**（シーンが `loadCueDurations()` で音声の実尺を読んで画面を追従させるため）。

**dev ビルドと本番ビルドは出力先を分離している**（`dist/` と `dist-release/`）。**ローカルで実機確認するときは必ず dev ビルド（`dist/`）を読み込むこと**。本番ビルド（`dist-release/`）は webpack が manifest から `key` を削除しており、`key` の無い拡張を unpacked 読込すると Chrome が拡張 ID をパスから導出してしまい、OAuth クライアントに登録済みの `bckokafmjighegpjiocopkagghppnjld` と一致せず認証できない。

**実機確認（Selenium 半自動ハーネス）**: jest / Playwright（すべて stub）ではカバーできない「本物の Chrome 拡張ランタイム + 本物の Google / Gemini / NCBI API」の結合部は [tools/selenium/manualCheck.mjs](tools/selenium/manualCheck.mjs) で通し確認する。操作・検証を自動化し、ログイン / OAuth 同意 / API キー入力だけコンソールで一時停止する。初回は `npm run manual:check -- prepare` で専用プロファイル（`.selenium-profile/`）に dist/ を手動読込。詳細と手順書は [docs/manual-testing.md](docs/manual-testing.md)。

## アルファ配布（Chrome Web Store 申請前のテスター配布）

ストア申請前に、信頼できるテスターへ「パッケージ化されていない拡張機能」として zip を配る運用。リリースまでの中継フェーズ。手順書は [docs/alpha-test-guide.md](docs/alpha-test-guide.md)（テスター向け。Drive 同梱）。

```bash
npm run release:alpha                 # dev ビルド → zip → Drive アップロードを一発
npm run release:alpha -- -NoUpload    # zip 化まで（アップロードしない）
npm run release:alpha -- -SkipBuild   # 既存 dist をそのまま zip → アップロード
```

実体は [scripts/release-alpha.ps1](scripts/release-alpha.ps1)（**UTF-8 BOM 必須** — npm が呼ぶ Windows PowerShell 5.1 が BOM 無しだと日本語を文字化けさせ parse エラーになる）。

- **dev ビルドは拡張名に `(dev)` を自動付与**（webpack の `_locales` transform。production ビルドには付かない）。ストア版とテスター版を見分けるため
- **固定 `key`（manifest）により拡張機能 ID は常に `bckokafmjighegpjiocopkagghppnjld`**。誰がどの PC で unpacked 読み込みしても同一 ID になり、**既存の OAuth client_id がそのまま効く**。アルファ配布が成立する前提条件
- zip 名は `package.json` の `version` 由来（`sr-query-builder-plugin-dev-v<version>.zip`）。バージョンを上げるときは `package.json` と [src/manifest.json](src/manifest.json) の `version` を揃えて更新する
- source map（`*.map`）は除外して圧縮
- アップロードは `rclone` の `gdrive:` リモート経由、宛先は `.env` の `GOOGLE_DRIVE`（フォルダ URL でも ID でも可）。`docs/alpha-test-guide.md` も同時アップロード
- **自動化できない 2 点（毎回手動）**: ① 新規テスターの Gmail を OAuth テストユーザーに登録（<https://console.cloud.google.com/auth/audience>。同意画面が Testing 状態のため未登録だと他アカウントはログイン不可）／ ② Drive ファイルの共有権限付与（rclone は転送のみ）
- **本番リリース時の注意**: `npm run build`（production）は manifest から `key` を削除するが、初回ストアアップロード時だけ zip ルートに対応する `key.pem` を同梱すれば Chrome ウェブストアが同じ拡張 ID（`bckokafmjighegpjiocopkagghppnjld`）を導出するため、ストア用に別の OAuth client_id を作る必要はない。スコープは `drive.file` のみ（非センシティブ）なので Production 公開に OAuth 検証は不要

## 本番リリース（Chrome ウェブストア提出用 zip）

Chrome ウェブストアへ提出・更新する zip を作る運用。**アルファ配布（`release:alpha`）とは別物**なので混同しないこと — `release:alpha` はテスター配布用（dev ビルド・拡張名に `(dev)` 付与・version バンプなし・key 除去なし・提出物としての検証なし）、`release`（本節）はストア提出用（本番ビルド・version バンプ必須・key 除去を検証・ストア提出用 zip の内容を機械検証）。

```bash
npm run release -- minor                 # 機能追加を含むリリース（patch / major / 明示 version も可）
npm run release -- patch -NoPush         # push せずローカル commit + zip まで
npm run release -- minor -SkipCiCheck    # CI 状態チェックを省略（gh 未導入 / 未認証の環境）
npm run release -- minor -Force          # 前提チェックの警告（ブランチ不一致等）を停止ではなく警告に落とす
npm run release -- minor -IncludeKeyPem  # 初回ストアアップロード専用。key.pem を zip に同梱
npm run pack:release                     # 既存 dist-release/ だけをパッケージング（version バンプ・commit・push はしない）
```

実体は [tools/release/release.ps1](tools/release/release.ps1)（前提チェック → version バンプ → commit → 本番ビルド → [tools/release/pack.ps1](tools/release/pack.ps1) の実行 → push）と、パッケージング単体を担う [tools/release/pack.ps1](tools/release/pack.ps1)（既存 dist-release/ だけを検証・zip 化したいときはこちら単体で実行できる）。

- version は **`src/manifest.json` / `package.json` / `package-lock.json` の 3 箇所を揃える運用**。`release.ps1` が 3 箇所同時にバンプし、`pack.ps1` が不一致を検出して停止する
- `key.pem`（リポジトリルート直下・gitignore 対象）は**初回ストアアップロードのときだけ** `-IncludeKeyPem` で zip に同梱する。以後の更新提出では同梱しない（Store がアイテムの拡張 ID を既に固定しているため）
- `src/manifest.json` の `key` フィールドは常に保持する（dev の unpacked 読込で拡張 ID を固定するため）。production ビルド（`dist-release/`）からの除去は webpack.config.js の CopyPlugin transform が自動で行い、`pack.ps1` はその除去が起きたことを確認するだけで、削除そのものはしない
- **CI チェックは 2026-08-09 から発火する**: `release.ps1` は `.github/workflows/` にファイルが 1 つでもあれば `gh run list` で `origin/master` の HEAD に対する run を見る。公開ページのデプロイ workflow（`deploy-pages.yml`）を追加したため、オートスキップ（`CI 未配置のためスキップ`）は終了した。実務上の挙動は次のとおり:
  - version バンプ commit は `hosted/**` に触らないので `deploy-pages` は発火しない → 直前の master HEAD に run が無ければ `CI run が見つかりません` の**警告のみ**で先へ進む
  - `hosted/**` を変えた直後にリリースすると、デプロイ実行中は「CI がまだ実行中です」で停止する（`-Force` / `-SkipCiCheck` で回避可）。デプロイ完了を待つのが本筋
  - version バンプ commit はテストにも触れないため `ci.yml`（`typecheck` / `lint` / `lint:css` / `test` / `dev` / `test:e2e`）も同様に発火しない。**`deploy-pages` や `ci.yml` の run 有無だけでテストが通ったことは保証されない**（このスクリプトが見るのは「直前の master HEAD に対する run の有無」であって、リリース対象のコミット自体を CI にかけているわけではない）。リリース前の検証はローカルで `typecheck → test → test:e2e → lint → build` を回すこと

## 公開ページ（GitHub Pages / `hosted/`）

Chrome ウェブストア審査・利用者向けに公開する静的ページ 4 枚（ランディング / 使い方ガイド / プライバシーポリシー / 利用規約）+ 共通 `style.css` / `lang.js` / `screenshots/` の正典は [hosted/](hosted/) に置く。デプロイ先は GitHub Pages（ソースは **GitHub Actions**）。

- **プライバシーポリシーの公開 URL は Chrome ウェブストア審査の必須要件**。公開済み URL は `https://youkiti.github.io/sr-query-builder-plugin/privacy-policy.html`
- **プライバシーポリシーの正典は [docs/store/privacy-policy.md](docs/store/privacy-policy.md)**。`hosted/privacy-policy.html` はその転記＋英訳なので、**内容を変えるときは両方を直す**（乖離するとストア審査で参照される URL の内容とリポジトリの原稿がずれる）
- ja / en は**併記ではなく切替**（`lang.js` が `html[data-lang]` で表示側を絞る）。文言を足すときは両言語分を書くこと
- ストア掲載用スクリーンショットは `npm run shots`（Playwright + stub 環境。無人実行）で `hosted/screenshots/` へ出力する（1280×800 の 5 枚）。実 API を叩いた本物の画面で撮り直したいときは `npm run manual:check -- --shots` を使う
- **デプロイは自動**（[.github/workflows/deploy-pages.yml](.github/workflows/deploy-pages.yml)。`master` の `hosted/**` が変わると発火し、`hosted/` を `_site/` へ組み立てて `actions/deploy-pages` で公開する）。手動のコピー作業は不要。内容を変えずに再デプロイしたいときは Actions タブから `workflow_dispatch` で手動実行する。公開 URL は `https://youkiti.github.io/sr-query-builder-plugin/`（有効）
- **旧方式（`gh-pages` ブランチへ worktree 経由で手動 push）は廃止**。`gh-pages` ブランチは Pages のソースから外れており、push しても公開内容は変わらない（履歴として残置）。経緯と注意点は [hosted/README.md](hosted/README.md)
- スクリーンショットは `hosted/screenshots/*.png` としてリポジトリにコミット済みで、workflow はそれをコピーするだけ（CI で `npm run shots` は走らせない）。撮り直したら生成物をコミットすること
- 提出物一式の全体像・進捗は [docs/store/README.md](docs/store/README.md) を参照

## アーキテクチャ

詳細は [docs/architecture.md](docs/architecture.md)。vanilla TypeScript（UI フレームワーク不使用）+ webpack。

```
src/
├── app/            # メインビュー（フルページタブ）。app.html + hash ルーティング
│   ├── router.ts   # ルート定義（ROUTE_LABELS。home〜history + settings）
│   ├── store.ts    # in-memory ストア（currentProject のみ chrome.storage.local へ永続化）
│   ├── guards.ts   # 前提条件ガード（プロトコル未入力なら #/blocks へ入れない等）
│   ├── bootstrap.ts# DI 配線（views × services × navigate）
│   ├── services/   # 画面とドメインロジックの仲介（protocolService / blocksService / ...）
│   ├── styles/     # ビュー単位に分割した CSS（app.html が <link> で個別に読み込む）
│   └── views/      # 各ルートの描画関数（DOM 直組み。RenderView 型）
├── features/       # ドメインロジック（protocol / seeds / formula / validation / conversion / project）
├── lib/            # 横断ライブラリ（google: OAuth+Sheets+Drive / llm: LLMProvider 抽象+Gemini / ncbi: E-utilities / combination-expression / search-formula-md）
├── popup/          # 認証・プロジェクト作成/選択の入口
├── options/        # BYOK 設定（Gemini API キー / NCBI API キー）
├── background/     # service-worker
└── manifest.json   # Manifest V3
```

- CSS: メインビューのスタイルは [src/app/styles/](src/app/styles/) にビュー単位で分割してある（`shell.css` が共通の外枠、以降は `#/draft` → `draft.css` のようにルートと 1:1）。**新しいスタイルは対応するビューのファイルへ書くこと。** 単一の `app.css` から分割したのは、複数の作業が並行するときに同じファイルの末尾へ追記し合って衝突するのを避けるため。ファイルを新設したら `app.html` に `<link>` を足す（webpack はディレクトリごとコピーするので `webpack.config.js` の編集は不要）。読み込み順＝カスケード順なので、`app.html` の `<link>` の並びを入れ替えないこと
- 状態管理: [store.ts](src/app/store.ts) の `AppState` が単一の真実。`protocolDraft` / `blocksDraft` 等は in-memory のみで、リロードで消える（Sheets が永続層）
- E2E hook: [app.ts](src/app/app.ts) は `window.__E2E_PRELOADED_STATE__` があればストアのシードに使う（テスト用 seam。本番動作には影響しない）
- テスト戦略は [docs/ui-review-strategy.md](docs/ui-review-strategy.md)（Tier 0〜3）と [docs/ui-deep-test-plan.md](docs/ui-deep-test-plan.md) を参照。E2E は LLM / Google / NCBI をすべて `page.route()` + chrome stub でモックする
- [docs/ui-states.md](docs/ui-states.md) は一部 target spec（実装より先行）。spec をテストに固定化する前に必ず実装と照合し、乖離は同ドキュメントの ⚠️ drift 注記へ

## 未実装・既知のギャップ

- **P1 ロジック未移植**: `check_block_overlap` / `check_mesh` / `check_mesh_overlap`（ブロック重複・MeSH 分析）
- **OpenAI / Anthropic Claude への直接連携は未実装**: 実装済みなのは Gemini と OpenRouter の 2 プロバイダ（`src/lib/llm/GeminiProvider.ts` / `OpenRouterProvider.ts`。既定モデルは `gemini-3.5-flash`）。Options 画面で OpenRouter の API キーとカスタムモデル ID（最大 20 件）を追加登録できるため OpenRouter 経由で多くのモデルに到達できるが、OpenAI / Anthropic の API を直接叩く `LLMProvider` 実装は無い（`LlmProviderId` 型に `openai` / `anthropic` の値はあるが対応実装が無い）
- E2E ジャーニー J1（新規作成→export 貫通）は draft 生成〜検証の主要経路を journey-draft-generate.spec.ts で回帰確認済み。J4（expand キーボード判定）/ J5 の API エラー系は残タスク（[docs/ui-deep-test-plan.md](docs/ui-deep-test-plan.md) Phase D/E）

## 目的（ゴール）

MIT ライセンスの OSS Chrome 拡張 **sr-query-builder-plugin**。ユーザーフロー：

1. 研究プロトコル（RQ・PICO・組入/除外基準）を入力（手入力 / `protocol.md` / `.docx` の 3 系統）。入力直後に「シード論文があれば PMID を登録」フローを提示
2. 生成 AI で PubMed 検索式のドラフトを作成
3. `search-formula-developper` 相当の検証ロジックで検証・最適化（シード論文捕捉率、MeSH 分析など）。途中で「この論文は組入対象ですか？」と候補をユーザーに尋ね、シード集合を動的に育てる
4. 最終的な PubMed 検索式を他データベース（CENTRAL / Embase(Dialog) / ClinicalTrials.gov / ICTRP）へ変換して出力し、PubMed の nbib ダウンロードボタンまで案内する

`search-formula-developper` は AI で作った検索式を人間と対話的に検証・変換する Python ツール群。本拡張はその対話部分をブラウザ UI として提供し、**ロジックは TypeScript へ移植**する（サブモジュールはリファレンス実装・テスト用データ源。本体からは呼び出さない）。

## 確定している要件（要件定義の合意事項）

### データ保存

- **Google Sheets を共有 DB として使用**（tiab-review-plugin と同じ思想）。監査ログ・バージョニング目的で、プロトコル・検索式ドラフト・検証結果・LLM API ログをすべてシートに残す。

#### Sheets タブ設計

詳細は [docs/requirements.md §3.1](docs/requirements.md) 参照。1 スプレッドシート = 1 プロジェクト = 1 Drive フォルダの紐づけで、**プロジェクト識別子は `Meta` タブに 1 行だけ保持**（他タブに `project_id` 列は持たせない）。

| タブ名 | 役割 |
|---|---|
| `Meta` | プロジェクト識別（`project_id` / `drive_folder_id` / `spreadsheet_id` / `schema_version`）。統合アプリは Meta タブだけ読めば紐づけできる |
| `Protocol` | RQ / フレームワーク種別（pico/peco/pcc/spider/custom）/ 組入除外基準 / `combination_expression` / 元テキストへの Drive URL（versioning あり） |
| `ProtocolBlocks` | 1〜5 個の検索式ブロック定義。`search_formula.md` の `#1`〜`#5` と 1:1 対応。PICO 固定ではなく汎用ブロックモデル。LLM が抽出 → ユーザーが承認/編集 |
| `SeedPapers` | PMID / title / source（`initial` or `interactive`）／ユーザー判定（include / exclude / maybe） |
| `FormulaVersions` | version_id / formula_md / created_at / created_by / parent_version_id / model（下書きを支援した LLM モデル ID。#/export の Methods 文案に使用） |
| `ValidationLog` | version_id / total_hits / capture_rate / captured_pmids / missed_pmids |
| `Conversions` | version_id / target_db / converted_formula / exported_at |
| `LLMApiLog` | timestamp / provider / model / purpose / prompt_ref / response_ref / tokens_in / tokens_out / latency_ms / error。フル payload は Drive の `{drive_folder_id}/logs/llm/{log_id}.json`、Sheet には URL と要約のみ |
| `Config` | LLM プロバイダ設定・API キーの参照（キー本体は `chrome.storage` 側） |

### シード論文の対話的拡張フロー

検索式ドラフト後、現式を 2 軸（MeSH 一段上＋explode / フリーワード synonym）で広げた拡張式の**外側**（margin = 拡張式 NOT 現式）を検索し、その中から AI が**境界事例っぽい数件**を選んでユーザーに include / exclude / maybe をワンクリック判定させる。`include` は `SeedPapers` に `source=interactive` として追加される。margin は現式の外側なので、include されれば `check_final_query` 相当の再検証で捕捉率が 100% を割り、取りこぼしが顕在化する。あわせて「どの拡張語が拾えたか」を集計して検索式の**更新提案**（ブロック #N にこの語を足すと M 件回収）を提示する（採用は `#/draft` で手動）。**実験的機能（dev）** として UI に明示。詳細は [docs/requirements.md §4.5](docs/requirements.md)。

### Python CLI の移植方針

- **Python CLI を TypeScript へ移植**（Native Messaging は不採用。Chrome Web Store 配布でユーザーに Python 環境を要求しないため）。
- 移植元は [search-formula-developper/scripts/](search-formula-developper/scripts/)。NCBI E-utilities はブラウザから直接 `fetch`（CORS は `host_permissions` で解決）。
- 優先度: **P0**（移植済み）= check_search_lines / check_final_query / generate_all_database_search / extract_mesh。**P1** = check_block_overlap / check_mesh 系。**P2（対象外含む）** = ERIC 系・Ovid 変換・Rayyan CSV。

### LLM 戦略

- **当初の合意は「MVP は Gemini のみ」**。後続で OpenAI / Anthropic Claude / OpenRouter への対応を見据え、**`LLMProvider` 抽象**（[src/lib/llm/](src/lib/llm/)）を最初から設けていた。その後 OpenRouter 対応が先行して実装され、現在は Gemini + OpenRouter の 2 プロバイダが使える（OpenAI / Anthropic Claude は未実装。詳細は「[未実装・既知のギャップ](#未実装既知のギャップ)」参照）。
- API キーは **BYOK**。`chrome.storage` に保存し、Options 画面で設定する。
- AI の役割: 検索式ドラフト生成・MeSH 提案・シノニム展開・ブロック改善案・検証結果の解釈補助まで、ワークフロー全体のアシスタント。

### 出力物（MVP）とスコープ境界

- PubMed 検索式 `.md`（`search_formula.md` 互換: `## PubMed/MEDLINE` セクション、コードブロック、`#N` 行番号、最終行 `#N AND #M`。フォーマット定義は [search-formula-developper/CLAUDE.md](search-formula-developper/CLAUDE.md)）
- 他 DB 変換: CENTRAL / Embase(Dialog) / ClinicalTrials.gov / ICTRP
- **作らない**: PRISMA 用記述ブロック、Rayyan 連携、nbib ダウンロードの自動化（ボタンまで誘導するだけ）、スクリーニング、重複除去、全文 PDF 取得
- 本拡張の責務は「研究プロトコル → 検証済み検索式 → 各 DB で抄録をダウンロードするところまで案内」。スクリーニング以降は tiab-review-plugin / 外部ツールに引き渡す

### 統合アプリ視点の将来設計

将来、複数の SR 系 Chrome 拡張を束ねる **統合 Chrome 拡張** を構築する想定。このため：

- `project_id`（UUID v4）はプロジェクト作成時に本拡張が自動発行し、`Meta` タブに保持する
- データ受け渡しフォーマット（Sheets タブ設計 + エクスポート用 JSON スキーマ）を明文化し、統合アプリはスキーマだけ知っていればよい状態にする
- 下位アプリ間の遷移は「統合アプリが該当スプレッドシートを開く / 該当拡張のフルページタブを起動する」方式で、データコピーは原則行わない

## 技術スタック

[tiab-review-plugin](tiab-review-plugin/) に準拠：

- Chrome Extension Manifest V3（メインビューは `chrome.tabs.create` で開くフルページ。Side Panel API は使わない。補助的に Popup + Background）
- TypeScript / HTML / CSS（vanilla、フレームワーク不使用）+ webpack
- Google OAuth 2.0（`chrome.identity`）+ Google Sheets / Drive API
- LLM: Gemini API + OpenRouter API（`LLMProvider` 抽象経由。既定モデルは Gemini）
- テスト: jest（jsdom）+ Playwright（実 Chromium）+ `@axe-core/playwright`
- Node.js ≥ 18

## サブモジュール

| パス | 役割 | 参照すべきドキュメント |
|---|---|---|
| [tiab-review-plugin/](tiab-review-plugin/) | 技術スタックとアーキテクチャの参照実装（別の Chrome 拡張） | [tiab-review-plugin/AGENTS.md](tiab-review-plugin/AGENTS.md) |
| [search-formula-developper/](search-formula-developper/) | PubMed 検索式の検証・変換 CLI（Python 3.7+） | [search-formula-developper/CLAUDE.md](search-formula-developper/CLAUDE.md), [search-formula-developper/Readme.md](search-formula-developper/Readme.md) |

サブモジュール内で作業するときは、そのサブモジュールの CLAUDE.md / AGENTS.md を最優先する。ここ（ルート CLAUDE.md）は本体実装と「2 つをどう統合するか」を扱う。

### サブモジュール操作の注意

- サブモジュールは独立リポジトリ。ルートからの `git submodule update` と、サブモジュール内での `git pull` / コミットを混同しないこと。
- 新しいサブモジュールを追加する場合は `git submodule add <url> <path>` を使い、`.gitmodules` の差分をコミットする。

## 作業上の原則（tiab-review-plugin/AGENTS.md より継承）

1. **ブランチ強制**: `main` / `master` / `develop` で直接作業しない。変更前に作業ブランチを切る。
   - **例外（意図的）**: `npm run release`（[tools/release/release.ps1](tools/release/release.ps1)）による version バンプ commit は `master` へ直接 push する。差分は `src/manifest.json` / `package.json` / `package-lock.json` の version 文字列 3 箇所のみで機能変更を含まず、スクリプト自身が push 前に「作業ツリーがクリーンであること」「本番ビルドと zip 化・検証が通ること」を機械的にゲートする。PR / レビュー待ちを挟む理由がないほど差分が小さく、かつ安全装置がスクリプト側にある場合に限った狭い例外であり、抜け穴として拡大解釈しないこと（機能変更を混ぜようとしても作業ツリーの汚れチェックで止まる）。
2. **日本語化**: ユーザー向けアーティファクト（計画書・タスク・要件書・コミットメッセージ・コード内コメント）は日本語で書く。思考プロセスだけ英語でよい。
3. **既存テスト保護**: 既存テストが落ちたら、まず実装のバグを疑う。テスト側を直す場合は「意図した仕様変更」であることをユーザーに確認する。
4. **ドキュメント同期**: 仕様や機能を変えたら、関連ドキュメント（README、仕様書、コメント）も同時に更新する。
5. **機密情報**: API キー・OAuth トークン等はログ／アーティファクト／チャット応答に絶対出さない。`.env` の扱いに注意。トークンをログに出すときは `token.substring(0, 8) + '...'` で省略する。
6. **自動化の限界**: ツール実行が複数回失敗したら執拗に再試行せず、状況を報告する。
7. **テスト通過後の dev ビルド検証**: 実装変更のテスト (`npm test`) が通ったら、作業完了を報告する前に必ず `npm run dev` を実行して webpack が成功することを確認する。型チェック・単体テストだけでは webpack の解決エラー（import パス・asset 参照など）を拾いきれないため。本番ビルド (`npm run build`) は `.env` の `OAUTH_CLIENT_ID` を要求するので、ローカル検証では dev ビルドを基準にする。ビルドが壊れた状態で「完了」報告をしない。
8. **UI 変更時は E2E も回す**: 画面・CSS・ルーティングに触れたら `npm run test:e2e` まで通す（axe の a11y 検証を含む）。
