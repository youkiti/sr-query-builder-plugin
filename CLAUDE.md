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
npm run build        # 本番ビルド（.env の OAUTH_CLIENT_ID 必須）
npm run build:zip    # ストア配布用 zip
npm test             # jest（jsdom）unit テスト
npm run test:e2e     # Playwright E2E（実 Chromium + axe a11y。API はすべて stub）
npm run test:e2e:ui  # Playwright UI モード
npm run typecheck    # tsc --noEmit
npm run lint         # eslint（src + tests）
npm run lint:css     # stylelint
```

単一テストの実行: `npx jest src/app/views/blocksView.test.ts`、E2E 単体: `npx playwright test tests/e2e/app-blocks.spec.ts`。

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
│   └── views/      # 各ルートの描画関数（DOM 直組み。RenderView 型）
├── features/       # ドメインロジック（protocol / seeds / formula / validation / conversion / project）
├── lib/            # 横断ライブラリ（google: OAuth+Sheets+Drive / llm: LLMProvider 抽象+Gemini / ncbi: E-utilities / combination-expression / search-formula-md）
├── popup/          # 認証・プロジェクト作成/選択の入口
├── options/        # BYOK 設定（Gemini API キー / NCBI API キー）
├── background/     # service-worker
└── manifest.json   # Manifest V3
```

- 状態管理: [store.ts](src/app/store.ts) の `AppState` が単一の真実。`protocolDraft` / `blocksDraft` 等は in-memory のみで、リロードで消える（Sheets が永続層）
- E2E hook: [app.ts](src/app/app.ts) は `window.__E2E_PRELOADED_STATE__` があればストアのシードに使う（テスト用 seam。本番動作には影響しない）
- テスト戦略は [docs/ui-review-strategy.md](docs/ui-review-strategy.md)（Tier 0〜3）と [docs/ui-deep-test-plan.md](docs/ui-deep-test-plan.md) を参照。E2E は LLM / Google / NCBI をすべて `page.route()` + chrome stub でモックする
- [docs/ui-states.md](docs/ui-states.md) は一部 target spec（実装より先行）。spec をテストに固定化する前に必ず実装と照合し、乖離は同ドキュメントの ⚠️ drift 注記へ

## 未実装・既知のギャップ

- **`.docx` パース未配線**: UI と型（`DocxExtractor`）はあるが、mammoth.js が未導入で extractor が注入されていない。現状 .docx をアップロードすると「パーサが注入されていません」エラーになる
- **P1 ロジック未移植**: `check_block_overlap` / `check_mesh` / `check_mesh_overlap`（ブロック重複・MeSH 分析）
- **LLM は Gemini のみ**（`LLMProvider` 抽象はあり。OpenAI / Claude / OpenRouter は後続）
- **CI/CD なし**（`.github/workflows/` 未配置。検証はローカルで `typecheck → test → test:e2e → lint → dev` を回す）
- E2E ジャーニー J1（新規作成→export 貫通）/ J4（expand キーボード判定）/ J5 の API エラー系は LLM・fetch stub の拡充待ち（[docs/ui-deep-test-plan.md](docs/ui-deep-test-plan.md) Phase D/E）

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
| `FormulaVersions` | version_id / formula_md / created_at / created_by / parent_version_id |
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

- **MVP は Gemini のみ**。後続で OpenAI / Anthropic Claude / OpenRouter を予定し、**`LLMProvider` 抽象**（[src/lib/llm/](src/lib/llm/)）を最初から設けてある。
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
- LLM: Gemini API（`LLMProvider` 抽象経由）
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
2. **日本語化**: ユーザー向けアーティファクト（計画書・タスク・要件書・コミットメッセージ・コード内コメント）は日本語で書く。思考プロセスだけ英語でよい。
3. **既存テスト保護**: 既存テストが落ちたら、まず実装のバグを疑う。テスト側を直す場合は「意図した仕様変更」であることをユーザーに確認する。
4. **ドキュメント同期**: 仕様や機能を変えたら、関連ドキュメント（README、仕様書、コメント）も同時に更新する。
5. **機密情報**: API キー・OAuth トークン等はログ／アーティファクト／チャット応答に絶対出さない。`.env` の扱いに注意。トークンをログに出すときは `token.substring(0, 8) + '...'` で省略する。
6. **自動化の限界**: ツール実行が複数回失敗したら執拗に再試行せず、状況を報告する。
7. **テスト通過後の dev ビルド検証**: 実装変更のテスト (`npm test`) が通ったら、作業完了を報告する前に必ず `npm run dev` を実行して webpack が成功することを確認する。型チェック・単体テストだけでは webpack の解決エラー（import パス・asset 参照など）を拾いきれないため。本番ビルド (`npm run build`) は `.env` の `OAUTH_CLIENT_ID` を要求するので、ローカル検証では dev ビルドを基準にする。ビルドが壊れた状態で「完了」報告をしない。
8. **UI 変更時は E2E も回す**: 画面・CSS・ルーティングに触れたら `npm run test:e2e` まで通す（axe の a11y 検証を含む）。
