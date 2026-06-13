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
│   └── integration/               # 複数機能をまたぐシナリオテスト
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

tiab-review-plugin と同じ方針で、**UI ライブラリは使わず素の TypeScript + DOM API** で実装する。画面ごとのフォルダ（`popup/` / `app/` / `options/` / `background/`）に HTML・CSS・TS を同居させ、webpack の `copy-webpack-plugin` で `dist/` に転写する。

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
│   ├── app.css
│   ├── router.ts                  # #/home 等を各 view に振り分ける
│   ├── views/                     # 画面ごとの純粋な render 関数
│   │   ├── homeView.ts
│   │   ├── protocolView.ts
│   │   ├── blocksView.ts
│   │   ├── seedsView.ts
│   │   ├── draftView.ts            # 検索式の生成 + 検証を統合（旧 validateView を吸収）
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
│   │   ├── parseDocx.ts           # mammoth.js ラッパ
│   │   ├── parseMarkdown.ts
│   │   └── extractBlocks.ts       # extract-protocol skill 呼び出し
│   ├── seeds/
│   │   ├── parseNbib.ts
│   │   ├── parseRis.ts
│   │   ├── resolvePmidByDoi.ts
│   │   ├── verifyPmid.ts
│   │   └── seedRepository.ts      # SeedPapers タブ I/O
│   ├── formula/
│   │   ├── skills/                # 4 skill
│   │   │   ├── blockDesigner.ts
│   │   │   ├── meshSuggester.ts
│   │   │   ├── freewordDesigner.ts
│   │   │   └── filterDesigner.ts
│   │   ├── assembleFormulaMd.ts
│   │   └── parseFormulaMd.ts
│   ├── validation/                # search-formula-developper からの TS 移植
│   │   ├── checkSearchLines.ts
│   │   ├── checkFinalQuery.ts
│   │   ├── extractMesh.ts
│   │   └── checkBlockOverlap.ts   # P1
│   ├── conversion/
│   │   ├── toCentral.ts
│   │   ├── toDialog.ts
│   │   ├── toClinicalTrials.ts
│   │   ├── toIctrp.ts
│   │   └── generateAll.ts
│   └── interactive/
│       ├── pickBoundaryCases.ts
│       └── recordDecision.ts
│
├── lib/                           # 外部 API / 低レベルユーティリティ
│   ├── google/
│   │   ├── auth.ts                # chrome.identity.getAuthToken ラッパ
│   │   ├── sheets.ts              # Sheets API（バッチ書き込み / 読み取り）
│   │   ├── drive.ts               # Drive API
│   │   └── identity.ts            # chrome.identity.getProfileUserInfo ラッパ
│   ├── ncbi/
│   │   ├── eutils.ts              # esearch / efetch / esummary
│   │   ├── pubmedUrl.ts
│   │   └── rateLimit.ts
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

## 3. ビルド構成

### 3.1 webpack エントリ

`webpack.config.js` は tiab-review-plugin のものを踏襲：

| エントリ | 出力 |
|---|---|
| `src/background/service-worker.ts` | `dist/background/service-worker.js` |
| `src/popup/popup.ts` | `dist/popup/popup.js` |
| `src/app/app.ts` | `dist/app/app.js` |
| `src/options/options.ts` | `dist/options/options.js` |

`copy-webpack-plugin` で以下を `dist/` へ転写：

- `src/manifest.json`（`OAUTH_CLIENT_ID` 置換あり）
- 各画面の `*.html` / `*.css`
- `src/icons/` / `src/_locales/` / `src/styles/`

### 3.2 npm スクリプト（tiab-review-plugin 準拠）

```json
{
  "scripts": {
    "dev": "webpack --mode development",
    "watch": "webpack --mode development --watch",
    "build": "webpack --mode production",
    "build:zip": "npm run build && cd dist && zip -r ../sr-query-builder-plugin.zip .",
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
- **E2E**: MVP では割愛（実ブラウザ動作確認は手動）

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
| docx パース | mammoth | BSD-2-Clause |
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
