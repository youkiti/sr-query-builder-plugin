# ディレクトリ構造案 / アーキテクチャ概要（v0.2）

- **作成日**: 2026-04-17
- **更新**: v0.2 で UI フレームワーク選定を **vanilla TypeScript** に確定（tiab-review-plugin と揃える）
- **対象**: sr-query-builder-plugin の `src/` 配下構成、ビルド構成、テスト方針
- **位置づけ**: [requirements.md §11.1](requirements.md) で「Claude が起案 / 実装着手時に承認」と決定された項目の起案

## 1. ルート構成

```
sr-query-builder-plugin/
├── .github/
│   └── workflows/                 # CI / CD（MVP では未配置。リリース判定確定後）
├── docs/
│   ├── requirements.md
│   ├── ui-flow.md
│   ├── ui-block-approval.md
│   ├── architecture.md            # 本ファイル
│   └── librarian-flowchart.md
├── src/                           # 全ソース（HTML / CSS / TS が同居。webpack がコピー）
├── tests/
│   ├── setup/                     # jest 共通セットアップ（chrome モック等）
│   ├── integration/               # 複数機能をまたぐシナリオテスト
│   └── e2e/                       # Playwright。自動調整の通し・採用保存・状態別 axe を含む
├── experiments/                   # LLM プロンプト検証用スクリプト（実装フェーズで追加）
├── search-formula-developper/     # サブモジュール（参照実装）
├── tiab-review-plugin/            # サブモジュール（技術スタック参照）
├── .env.example                   # OAUTH_CLIENT_ID のテンプレ
├── .eslintrc.cjs
├── .gitignore
├── .prettierrc
├── jest.config.ts
├── package.json
├── tsconfig.json
├── webpack.config.js
├── LICENSE                        # MIT
├── README.md
├── THIRD_PARTY_NOTICES.md         # 依存ライブラリのライセンス表記
└── CLAUDE.md
```

## 2. `src/` 配下

tiab-review-plugin と同じ方針で、**UI ライブラリは使わず素の TypeScript + DOM API** で実装する。画面ごとのフォルダ（`popup/` / `app/` / `options/` / `background/`）に HTML・CSS・TS を同居させ、webpack の `copy-webpack-plugin` で出力先（dev ビルドは `dist/`、本番ビルドは `dist-release/`。§3.1 参照）に転写する。

```
src/
├── manifest.json                  # MV3 manifest。webpack ビルド時に OAUTH_CLIENT_ID 置換
├── _locales/
│   ├── ja/messages.json           # 既定
│   └── en/messages.json           # 将来対応
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
│
├── popup/                         # 拡張アイコンから開く Popup
│   ├── popup.html
│   ├── popup.ts                   # エントリ（入口のみ、本体は lib/ へ）
│   └── popup.css
│
├── app/                           # メインビュー（chrome.tabs.create で開くフルページ）
│   ├── app.html
│   ├── app.ts                     # エントリ。ハッシュルーティングの起動のみ
│   ├── services/                  # 画面とドメインロジックの仲介（以下は抜粋。実体は 10 本以上ある）
│   │   ├── expandApiWait.ts       # #/expand の NCBI 通信を包み、レート制御待ち・リトライ待ちを画面へ通知
│   │   ├── queryEvaluationService.ts # 保存なしの検索式評価（厳密な件数・固定シード捕捉）
│   │   ├── queryOptimizationService.ts # 検索式の自動調整ループ（候補の検査・採否・停止。draft 画面から実行）
│   │   ├── queryOptimizationProgressPublisher.ts # 進捗通知の間引き・段階遷移と試行確定の即時反映
│   │   ├── queryOptimizationSettingsService.ts # プロジェクト別の目安件数・反復上限
│   │   ├── queryOptimizationAdoptionService.ts # 人の採用保存・最終検証と実行ログの関連づけ・編集下書き
│   │   └── queryOptimizationCheckpointService.ts # 自動調整の試行要約を chrome.storage.local へ
│   ├── styles/                    # ビュー単位に分割した CSS（app.html が <link> で個別に読み込む）
│   │   ├── shell.css               # ヘッダー / サイドバー / ナビゲーション等の共通外枠
│   │   ├── home.css
│   │   ├── protocol.css
│   │   ├── expand.css
│   │   ├── validate.css
│   │   ├── blocks.css
│   │   ├── queryOptimization.css # 自動調整の設定・進捗・履歴・最終レビュー
│   │   ├── draft.css
│   │   ├── edit.css
│   │   ├── seeds.css
│   │   ├── settings.css
│   │   └── export.css
│   ├── router.ts                  # #/home 等を各 view に振り分ける
│   ├── views/                     # 画面ごとの純粋な render 関数
│   │   ├── homeView.ts
│   │   ├── protocolView.ts
│   │   ├── blocksView.ts
│   │   ├── seedsView.ts
│   │   ├── draftView.ts            # 検索式の生成 + 検証を統合（旧 validateView を吸収）
│   │   ├── queryOptimizationHistory.ts # ライブ履歴・変更詳細・チェックポイントのログ表示
│   │   ├── queryOptimizationReview.ts # 4 状態の最終レビュー・最終差分・採用と編集の導線
│   │   ├── validationResults.ts    # 検証結果（捕捉率 / MeSH / 原因分析）の描画ユーティリティ
│   │   ├── expandView.ts
│   │   ├── editView.ts
│   │   ├── exportView.ts
│   │   ├── doneView.ts
│   │   └── historyView.ts
│   └── ui/                        # DOM ヘルパ（create element、class 切替、i18n ラベル等）
│       ├── dom.ts
│       ├── toast.ts
│       └── modal.ts
│
├── options/                       # API キー設定などのオプション画面
│   ├── options.html
│   ├── options.ts
│   └── options.css
│
├── background/                    # MV3 service worker
│   └── service-worker.ts
│
├── features/                      # ドメイン機能（UI に依存しない純粋ロジック）
│   ├── project/
│   │   ├── createProject.ts
│   │   ├── selectProject.ts
│   │   └── projectStore.ts
│   ├── protocol/
│   │   ├── parseDocx.ts           # DocxExtractor 抽象 + パース処理
│   │   ├── docxText.ts            # fflate ベースの DocxExtractor 実装
│   │   ├── parseMarkdown.ts
│   │   └── extractBlocks.ts       # extract-protocol skill 呼び出し
│   ├── seeds/
│   │   ├── parseNbib.ts
│   │   ├── parseRis.ts
│   │   ├── resolvePmidByDoi.ts
│   │   ├── verifyPmid.ts
│   │   └── seedRepository.ts      # SeedPapers タブ I/O
│   ├── formula/
│   │   ├── skills/
│   │   │   ├── blockDesigner.ts
│   │   │   ├── meshSuggester.ts
│   │   │   ├── freewordDesigner.ts
│   │   │   ├── filterDesigner.ts
│   │   │   ├── pickBoundaryCases.ts     # 対話的拡張: 境界事例選定
│   │   │   ├── expandQueryForRecall.ts  # 対話的拡張: 2 軸の拡張語提案（MeSH 一段上 / フリーワード）
│   │   │   ├── improveBlock.ts
│   │   │   ├── optimizeQuery.ts   # 自動調整ループ用。全式・測定・試行履歴を渡して 1 ブロックの変更案を得る
│   │   │   └── interpretResult.ts
│   │   ├── recallExpansion.ts     # margin 探索の純粋ロジック（拡張式生成 / margin / 更新提案）
│   │   ├── assembleFormulaMd.ts
│   │   └── parseFormulaMd.ts
│   ├── validation/                # search-formula-developper からの TS 移植
│   │   ├── checkSearchLines.ts
│   │   ├── checkFinalQuery.ts
│   │   ├── extractMesh.ts
│   │   ├── blockMeshTree.ts       # check_mesh / check_mesh_overlap 相当（UI 未接続）
│   │   ├── blockTerms.ts          # 語抽出・共有語・計測済みの寄与文脈
│   │   ├── meshContext.ts         # ブロックの MeSH 文脈と祖先経路の組み立て
│   │   └── freewordDelta.ts       # check_block_overlap 相当（UI 未接続）
│   ├── conversion/
│   │   ├── toCentral.ts
│   │   ├── toDialog.ts
│   │   ├── toClinicalTrials.ts
│   │   ├── toIctrp.ts
│   │   └── generateAll.ts
├── lib/                           # 外部 API / 低レベルユーティリティ
│   ├── api-error/
│   │   └── apiErrorKind.ts        # 外部 API の失敗を permission / rate_limit / temporary / other に分類（案内の出し分け）
│   ├── google/
│   │   ├── auth.ts                # chrome.identity.getAuthToken ラッパ
│   │   ├── sheets.ts              # Sheets API（バッチ書き込み / 読み取り / 共有設定へ送る URL 生成）
│   │   ├── drive.ts               # Drive API
│   │   └── identity.ts            # chrome.identity.getProfileUserInfo ラッパ
│   ├── ncbi/
│   │   ├── eutils.ts              # esearch / efetch / esummary
│   │   ├── pubmedUrl.ts
│   │   ├── rateLimit.ts
│   │   └── meshRdf.ts             # NLM MeSH RDF（SPARQL）クライアント。tree number の逆引きと子ノード列挙
│   ├── llm/
│   │   ├── LLMProvider.ts         # interface
│   │   ├── GeminiProvider.ts      # MVP 実装
│   │   ├── providerFactory.ts
│   │   └── apiLogger.ts           # LLMApiLog + Drive 保存
│   ├── storage/
│   │   ├── chromeStorage.ts       # chrome.storage.local 型付きラッパ
│   │   └── secretsStore.ts        # API キー保存
│   └── search-formula-md/
│       ├── tokenize.ts
│       ├── expression.ts          # 検索式の分類・語分解・句単位の差分
│       ├── parse.ts
│       └── serialize.ts
│
├── domain/                        # 型定義・スキーマ（純粋型、runtime 依存ゼロ）
│   ├── project.ts
│   ├── protocol.ts
│   ├── seedPaper.ts
│   ├── formulaVersion.ts
│   ├── validationLog.ts
│   ├── conversion.ts
│   ├── llmApiLog.ts
│   └── sheetsSchema.ts            # 9 タブの列定義
│
├── styles/
│   ├── tokens.css                 # カラー / 余白 / フォントトークン（全画面で import）
│   └── globals.css
│
└── utils/
    ├── uuid.ts
    ├── iso8601.ts
    ├── markdown.ts
    └── sanitizeSecret.ts          # token の先頭 8 文字 + '...' ヘルパ
```

### 2.1 レイヤ依存ルール

```
entries (popup / app / options / background)
            ↓
views / ui
            ↓
features
            ↓
lib / domain
            ↓
utils
```

- 上位は下位を import 可、逆は不可
- `domain/` は純粋型のみ。runtime バリデーションが必要な箇所は `features/*` 側で zod を使う
- `lib/google/sheets.ts` は `domain/sheetsSchema.ts` を参照するが、`features/*` は参照しない（features は domain の型経由でアクセス）
- ESLint の `import/no-restricted-paths` で機械的に強制

### 2.2 UI 実装方針（v0.2 で確定）

- **UI ライブラリは使わない**（tiab-review-plugin と揃える）
- 各 view は「`render(state): HTMLElement` を返す純粋関数」として実装し、状態は `app/app.ts` の中央ストアで管理
- 状態の変更は「`dispatch(action)` → ストア更新 → 該当 view を再レンダ」の単方向フロー
- ストア層は薄い自作（`createStore<State, Action>()` 20 行程度）で十分。将来必要なら preact/signals や zustand へ差し替え可能な境界を保つ
- 最低限のスタイリングは素の CSS（`src/styles/tokens.css` + 各画面の `*.css`）

### 2.3 エントリの責務境界

各エントリ（`popup.ts` / `app.ts` / `options.ts` / `service-worker.ts`）は **起動フックのみ**：

```ts
// 例: src/app/app.ts
import { startApp } from './bootstrap';
startApp(document);
```

実処理は `bootstrap.ts` 等に切り出して jsdom でテストできるようにする。これによりエントリ自体を coverage 対象から外さずに済ませる（§4.4 参照）。

### 2.4 ヘルプツアー

画面の実物に枠を付け、案内カードを出して手順を進める。外部ライブラリは使わず、暗幕も出さない。ヘッダーの「ツアー」ボタン（`#app-open-tours`）から始める。挙動の仕様は [ui-states.md](ui-states.md) の「操作ツアー」。

| 場所 | 役割 |
|---|---|
| `src/lib/guide/tours/` | ツアーと手順の型（`types.ts`）、文言キーの生成（`keys.ts`）、ツアーの定義（`<名前>.ts`）、登録（`index.ts` の `GUIDE_TOURS`。登録順が一覧の表示順） |
| `src/lib/guide/tourProgress.ts` | 進捗の型・解析・状態遷移・提案の判定（純関数）。保存キーは `guide_progress` |
| `src/lib/guide/guideProgressStore.ts` | 進捗を `chrome.storage.local` へ保存・読込し、他タブの変更を購読する |
| `src/app/guide/` | 画面側。`index.ts`（`initGuide`。`bootstrap.ts` の `startApp` が呼ぶ）、`tourRunner.ts`（カード・枠・進行）、`placement.ts`（カードの配置）、`tourEntry.ts`（一覧と表示言語の切り替え）、`suggestBand.ts`（提案帯）、`tourConditions.ts` / `guideEvents.ts`（条件とイベント）、`adapters/<名前>.ts`（ツアー固有の条件とイベント） |
| `src/lib/i18n/` | ツアーの文面だけの日英辞書（`ja.ts` がキー集合の正典、`en.ts` は同じキー集合を型で強制）。`t(key)` で現在の言語の文言を引く。表示言語は `uiLanguageStore.ts` が `chrome.storage.local` の `uiLanguage` に保存する。アプリ本体の既存の文言は辞書に入れていない |
| `src/app/styles/guide.css` | ツアーのスタイル。z-index は枠が 2001、カード・提案帯が 2002、一覧が 2003（カードを入れ直しても一覧のボタンが隠れない） |

画面側の要素には `data-tour="<対象名>"` を付けて手順の `target` から指す。サイドバーのボタンは `nav-<ルート名>`（`bootstrap.ts` の `renderSidebar` が付ける）、サイドバー全体は `nav`、ヘッダーの「ツアー」ボタンは `tour-list`。

現在のツアーは 4 本（`getting-started` / `draft-and-optimize` / `expand-seeds` / `edit-and-export`）。条件とイベントはツアーごとのアダプタ（`adapters/<名前>.ts`）が持つ。`#/draft`・`#/expand`・`#/edit` を開けないときに使えないツアーは `unavailableIf` で、`src/app/guards.ts` の `evaluateGuards` と同じ判定の条件（`draft-unavailable` など）を指す。状態が満たされたことを知らせるイベント（プロトコルの解析、ブロックの承認、自動調整の開始、境界事例の取得、編集の保存）は、ビューやサービスから投げず、アダプタの `risingEvents` が `AppState` の立ち上がりから作る。画面ごとの手順の一覧は [ui-states.md](ui-states.md) の「ツアーの一覧」。

ツアーを 1 本足す手順:

1. `src/lib/guide/tours/types.ts` の `GuideTourId` に ID を足し、`src/lib/guide/tours/<名前>.ts` に定義を書く（ツアー固有のイベント・条件があればそのファイルで型を `export` する）。
2. `tours/index.ts` の `GuideEventName` / `GuideCondition` に固有の型を足し、`GUIDE_TOURS` に登録する。
3. 固有の条件・イベントがあれば `src/app/guide/adapters/<名前>.ts` に書き、`adapters/index.ts` と `tourConditions.ts` に合成する。
4. 手順の対象になる要素に `data-tour` を付ける。実行時に組み立てる値は、`src/lib/guide/tours/tours.test.ts` の「定義と実装の照合」に規則を足す。
5. `src/lib/i18n/ja.ts` と `en.ts` に文言を足す。見出しは `guide.tour<ID>Title`、説明は `guide.tour<ID>Desc`、手順の本文は `guide.tour<ID>Step<手順ID>`（`keys.ts` が生成する形）。
6. テスト（定義の照合・単体・E2E）を足す。E2E の共通スタブは既定で提案帯を止めているので、提案帯を検証する spec だけが `guide_progress` を明示的に渡す。
7. 通し検査のシナリオ `tools/guide-tour-check/scenarios/<ID>.mjs` を足す（ファイル名とシナリオ名はツアー ID と同じにする）。短い解説動画の対象にするなら `video/scripts/tour-videos.mjs` の `DEFAULT_TOURS` にも足す。

#### 通し検査と短い解説動画

| 場所 | 役割 |
|---|---|
| `tools/guide-tour-check/` | 通し検査（`npm run check:tours`）。デモビルド（`dist-demo/`）を本物の Chromium に拡張として読み込み、ツアーを 1 手順ずつ実際に進める。各手順で「カードが出ている・対象に強調枠が重なっている・カードが画面内」を確かめ、画像を `.tmp/guide-tour-check/<ツアー ID>-<連番>-<手順 ID>.png` に残す。シナリオはツアーごとに 1 本（`scenarios/<ID>.mjs`）で、プロトコルの解析・ブロックの承認・自動調整・境界事例の判定・変換など、手順が前提とする操作を実際に行って、できるだけ全手順で対象が画面に出ている状態を撮る。デモの通信の差し替えで再現できない状態（保留候補など）の手順は、待機の状態で撮り、検査の集計に警告として載る |
| `video/scripts/tour-videos.mjs` | ツアー 1 本につき 1 本の短い解説動画（`npm run video:tours`）。通し検査の画像と、辞書の文面（ナレーション原稿）から作る。手順は [video/README.md](../video/README.md) の「操作ツアーの解説動画」 |

ツアーの手順や文面・対象を変えたら、`npm run build:demo` → `npm run check:tours` を回す。本物のブラウザの窓が要るため CI では回らない（`npm run test:tools` は、検査と動画生成の部品の単体テストだけを CI で回す）。`check:tours` が落ちる変更は、短い動画の撮り直しも要る合図になる。ツアーの手順や文面を変えたら、動画も `npm run video:tours` で作り直す。`--lang en` で英語のカードも確かめられる。

#### 「?」メニューと対応表

各画面の見出し（`#app-content` の最初の `h2`）の直後の兄弟として「?」ボタン（`.guide-help-btn`）を置き（見出しの子にすると読み上げ名にボタンの `aria-label` が混ざるため。見た目は CSS の `:has(+ .guide-help-btn)` で同じ行に並べる）、押すと小さなメニュー（`.guide-help-menu`）が開く。項目は「ヘルプを読む」（公開ヘルプの該当節を新しいタブで開く）、「この機能の動画を見る」（解説動画の該当章を開始秒つきで新しいタブで開く）、「ここからツアーを始める」（トピックにツアーがあり、今使えるときだけ）、「ツアーの一覧」。

| 場所 | 役割 |
|---|---|
| `src/lib/guide/topics.ts` | 対応表（UI・通信に依存しない）。`GUIDE_TOPICS`（トピック ID → ヘルプの節 id・動画の章・ツアー ID）、`GUIDE_VIDEO_ID`、`GUIDE_VIDEO_CHAPTERS`（章の開始秒）、`buildHelpUrl` / `buildVideoUrl` / `topicForRoute`。トピック ID は今はルート名と 1:1 |
| `src/app/guide/helpButton.ts` | 「?」ボタンの生成と、表示領域への差し込み（`mountHelpButtons`）。文字は CSS の `::before` で出し、ボタンの `textContent` は空。`data-help-topic="<トピック ID>"` を持つ要素の直後にも同じ「?」が入る。直前の兄弟が自分の対象でなくなったボタンは外す |
| `src/app/guide/helpMenu.ts` | メニューの開閉・位置・フォーカス・言語切替での作り直し。画面の描き直しで「?」が作り直されたら、同じトピックの「?」へ付け替える（`refresh`）。`document` への委譲クリックで「?」を拾う |
| `src/app/guide/index.ts` | `initGuide` が表示領域の描き直しを監視し（1 フレームに 1 回へ間引く）、「?」を差し直す。既存のビューは変えない |

照合は `src/lib/guide/topics.test.ts` が行う（`helpAnchor` が `hosted/help.html` の `id` に実在すること、動画 ID が `hosted/help.html` と `hosted/index.html` の埋め込みと一致すること、`hosted/help.html` の `?t=<秒>` が章の開始秒のどれかであること）。

トピックを 1 つ足す手順:

1. `GuideTopicId`（今は `RouteName`）に当たるルートを足し、`GUIDE_TOPICS` と `GUIDE_TOPIC_TITLE_KEYS` に行を足す。`helpAnchor` は `hosted/help.html` の `<section id>` に合わせる。
2. `src/lib/i18n/ja.ts` と `en.ts` に `guide.topic<Pascal>` を足す（ja は `ROUTE_LABELS` と同じ語）。
3. 対応する動画の章があれば `GUIDE_VIDEO_CHAPTERS` に足して `video` に指定する。ツアーがあれば `tourId` に指定する。
4. `hosted/help.html` に節と、章の動画リンク（`?t=<秒>`）を足す。

動画を上げ直したら、`GUIDE_VIDEO_ID`・`GUIDE_VIDEO_CHAPTERS` の開始秒・`hosted/index.html` と `hosted/help.html` の埋め込み・`hosted/help.html` の章リンクを一緒に直す。

## 3. ビルド構成

### 3.1 webpack エントリ

`webpack.config.js` は tiab-review-plugin のものを踏襲：

| エントリ | 出力（dev = `dist/`、production = `dist-release/`） |
|---|---|
| `src/background/service-worker.ts` | `background/service-worker.js` |
| `src/popup/popup.ts` | `popup/popup.js` |
| `src/app/app.ts` | `app/app.js` |
| `src/options/options.ts` | `options/options.js` |

出力先は `--mode` に応じて `output.path` を切り替える。**production ビルドは manifest から `key` フィールドを削除する**ため、unpacked 読込で拡張 ID が固定される dev ビルド（`key` あり）と同じディレクトリを共有すると、本番ビルドを誤って unpacked 読込したときに拡張 ID が変わり OAuth が通らなくなる事故が起きる。これを避けるため production だけ `dist-release/` へ分離している。ローカルでの実機確認（unpacked 読込 / Selenium ハーネス）は常に dev ビルド（`dist/`）を使う。

`copy-webpack-plugin` で以下をビルド出力先へ転写：

- `src/manifest.json`（`OAUTH_CLIENT_ID` 置換あり。production では `key` を削除）
- 各画面の `*.html` / `*.css`
- `src/icons/` / `src/_locales/` / `src/styles/`

### 3.2 npm スクリプト（tiab-review-plugin 準拠）

```json
{
  "scripts": {
    "dev": "webpack --mode development",
    "watch": "webpack --mode development --watch",
    "build": "webpack --mode production",
    "pack:release": "pwsh -NoProfile -File tools/release/pack.ps1",
    "lint": "eslint 'src/**/*.ts'",
    "typecheck": "tsc --noEmit",
    "test": "jest",
    "test:watch": "jest --watch",
    "test:coverage": "jest --coverage"
  }
}
```

### 3.3 `.env` 運用

tiab-review-plugin と同様、`.env` に `OAUTH_CLIENT_ID`（本番）と `LOCAL_OAUTH_CLIENT_ID`（開発）を置く。`webpack.config.js` が読み取って `manifest.json` に注入。`.env` は `.gitignore` 対象、`.env.example` をリポジトリに残す。

## 4. テスト方針

### 4.1 カバレッジ目標

[requirements.md §11.1](requirements.md) で確定した「**`src/` 配下の TS に対して行カバレッジ・分岐カバレッジ 100 %**」を達成する。サブモジュールは対象外。

`jest.config.ts` の `coverageThreshold` で機械的に強制：

```ts
coverageThreshold: {
  global: { branches: 100, functions: 100, lines: 100, statements: 100 }
}
```

### 4.2 テスト配置

- **ユニットテスト**: 各実装ファイルと同階層に `*.test.ts` を配置
- **統合テスト**: `tests/integration/` に配置（複数 features をまたぐシナリオ）
- **DOM テスト**: jsdom 環境でビュー関数の `render()` 出力を検証
- **E2E**: `tests/e2e/` の Playwright + axe。外部 API は stub で検証する

### 4.3 モック戦略

| 対象 | モック方法 |
|---|---|
| `chrome.*` API | `tests/setup/chrome-mock.ts` で `globalThis.chrome` を差し込み。jest の `setupFiles` で読み込む |
| Google Sheets / Drive API | `lib/google/*` の薄いラッパをモジュールモック。`fetch` をスタブして fixture を返す |
| NCBI E-utilities | 同上。`tests/fixtures/ncbi/*.xml` に実 API レスポンスを保存 |
| Gemini API | `lib/llm/GeminiProvider.ts` をモジュールモック |

### 4.4 100 % カバレッジ達成のための制約

- **エントリ（`popup.ts` / `app.ts` / `options.ts` / `service-worker.ts`）は起動フックのみ**にし、実処理は `bootstrap*.ts` 等に分離する（§2.3）。`bootstrap*.ts` は jsdom で `render()` を呼び回して 100 % 到達可能
- manifest.json はテスト対象外（`coveragePathIgnorePatterns` で除外）
- `src/_locales/` / `src/icons/` / `src/styles/` も除外
- ハードな分岐（`if (process.env.NODE_ENV === 'production')` 等）は使わず、依存注入で切り替える

### 4.5 除外パスの例

```ts
coveragePathIgnorePatterns: [
  '/node_modules/',
  '<rootDir>/src/manifest.json',
  '<rootDir>/src/_locales/',
  '<rootDir>/src/icons/',
  '<rootDir>/src/styles/',
  '<rootDir>/src/.*\\.html$',
  '<rootDir>/src/.*\\.css$'
]
```

## 5. コーディング規約

- **言語**: TypeScript（strict モード、`noUncheckedIndexedAccess` 有効）
- **コメント / コミット**: 日本語（`CLAUDE.md` の作業原則に準拠）
- **ファイル命名**: `camelCase.ts`、テスト `*.test.ts`、エントリは `popup.ts` 等の screen 名そのまま（tiab-review-plugin と合わせる）
- **エクスポート**: named export のみ（default export 禁止）
- **`any` 禁止**: 必要時は `unknown` 経由 + zod バリデータ
- **シークレット**: ログ出力は必ず `utils/sanitizeSecret.ts` 経由

## 6. 依存ライブラリ（MVP 想定）

| 用途 | ライブラリ | ライセンス |
|---|---|---|
| docx パース | fflate | MIT |
| マークダウンエディタ | @codemirror/* | MIT |
| Mermaid 描画 | mermaid | MIT |
| ランタイムバリデータ | zod | MIT |
| 結合式パーサ | jsep | MIT |
| ID 生成 | uuid | MIT |
| ビルド | webpack / ts-loader / copy-webpack-plugin / dotenv | MIT |
| テスト | jest / ts-jest / jest-environment-jsdom | MIT |
| Lint / Format | eslint / @typescript-eslint/* / prettier | MIT / BSD |

`THIRD_PARTY_NOTICES.md` に上記をまとめる（[requirements.md §11.1](requirements.md) 確定事項）。

## 7. 実装フェーズで承認を取るチェックポイント

1. **本ファイル全体の方針承認**（最初のスケルトン PR で）
2. **マークダウンエディタ**: CodeMirror 6 採用可否（バンドルサイズとのトレードオフ）
3. **結合式パーサ**: jsep（軽量）vs 独自実装
4. **100 % カバレッジ到達が難しいファイル**: 都度 exclude 申請
