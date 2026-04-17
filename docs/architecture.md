# ディレクトリ構造案 / アーキテクチャ概要（v0.1）

- **作成日**: 2026-04-17
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
├── public/                        # Manifest / 静的 HTML / アイコン
│   ├── manifest.json
│   ├── popup.html
│   ├── app.html                   # メインビュー
│   ├── options.html
│   └── icons/
├── src/                           # TypeScript ソース（後述 §2）
├── tests/                         # ユニット・統合テスト（後述 §4）
├── experiments/                   # LLM プロンプト検証用スクリプト（実装フェーズで追加）
├── search-formula-developper/     # サブモジュール（参照実装）
├── tiab-review-plugin/            # サブモジュール（技術スタック参照）
├── package.json
├── tsconfig.json
├── webpack.config.js
├── jest.config.ts
├── .eslintrc.cjs
├── .prettierrc
├── THIRD_PARTY_NOTICES.md         # MIT 等のライセンス表記まとめ
├── LICENSE                        # MIT
├── README.md
└── CLAUDE.md
```

## 2. `src/` 配下

レイヤを 4 層に分け、上位レイヤは下位のみを import する単方向依存：

```
src/
├── entries/                       # Webpack エントリポイント
│   ├── popup/
│   │   ├── index.ts
│   │   └── Popup.tsx
│   ├── app/                       # メインビュー（フルページ）
│   │   ├── index.ts
│   │   └── App.tsx
│   ├── options/
│   │   ├── index.ts
│   │   └── Options.tsx
│   └── background/
│       └── service-worker.ts      # MV3 service worker（OAuth 更新等）
│
├── views/                         # 画面コンポーネント（ハッシュルートごと）
│   ├── HomeView/
│   ├── ProtocolView/
│   ├── BlocksView/
│   ├── SeedsView/
│   ├── DraftView/
│   ├── ValidateView/
│   ├── ExpandView/
│   ├── EditView/
│   ├── ExportView/
│   ├── DoneView/
│   └── HistoryView/
│
├── components/                    # 汎用 UI 部品（ボタン / モーダル / トースト等）
│   ├── Button.tsx
│   ├── Modal.tsx
│   ├── Toast.tsx
│   └── ...
│
├── features/                      # ドメイン機能（ビジネスロジック）
│   ├── project/                   # プロジェクト作成 / 切替
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
│   │   ├── assembleFormulaMd.ts   # 4 skill 出力を search_formula.md 派生に整形
│   │   └── parseFormulaMd.ts      # 逆方向（編集後の md → 内部表現）
│   ├── validation/                # search-formula-developper からの TS 移植
│   │   ├── checkSearchLines.ts    # 行ごとヒット数
│   │   ├── checkFinalQuery.ts     # シード捕捉率
│   │   ├── extractMesh.ts         # MeSH 抽出
│   │   └── checkBlockOverlap.ts   # P1
│   ├── conversion/                # 4 DB 変換
│   │   ├── toCentral.ts
│   │   ├── toDialog.ts
│   │   ├── toClinicalTrials.ts
│   │   ├── toIctrp.ts
│   │   └── generateAll.ts
│   └── interactive/               # 対話的シード拡張
│       ├── pickBoundaryCases.ts   # 50→5 件抽出
│       └── recordDecision.ts
│
├── lib/                           # 外部 API / 低レベル util
│   ├── google/
│   │   ├── auth.ts                # chrome.identity.getAuthToken ラッパ
│   │   ├── sheets.ts              # Sheets API（バッチ書き込み / 読み取り）
│   │   ├── drive.ts               # Drive API（フォルダ作成 / ファイル保存）
│   │   └── identity.ts            # chrome.identity.getProfileUserInfo ラッパ
│   ├── ncbi/
│   │   ├── eutils.ts              # esearch / efetch / esummary
│   │   ├── pubmedUrl.ts           # 検索式 → PubMed URL
│   │   └── rateLimit.ts           # 指数バックオフ
│   ├── llm/
│   │   ├── LLMProvider.ts         # interface
│   │   ├── GeminiProvider.ts      # MVP 実装
│   │   ├── providerFactory.ts     # Config から選択
│   │   └── apiLogger.ts           # LLMApiLog + Drive 保存
│   ├── storage/
│   │   ├── chromeStorage.ts       # chrome.storage.local 型付きラッパ
│   │   └── secretsStore.ts        # API キー保存（マスク表示用ヘルパ含む）
│   └── search-formula-md/         # フォーマット parser/serializer 共通化
│       ├── tokenize.ts
│       ├── parse.ts
│       └── serialize.ts
│
├── domain/                        # 型定義 / スキーマ（純粋型のみ、依存ゼロ）
│   ├── project.ts
│   ├── protocol.ts
│   ├── seedPaper.ts
│   ├── formulaVersion.ts
│   ├── validationLog.ts
│   ├── conversion.ts
│   ├── llmApiLog.ts
│   └── sheetsSchema.ts            # 9 タブの列定義（実 I/O は features/* / lib/google/sheets で）
│
├── styles/
│   ├── globals.css
│   └── tokens.css                 # カラー / 余白 / フォントトークン
│
└── utils/
    ├── uuid.ts
    ├── iso8601.ts
    ├── markdown.ts
    └── sanitizeSecret.ts          # token.substring(0, 8) + '...' 用
```

### 2.1 レイヤ依存ルール

```
entries  →  views  →  components / features
                              ↓
                            lib / domain
                              ↓
                            utils
```

- 上位は下位を import 可、逆は不可
- `domain/` は純粋型 + Zod 等のバリデータのみ。runtime 依存ゼロ
- `lib/google/sheets.ts` 等は `domain/sheetsSchema.ts` を参照するが、`features/*` は参照しない（features は domain 経由でアクセス）
- ESLint の `import/no-restricted-paths` で機械的に強制

### 2.2 UI フレームワーク選定

- **Preact + Signals** 推奨（バンドルサイズ < 10 KB、React 互換 API）
- 代替案: React + Zustand。tiab-review-plugin と揃える場合はこちら
- **実装フェーズで開発者承認を取るポイント**: tiab-review-plugin が React 採用なら React に揃える

## 3. ビルド構成

### 3.1 webpack エントリ

`webpack.config.js` で以下 4 エントリをビルド：

| エントリ | 出力 |
|---|---|
| `src/entries/popup/index.ts` | `dist/popup.js` |
| `src/entries/app/index.ts` | `dist/app.js` |
| `src/entries/options/index.ts` | `dist/options.js` |
| `src/entries/background/service-worker.ts` | `dist/service-worker.js` |

`public/*.html` は `copy-webpack-plugin` で `dist/` に転写し、`<script src="...">` で対応 JS を読み込む。

### 3.2 npm スクリプト（tiab-review-plugin 準拠）

```json
{
  "scripts": {
    "dev": "webpack --mode development",
    "watch": "webpack --mode development --watch",
    "build": "webpack --mode production",
    "build:zip": "npm run build && cd dist && zip -r ../sr-query-builder-plugin.zip .",
    "lint": "eslint 'src/**/*.{ts,tsx}'",
    "typecheck": "tsc --noEmit",
    "test": "jest",
    "test:watch": "jest --watch",
    "test:coverage": "jest --coverage"
  }
}
```

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
- **E2E**: MVP では割愛（実ブラウザ動作確認は手動）

### 4.3 モック戦略

| 対象 | モック方法 |
|---|---|
| `chrome.*` API | `tests/setup/chrome-mock.ts` で `globalThis.chrome` を差し込み |
| Google Sheets / Drive API | `lib/google/*` をモジュールモック。fetch をスタブして fixture を返す |
| NCBI E-utilities | 同上。`tests/fixtures/ncbi/*.xml` に実 API レスポンスを保存して再利用 |
| Gemini API | `lib/llm/GeminiProvider.ts` をモジュールモック |

### 4.4 100 % カバレッジ達成のための制約

- `lib/google/auth.ts` 等の `chrome.identity` 直叩き部分は薄く保ち、テスト可能なロジックは `features/*` 側に集約
- ハードな分岐（`if (process.env.NODE_ENV === 'production')` 等）は使わず、依存注入で切り替える

## 5. コーディング規約

- **言語**: TypeScript（strict モード、`noUncheckedIndexedAccess` 有効）
- **コメント / コミット**: 日本語（`CLAUDE.md` の作業原則に準拠）
- **ファイル命名**: コンポーネント `PascalCase.tsx`、その他 `camelCase.ts`、テスト `*.test.ts`
- **エクスポート**: named export のみ（default export 禁止）
- **`any` 禁止**: 必要時は `unknown` 経由 + Zod バリデータ
- **シークレット**: ログ出力は必ず `utils/sanitizeSecret.ts` 経由

## 6. 依存ライブラリ（MVP 想定）

| 用途 | ライブラリ | ライセンス |
|---|---|---|
| UI | preact + @preact/signals | MIT |
| docx パース | mammoth.js | BSD-2-Clause |
| マークダウンエディタ | @codemirror/* | MIT |
| Mermaid 描画 | mermaid | MIT |
| バリデータ | zod | MIT |
| 結合式パーサ | jsep | MIT |
| ID 生成 | uuid | MIT |
| ビルド | webpack / ts-loader / copy-webpack-plugin | MIT |
| テスト | jest / ts-jest / @testing-library/preact | MIT |
| Lint / Format | eslint / prettier | MIT |

`THIRD_PARTY_NOTICES.md` をルートに置き、配布時に上記をすべて列挙する（[requirements.md §11.1](requirements.md) 確定事項）。

## 7. 実装フェーズで承認を取るチェックポイント

1. **本ファイル全体の方針承認**（最初のスケルトン PR で）
2. **UI フレームワーク**: Preact vs React（tiab-review-plugin との整合）
3. **マークダウンエディタ**: CodeMirror 6 採用可否
4. **結合式パーサ**: jsep（軽量）vs 独自実装
5. **テスト 100 % が現実的でないファイル**（例: `entries/background/service-worker.ts` は副作用主体）の `coverage exclude` 申請
