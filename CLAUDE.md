# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 現在のフェーズ

**要件定義フェーズ**。`src/`・`package.json`・Manifest などの実装資産はまだ存在しない。ルートにあるのは 2 つの Git サブモジュール（下記）と `.gitignore` / `.gitmodules` のみ。

新しい UI 機能やビルドスクリプトを追加する前に、このリポジトリが「何を作ろうとしているのか」を理解しておくこと。

## 目的（ゴール）

MIT ライセンスの OSS Chrome 拡張 **sr-query-builder-plugin** を開発する。ユーザーフロー：

1. 研究プロトコル（RQ・PICO・組入/除外基準）を入力
   - 手入力 / `protocol.md` アップロード / `.docx` アップロード の 3 系統に対応
   - 入力直後に「シード論文があれば PMID を登録」フローを提示。無ければ後で対話的に収集
2. 生成 AI で PubMed 検索式のドラフトを作成
3. `search-formula-developper` 相当の検証ロジックで検証・最適化（シード論文捕捉率、MeSH 分析、ブロック重複分析など）。検索式作成途中で「この論文は組入対象ですか？」と候補をユーザーに尋ね、シード集合を動的に育てるフローも含む
4. 最終的な PubMed 検索式を、他データベース（CENTRAL / Embase(Dialog) / ClinicalTrials.gov / ICTRP）へ変換して出力し、PubMed の nbib ダウンロードボタンを起動するところまで案内する

`search-formula-developper` は AI で作った検索式を人間と対話的に検証・変換する Python ツール群。本拡張はその対話部分をブラウザ UI として提供し、**ロジックは TypeScript へ移植**する方針（サブモジュールはリファレンス実装・テスト用データ源）。

## 確定している要件（要件定義フェーズの合意事項）

### データ保存

- **Google Sheets を共有 DB として使用**（tiab-review-plugin と同じ思想）。監査ログ・バージョニング目的で、プロトコル・検索式ドラフト・検証結果・LLM API ログをすべてシートに残す。
- プロトコル入力は手入力・`protocol.md`・`.docx` の 3 形式に対応。`.docx` は拡張内でパースする（Python を使わないので [mammoth.js](https://github.com/mwilliamson/mammoth.js) など TS ライブラリを利用予定）。

#### Sheets タブ設計（要件定義の合意）

詳細は [docs/requirements.md §3.1](docs/requirements.md) 参照。1 スプレッドシート = 1 プロジェクト = 1 Drive フォルダの紐づけで、**プロジェクト識別子は `Meta` タブに 1 行だけ保持**（他タブに `project_id` 列は持たせない）。

| タブ名 | 役割 |
|---|---|
| `Meta` | プロジェクト識別（`project_id` / `drive_folder_id` / `spreadsheet_id` / `schema_version`）。1 スプレッドシート = 1 行。統合アプリは Meta タブだけ読めば紐づけできる |
| `Protocol` | RQ / フレームワーク種別（pico/peco/pcc/spider/custom）/ 組入除外基準 / `combination_expression` / 元テキストへの Drive URL（versioning あり） |
| `ProtocolBlocks` | 1〜5 個の検索式ブロック定義。`search_formula.md` の `#1`〜`#5` と 1:1 対応。PICO 固定ではなく汎用ブロックモデル。LLM が抽出 → ユーザーが承認/編集 |
| `SeedPapers` | PMID / title / source（`initial` or `interactive`）／ユーザー判定（include / exclude / maybe） |
| `FormulaVersions` | version_id / formula_md / created_at / created_by / parent_version_id |
| `ValidationLog` | version_id / total_hits / capture_rate / captured_pmids / missed_pmids |
| `Conversions` | version_id / target_db / converted_formula / exported_at |
| `LLMApiLog` | timestamp / provider / model / purpose / prompt_ref / response_ref / tokens_in / tokens_out / latency_ms / error。フル payload は Drive の `{drive_folder_id}/logs/llm/{log_id}.json` に保存、Sheet には URL と要約のみ |
| `Config` | LLM プロバイダ設定・API キーの参照（キー本体は `chrome.storage` 側） |

### シード論文の対話的拡張フロー

検索式ドラフト後、AI が**境界事例っぽい数件**を検索結果から選び、ユーザーに include / exclude / maybe をワンクリックで判定させる。`include` は `SeedPapers` に `source=interactive` として追加され、直後に `check_final_query` 相当の再検証で捕捉率を再計算する。

### CLI 連携方式

- **選択肢 (a): Python CLI を TypeScript へ移植**。
  - 理由: OSS として Chrome Web Store 配布する際、ユーザーに Python 環境を要求しない方が圧倒的に楽。Native Messaging は拡張単体インストールで済まないため採用しない。
  - 移植元は [search-formula-developper/scripts/](search-formula-developper/scripts/)。テストデータ・参照実装として使うだけで、本体からは呼び出さない。
  - NCBI E-utilities はブラウザから直接 `fetch` で叩く（CORS は `host_permissions` で解決）。

#### 移植スコープの優先度

- **P0（MVP 必須）**:
  - `scripts/search/term_validator/check_search_lines.py` — 行ごとのヒット数
  - `scripts/search/query_executor/check_final_query.py` — シード論文捕捉率
  - `scripts/conversion/generate_all_database_search.py` — 全 DB 一括変換
  - `scripts/search/extract_mesh.py` — seed PMID から MeSH 抽出
- **P1（MVP 後半〜拡張）**:
  - `scripts/search/term_validator/check_block_overlap.py` — ブロック重複分析
  - `scripts/search/mesh_analyzer/check_mesh.py` / `check_mesh_overlap.py`
- **P2（将来 or 対象外）**:
  - ERIC 系全般（`scripts/search/eric/*`）
  - Ovid → PubMed 変換（`scripts/conversion/ovid/*`）
  - `search_results_to_review/search_results_processor.py`（Rayyan CSV — **対象外**）

### CLI 連携方式

- **選択肢 (a): Python CLI を TypeScript へ移植**。
  - 理由: OSS として Chrome Web Store 配布する際、ユーザーに Python 環境を要求しない方が圧倒的に楽。Native Messaging は拡張単体インストールで済まないため採用しない。
  - 移植元は [search-formula-developper/scripts/](search-formula-developper/scripts/)。テストデータ・参照実装として使うだけで、本体からは呼び出さない。
  - NCBI E-utilities はブラウザから直接 `fetch` で叩く（CORS は `host_permissions` で解決）。

### LLM 戦略

- **MVP は Gemini のみ**（tiab-review-plugin の `src/lib/gemini-api.ts` を踏襲）。
- 後続拡張で OpenAI / Anthropic Claude / OpenRouter をサポート予定なので、**プロバイダ抽象化レイヤ**（`LLMProvider` インターフェース）を最初から設ける。
- API キーは **BYOK**（Bring Your Own Key）で確定。`chrome.storage` に保存し、UI に設定画面を持つ。
- AI の役割: 検索式のドラフト生成のみならず、MeSH 提案・シノニム展開・ブロック改善案・検証結果の解釈補助まで担う。完成までのワークフロー全体のアシスタント。

### 出力物（MVP）

- PubMed 検索式 `.md`（`search-formula-developper` の `search_formula.md` フォーマットと互換: `## PubMed/MEDLINE` セクション、コードブロック、`#N` 行番号、最終行 `#N AND #M`）
- 他 DB 変換済みファイル: CENTRAL / Embase(Dialog) / ClinicalTrials.gov / ICTRP（ERIC・Ovid は後回し検討）
- **作らない**: PRISMA 用記述ブロック、Rayyan 連携、nbib のダウンロード自動化自体（PubMed 側のダウンロードボタンまで誘導するだけ）、スクリーニング機能、重複除去、全文 PDF 取得。
- 後続の tiab-reviewer 等との連携を想定し、**データ受け渡しフォーマットは明文化**しておく（Sheets のタブ設計＋エクスポート用 JSON スキーマ）。将来の統合アプリで接続コストを下げるのが目的。

### スコープ境界

本拡張の責務は「研究プロトコル → 検証済み検索式 → 各 DB で抄録をダウンロードするところまで案内」。スクリーニング以降は tiab-review-plugin / 外部ツールに引き渡す。

### 統合アプリ視点の将来設計（繋ぎ込み前提）

将来的に、複数の SR 系 Chrome 拡張（本拡張、tiab-review-plugin、データ抽出拡張 …）を束ねる **統合 Chrome 拡張** を構築する想定。統合アプリ自身も Google Sheets を集約ストアとして持ち、各下位拡張のスプレッドシートを一元管理する（＝各拡張は独立のスプレッドシートを持ち続け、統合アプリはそのリストと上位メタデータを別のスプレッドシートで保有）。

この前提から、本拡張は最初から以下を満たすよう設計する：

- **スプレッドシートに `project_id`（UUID v4、本拡張がプロジェクト作成時に自動発行）を全タブに持たせる**。統合アプリは後日導入されるので、MVP 時点では本拡張が発行責任を持つ。紐づけは将来、統合アプリ側で「対象スプレッドシートを手動選択」する運用とし、ID 衝突や人手入力ミスを避ける。
- **データ受け渡しフォーマットを明文化する**（Sheets のタブ設計 + エクスポート用 JSON スキーマ）。統合アプリはこのスキーマだけ知っていればよい状態にする。
- 下位アプリ間の遷移は「統合アプリが該当スプレッドシートを開く / 該当拡張のメインビュー（フルページタブ）を起動する」方式で、データコピーは原則行わない。

## 技術スタック（予定）

[tiab-review-plugin](tiab-review-plugin/) に準拠：

- Chrome Extension Manifest V3（メインビューは `chrome.tabs.create` で開くフルページ、Side Panel API は使わない。補助的に Popup + Background）
- TypeScript / HTML / CSS
- webpack ビルド
- Google OAuth 2.0（`chrome.identity`）+ Google Sheets / Drive API
- LLM: Gemini API（`src/lib/gemini-api.ts` パターン）
- Node.js ≥ 18

スクリプト構成（`npm run dev` / `watch` / `build` / `build:zip` / `lint` / `typecheck`）と `experiments/` による LLM 検証フローも tiab-review-plugin を踏襲する想定。

## サブモジュール

| パス | 役割 | 参照すべきドキュメント |
|---|---|---|
| [tiab-review-plugin/](tiab-review-plugin/) | 技術スタックとアーキテクチャの参照実装（別の Chrome 拡張） | [tiab-review-plugin/AGENTS.md](tiab-review-plugin/AGENTS.md) |
| [search-formula-developper/](search-formula-developper/) | PubMed 検索式の検証・変換 CLI（Python 3.7+） | [search-formula-developper/CLAUDE.md](search-formula-developper/CLAUDE.md), [search-formula-developper/Readme.md](search-formula-developper/Readme.md) |

サブモジュール内で作業するときは、そのサブモジュールの CLAUDE.md / AGENTS.md を最優先する。ここ（ルート CLAUDE.md）は「2 つをどう統合するか」だけを扱う。

### サブモジュール操作の注意

- サブモジュールは独立リポジトリ。ルートからの `git submodule update` と、サブモジュール内での `git pull` / コミットを混同しないこと。
- 新しいサブモジュールを追加する必要がある場合は `git submodule add <url> <path>` を使い、`.gitmodules` の差分をコミットする。

## 作業上の原則（tiab-review-plugin/AGENTS.md より継承）

要件定義フェーズでも、今後の実装フェーズでも以下を守る。ルート直下で新規ファイルを追加するときも同じ：

1. **ブランチ強制**: `main` / `master` / `develop` で直接作業しない。変更前に作業ブランチを切る。
2. **日本語化**: ユーザー向けアーティファクト（計画書・タスク・要件書・コミットメッセージ・コード内コメント）は日本語で書く。思考プロセスだけ英語でよい。
3. **既存テスト保護**: 既存テストが落ちたら、まず実装のバグを疑う。テスト側を直す場合は「意図した仕様変更」であることをユーザーに確認する。
4. **ドキュメント同期**: 仕様や機能を変えたら、関連ドキュメント（README、仕様書、コメント）も同時に更新する。
5. **機密情報**: API キー・OAuth トークン等はログ／アーティファクト／チャット応答に絶対出さない。`.env` の扱いに注意。トークンをログに出すときは `token.substring(0, 8) + '...'` で省略する。
6. **自動化の限界**: ツール実行が複数回失敗したら執拗に再試行せず、状況を報告する。

## 要件定義フェーズで意識すること

- このリポジトリ自体にはまだ CLI／テスト／ビルドはない。ルートで `npm` や `pytest` を叩いても動かない。テストやビルドが必要な作業はサブモジュールに入ってから行う。
- 要件／設計ドキュメントを新規に作る場合、まずルート直下（例: `docs/requirements.md` など）に日本語で起こし、tiab-review-plugin の AGENTS.md の「機能要件」「非機能要件」「データ設計」節を下敷きにする。
- 「PubMed 検索式の入出力フォーマット」や「search_formula.md パース要件」は [search-formula-developper/CLAUDE.md](search-formula-developper/CLAUDE.md) に既に定義されているので、拡張の I/O 設計はそれに合わせる（`## PubMed/MEDLINE` セクション、コードブロック、`#N` 行番号、最終行 `#N AND #M`）。
