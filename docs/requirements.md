# sr-query-builder-plugin 要件定義書（草案 v0.1）

- **作成日**: 2026-04-17
- **ステータス**: 要件定義フェーズ（実装未着手）
- **対応サブモジュール**:
  - [tiab-review-plugin](../tiab-review-plugin/)（技術スタック参照）
  - [search-formula-developper](../search-formula-developper/)（移植元ロジックの参照）

## 1. プロジェクト概要

### 1.1 プロダクト名

**sr-query-builder-plugin**（MIT ライセンス・OSS の Chrome 拡張）

### 1.2 目的

システマティックレビュー（SR）／スコーピングレビューにおける文献検索式開発を、研究プロトコル入力から各データベース向け検索式の生成・検証・変換まで一気通貫で支援する。外部 CLI や Python 環境を必要とせず、ブラウザ単体で完結させる。

### 1.3 ユーザーストーリー（ハイレベル）

```
研究者: プロトコル（RQ / 組入除外基準 / 元テキスト）を入力（手入力 or md / docx アップロード）
  → AI が検索式ブロック（1〜5 個、PICO / PECO / PCC / SPIDER 等のフレームワークに依らない汎用構造）を抽出、ドラフト提示
  → 研究者がブロックを承認 or 編集（ラベル変更・統合・分割・結合式の調整）
  → AI が PubMed 検索式ドラフトを提案（ブロック設計、MeSH 考案、フリーワード、検索フィルターを考える。これは skills で実装）
  → 拡張が自動でシード論文捕捉率・行ごとヒット数・MeSH 分析を実施
  → AI が境界事例の文献を数件ピックアップ、研究者が include/exclude を判定（とまらないように、ランダムに 50 件あるうちから 5 件とか）
  → シード集合から、検索式を再検証・最適化
  → 確定版の PubMed 検索式を CENTRAL / Embase / CT.gov / ICTRP に変換出力
  → 各 DB のダウンロード画面まで誘導（実際の nbib 取得はユーザーが手動）
```

### 1.4 スコープ境界

| カテゴリ | 本拡張の責務 | 責務外（他ツールに委譲） |
|---|---|---|
| プロトコル入力 | 手入力 / md / docx | — |
| 検索式作成 | AI ドラフト + 対話的ブラッシュアップ | — |
| 検索式検証 | シード捕捉率 / 行ごとヒット数 / MeSH 分析 / ブロック重複 | — |
| DB 変換 | CENTRAL / Embase(Dialog) / CT.gov / ICTRP | ERIC / Ovid（将来） |
| 抄録取得 | PubMed / CT.gov / ICTRP のダウンロード画面まで案内 | 実際のダウンロード操作 |
| スクリーニング | — | tiab-review-plugin |
| 重複除去 | — | tiab-review-plugin / 外部ツール |
| 全文 PDF 取得 | — | 別ツール |
| データ抽出 | — | 別拡張（未開発） |

## 2. 技術スタック

[tiab-review-plugin](../tiab-review-plugin/AGENTS.md) の構成に準拠：

| 項目 | 採用技術 |
|---|---|
| プラットフォーム | Chrome Extension Manifest V3 |
| UI | **ブラウザタブ全画面**（以降「メインビュー」と呼ぶ。Chrome の Side Panel API ではなく、`chrome.tabs.create({ url: chrome.runtime.getURL('app.html') })` で開く拡張オリジンのフルページ）+ Popup（拡張アイコンからプロジェクト選択等の補助操作）+ Options |
| 言語 | TypeScript / HTML / CSS |
| ビルド | webpack |
| 認証 | Google OAuth 2.0（`chrome.identity.getAuthToken`） |
| ストレージ | Google Sheets（主 DB）/ Google Drive（LLM ログの実体）/ `chrome.storage`（API キー、ローカルキャッシュ） |
| LLM（MVP） | Gemini API |
| LLM（将来） | OpenAI / Anthropic Claude / OpenRouter |
| docx パース | `mammoth.js`（TS） |
| Node.js | ≥ 18 |

### 2.1 OAuth スコープ

```
https://www.googleapis.com/auth/spreadsheets        # Sheets 読み書き
https://www.googleapis.com/auth/userinfo.email      # reviewer_id 用
https://www.googleapis.com/auth/drive.file          # Drive Picker + LLM ログ保存用
```

### 2.2 Manifest V3 要件

- `permissions`: `identity`, `storage`, `tabs`（メインビューを新規タブで開く用途）
- `host_permissions`:
  - `https://sheets.googleapis.com/*`
  - `https://www.googleapis.com/*`
  - `https://eutils.ncbi.nlm.nih.gov/*`（NCBI E-utilities）
  - `https://generativelanguage.googleapis.com/*`（Gemini API、将来拡張時に追加）
- `oauth2.client_id` / `scopes`（上記 2.1）
- `action.default_popup`: `popup.html`（プロジェクト選択＋メインビュー起動）
- メインビューは `dist/app.html` に配置し、`chrome.tabs.create` で開く（Side Panel API は使わない）

## 3. データ設計

### 3.1 Google Sheets スキーマ

1 プロジェクト = 1 スプレッドシート = 1 Drive フォルダ。タブは以下 9 つ。プロジェクト識別子（`project_id`）と Drive フォルダ ID は **`Meta` タブに 1 行だけ保持**し、他タブの行には持たせない（1 スプレッドシート内は同一プロジェクトなので冗長）。統合アプリはスプレッドシートの `Meta` タブを読めばプロジェクト ID と Drive 連携情報を取得できる。

**設計方針**: レビューの枠組みは PICO だけではない（PECO・PCC・SPIDER 等）。本拡張では固定の P/I/C/O カラムを持たず、「**1〜5 個の検索式ブロック**」を汎用的にモデル化する。各ブロックが `search_formula.md` の `#1`〜`#5` と 1:1 対応し、最終行の `combination_expression`（例: `#1 AND #2 AND #3`）でブロックを結合する。

**ブロック生成のフロー**（詳細は §4.2）:

1. ユーザーがプロトコルを入力（手入力 / md / docx）
2. `extract-protocol` skill がプロトコルを読み、**ブロックを自動抽出**してドラフトを生成（`block_label` も LLM が命名、ブロック数も LLM が決める）
3. ユーザーがメインビューで **承認 or 編集**（ラベル変更 / 統合・分割 / 順序変更 / 追加・削除）
4. 承認後に `Protocol` + `ProtocolBlocks` に保存

#### `Meta`

プロジェクトのアイデンティティ。**1 スプレッドシートに 1 行のみ**。プロジェクト作成時に書き込まれ、以後変更されない（`updated_at` 等は持たない）。

| 列 | 型 | 必須 | 説明 |
|---|---|---|---|
| project_id | string(uuid) | ✓ | 本拡張が UUID v4 で発行するプロジェクト識別子 |
| project_title | string | ✓ | ユーザーが付けたプロジェクト名 |
| spreadsheet_id | string | ✓ | 自己参照（デバッグ / 統合アプリ登録時の確認用） |
| drive_folder_id | string | ✓ | プロジェクトの Drive トップフォルダ ID。すべての付帯ファイル（`raw_protocols/`・`logs/`）はこの配下に配置 |
| schema_version | string | ✓ | 本拡張が書き込んだスキーマバージョン（例: `1.0`）。将来の移行用 |
| created_at | iso8601 | ✓ | |
| created_by | email | ✓ | プロジェクト作成者 |

> Drive の `drive_folder_id` があれば、拡張は「その配下の `logs/llm/{log_id}.json` を取りに行く」だけで LLM ログ本体にアクセスできる。`LLMApiLog.prompt_ref` / `response_ref` は将来的に folder 相対パス（`logs/llm/{log_id}.json`）に簡略化しても良い（MVP は絶対 URL のままで OK）。

#### `Protocol`

プロトコルのメタデータ。1 行 = 1 バージョン。

| 列 | 型 | 必須 | 説明 |
|---|---|---|---|
| version | int | ✓ | プロトコル改訂番号（1 から） |
| framework_type | enum | | `pico` / `peco` / `pcc` / `spider` / `custom` / null。LLM が推定してドラフトに入れ、ユーザーが変更可能。null 許容（custom と同義） |
| research_question | string | ✓ | RQ |
| inclusion_criteria | string | | 組入基準（改行区切り） |
| exclusion_criteria | string | | 除外基準（改行区切り） |
| study_design | string | | 対象デザイン（RCT / observational / any 等） |
| block_count | int | ✓ | 本プロトコルのブロック数（1〜5。`ProtocolBlocks` の整合性チェック用） |
| combination_expression | string | ✓ | ブロック結合式（例: `#1 AND #2 AND #3`、`(#1 AND #2) OR #3`）。MVP は全 AND を既定値としつつ、ユーザーが任意の論理式に編集可能。`search_formula.md` 最終行に出力される |
| source_type | enum | ✓ | `manual` / `markdown` / `docx` |
| source_filename | string | | アップロード時のファイル名（`manual` 時は null） |
| raw_text_ref | string(url) | | Drive に保存した元テキスト（`.md` / `.docx` から抽出したプレーンテキスト）の URL。`manual` 時は null |
| raw_text_preview | string | | 元テキストの先頭 500 文字（`manual` 時は null）。セル内で中身を一覧できるようにするため |
| created_at | iso8601 | ✓ | |
| created_by | email | ✓ | |

> **元テキスト保存ポリシー**: `markdown` / `docx` アップロード時は常に Drive に保存する（LLM ログと同じ監査性方針）。50,000 文字制限を気にせず原文を残せる。`manual` 入力はフォーム内容がそのまま `ProtocolBlocks.description` に入るので元テキスト保存は不要。

#### `ProtocolBlocks`

各ブロックの概念定義。1 行 = 1 ブロック（同じ `version` 内に 1〜5 行）。`search_formula.md` の `#N` と 1:1 対応。

| 列 | 型 | 必須 | 説明 |
|---|---|---|---|
| version | int | ✓ | `Protocol.version` への参照 |
| block_index | int | ✓ | 1〜5 |
| block_label | string | ✓ | LLM が付けたラベル。典型的には `Population` / `Intervention` / `Exposure` / `Concept` / `Context` / `Outcome` / `Sample` / `Phenomenon` / `Design` / `Evaluation` / `Research type` 等、または自由文字列。ユーザーが承認フェーズで書き換え可能 |
| description | string | ✓ | このブロックで捉えたい概念の自然言語記述。LLM の検索式生成プロンプト（`block-designer` skill）に渡す |
| ai_generated | bool | ✓ | LLM が生成したドラフトのままか、ユーザーが編集したか。監査用 |
| note | string | | 補足（なぜこの概念か、代替表現など） |

> **例**:
> - 介入研究 SR → `(Population, Intervention)` の 2 ブロック
> - 観察研究 → `(Population, Exposure)` の 2 ブロック
> - スコーピングレビュー → `(Population, Concept, Context)` の 3 ブロック
> - SPIDER（質的研究レビュー）→ `(Sample, Phenomenon of Interest, Design, Evaluation, Research type)` の 5 ブロック ← **上限**
> - 単純な有病率調査 → `(Population, Outcome)` の 2 ブロック

#### `SeedPapers`

**方針**: PMID が付いた seed は**すべて保存する**（ingest 時に E-utilities 存在確認で失敗したものも含む）。存在しない PMID（タイポ・削除・統合済み等）は `is_valid=false` で残し、検証ロジックではフィルタして無視する。これにより「入れたはずなのに消えてる」現象が起きず、ユーザーが修正・再 ingest しやすくなる。

PMID を一切取れない RIS 非 PubMed エントリは本タブには入らない（§4.3 のスキップサマリ UI のみ）。

| 列 | 型 | 必須 | 説明 |
|---|---|---|---|
| pmid | string | ✓ | ユーザーが入力 / ファイルから抽出した PMID。`is_valid=false` の場合も値は保持（ユーザーがどの PMID を入れようとしたかの記録） |
| title | string | | PubMed E-utilities から自動取得。`is_valid=false` では null |
| year | int | | 同上 |
| source | enum | ✓ | `initial`（初期登録） / `interactive`（対話的追加） |
| ingest_format | enum | ✓ | `pmid_direct`（ユーザーが PMID を直接入力）/ `nbib`（PubMed NBIB ファイル）/ `ris_pubmed`（RIS で `DB=PubMed` と明記）/ `ris_doi_resolved`（RIS 由来だが DOI を PubMed E-utilities で PMID に解決）/ `ris_pmid_field`（RIS の AN フィールドに PMID が入っていた）/ `interactive`（対話的拡張で抽出） |
| original_db | string | | `ris_*` 由来の場合、RIS の `DB` タグに書かれていた元 DB（`PubMed` / `Embase` / `CENTRAL` / `Scopus` 等）。監査用。`pmid_direct` / `nbib` / `interactive` の場合は null |
| is_valid | bool | ✓ | E-utilities で存在確認できたか。検索式の捕捉率計算等ではこの列が `true` の行のみ対象にする |
| exclusion_reason | enum | | `is_valid=false` の理由: `pmid_not_found`（E-utilities で PMID 不在）/ `duplicate_pmid`（同プロジェクト内で既存）/ `user_removed`（ユーザーが手動で無効化）。`is_valid=true` では null |
| user_decision | enum | | `include` / `exclude` / `maybe`（interactive 時必須） |
| decided_at | iso8601 | | |
| decided_by | email | | |
| note | string | | |

#### `FormulaVersions`

| 列 | 型 | 必須 | 説明 |
|---|---|---|---|
| version_id | string(uuid) | ✓ | |
| parent_version_id | string(uuid) | | 派生元バージョン |
| formula_md | string | ✓ | `search_formula.md` 互換マークダウン全文 |
| created_by | enum | ✓ | `ai_draft` / `user_edit` / `auto_optimize` |
| created_at | iso8601 | ✓ | |
| note | string | | 変更理由・コメント |

> `formula_md` は 50,000 文字上限に当たる可能性は低いが、超えた場合は Drive へ退避して URL を格納する（`LLMApiLog` と同方針）。

#### `ValidationLog`

| 列 | 型 | 必須 | 説明 |
|---|---|---|---|
| validation_id | string(uuid) | ✓ | |
| version_id | string(uuid) | ✓ | `FormulaVersions` への参照 |
| check_type | enum | ✓ | `line_hits` / `final_query` / `mesh` / `block_overlap` |
| total_hits | int | | 全体ヒット数（該当時） |
| capture_rate | float | | シード捕捉率（該当時） |
| captured_pmids | string | | カンマ区切り |
| missed_pmids | string | | カンマ区切り |
| detail_ref | string(url) | | 詳細レポート（行ごと内訳など）の Drive URL |
| executed_at | iso8601 | ✓ | |

#### `Conversions`

| 列 | 型 | 必須 | 説明 |
|---|---|---|---|
| conversion_id | string(uuid) | ✓ | |
| version_id | string(uuid) | ✓ | 変換元バージョン |
| target_db | enum | ✓ | `central` / `dialog` / `clinicaltrials` / `ictrp` |
| converted_formula | string | ✓ | 変換後マークダウン |
| warnings | string | | コンバータが出した警告 |
| exported_at | iso8601 | ✓ | |

#### `LLMApiLog`

| 列 | 型 | 必須 | 説明 |
|---|---|---|---|
| log_id | string(uuid) | ✓ | |
| timestamp | iso8601 | ✓ | |
| provider | enum | ✓ | `gemini` / `openai` / `anthropic` / `openrouter` |
| model | string | ✓ | モデル名（例: `gemini-2.5-pro`） |
| purpose | enum | ✓ | `draft_block` / `suggest_mesh` / `expand_freeword` / `design_filter` / `pick_boundary` / `interpret_result` / `extract_protocol` / `other` |
| prompt_ref | string(url) | ✓ | Drive に保存した full prompt JSON の URL |
| response_ref | string(url) | ✓ | Drive に保存した full response JSON の URL |
| prompt_summary | string | | 先頭 500 文字の抜粋（セル内表示用） |
| tokens_in | int | | |
| tokens_out | int | | |
| latency_ms | int | | |
| cost_estimate_usd | float | | プロバイダごとの単価で推定 |
| error | string | | 失敗時のエラーメッセージ |

> 50,000 文字制限を回避しつつ監査性を確保するため、フル payload は Drive の `{drive_folder_id}/logs/llm/{log_id}.json` として保存し、Sheet には URL と要約のみ格納する。

#### `Config`

| 列 | 型 | 必須 | 説明 |
|---|---|---|---|
| key | string | ✓ | 設定キー（`llm_provider`, `llm_model`, `export_nbib_count` など） |
| value | string | ✓ | |

> API キー本体は Sheet には保存せず、`chrome.storage.local` のみに保存する。

### 3.2 chrome.storage スキーマ

| キー | 値の形 | 用途 |
|---|---|---|
| `apiKeys.gemini` | string | Gemini API キー（BYOK） |
| `apiKeys.openai` | string | 将来拡張 |
| `apiKeys.anthropic` | string | 将来拡張 |
| `apiKeys.openrouter` | string | 将来拡張 |
| `currentProject` | `{ projectId, spreadsheetId, driveFolderId, title }` | 現在開いているプロジェクト |
| `recentProjects` | 上記の配列（最大 10） | クイック切替 |
| `llmLogCache` | `LLMApiLog` の直近 N 件（送信前キュー含む） | オフライン耐性 |

### 3.3 Google Drive 構造

プロジェクト作成時に、Drive 配下にトップフォルダを 1 つ作り、その中にスプレッドシート本体と付帯ファイル用のサブフォルダを配置する。トップフォルダの ID は `Meta.drive_folder_id` に保存され、以後すべての付帯ファイルはこの相対配下に置かれる。

```
マイドライブ/
└── sr-query-builder/
    └── {project_title}_{project_id_short}/     ← drive_folder_id が指すフォルダ
        ├── spreadsheet                         # Google Sheets 本体
        ├── raw_protocols/
        │   └── {version}_{source_filename}.txt   # Protocol の元テキスト（md / docx から抽出）
        └── logs/
            ├── llm/
            │   └── {log_id}.json        # LLMApiLog の full payload
            └── validation/
                └── {validation_id}.json  # ValidationLog の詳細データ
```

統合アプリや他ツールはスプレッドシートの `Meta` タブから `drive_folder_id` を取得し、上記既知の相対パスで各ファイルに直接アクセスできる（全ファイルをリストアップするような Drive 検索は不要）。

## 4. 機能要件（MVP）

### 4.1 プロジェクト管理

#### 新規プロジェクト作成フロー

1. ユーザーがプロジェクトタイトルを入力
2. `project_id`（UUID v4）を発行
3. **Drive トップフォルダを作成**（`マイドライブ/sr-query-builder/{project_title}_{project_id_short}/`）→ `drive_folder_id` 取得
4. トップフォルダ配下に `raw_protocols/` / `logs/llm/` / `logs/validation/` のサブフォルダを作成
5. 同フォルダ内に新規スプレッドシートを作成（`spreadsheets.create` + Drive API で親フォルダ指定）→ `spreadsheet_id` 取得
6. スプレッドシートに 9 タブを初期化
7. `Meta` タブに 1 行書き込み（`project_id` / `drive_folder_id` / `spreadsheet_id` / `schema_version=1.0` 等）
8. `chrome.storage.currentProject` に `{ projectId, spreadsheetId, driveFolderId, title }` を保存

#### 既存プロジェクト選択

- Drive Picker でスプレッドシートを選択
- `Meta` タブを読んでスキーマ検証（`schema_version` 確認、必須列存在確認）
- `drive_folder_id` を取得して `chrome.storage` に保存

#### プロジェクト切替

- `recentProjects` からワンクリック

### 4.2 プロトコル入力

入力形式は 3 系統。いずれも最終的に LLM による **ブロック自動抽出 → ユーザー承認・編集** のフローに合流する。

#### 入力形式

| 形式 | 処理 |
|---|---|
| 手入力 | RQ・組入/除外基準・元テキスト（任意のプロトコル全文）をフォームに入力。元テキストがあればそれを `extract-protocol` skill に渡す |
| `protocol.md` アップロード | テンプレート（[templates/rq_template.md](../search-formula-developper/templates/rq_template.md)）互換のマークダウンを Drive に保存後、テキストを `extract-protocol` skill に渡す |
| `.docx` アップロード | `mammoth.js` でプレーンテキスト化 → Drive に保存 → `extract-protocol` skill に渡す |

#### ブロック抽出・承認フロー

1. **LLM 抽出（`extract-protocol` skill）**: 元テキストから `framework_type`・`research_question`・`inclusion_criteria` / `exclusion_criteria`・1〜5 個のブロック（`block_label` + `description`）・既定の `combination_expression`（全 AND）をドラフト出力
2. **ユーザー承認 UI**: メインビューでブロック一覧を表示。各ブロックは以下が編集可能：
   - `block_label`（自由文字列）
   - `description`
   - 順序変更（ドラッグ or 上下ボタン）
   - 追加 / 削除（上限 5）
   - `combination_expression` の編集（既定 `#1 AND #2 AND ...`、必要なら `(#1 AND #2) OR #3` 等に変更可）
3. **保存**: 承認時に `Protocol` に 1 行、`ProtocolBlocks` に `block_count` 行を追記（同じ `version` で紐付け）。ユーザーが編集したブロックは `ai_generated=false` で記録

> 手入力かつ元テキストが空の場合は LLM 抽出をスキップし、空のブロック 1 行でユーザーにゼロから編集させる。

### 4.3 シード論文登録

**MVP 方針**: 本拡張の検証ロジック（シード捕捉率チェック等）は PubMed 検索結果に対して行うため、**PubMed にインデックスされていない論文は seed として扱えない**。ただし、ingest 時に「PMID っぽいもの」が取れたエントリは**すべて `SeedPapers` に保存**し、E-utilities で存在確認が取れなかったものは `is_valid=false` + `exclusion_reason=pmid_not_found` のフラグ付きで残す。検証ロジックは `is_valid=true` の行のみ対象にする。

PMID が一切取れない RIS 非 PubMed エントリのみスキップサマリ UI 止まり（`SeedPapers` には保存しない）。

#### 受付フォーマットと必ず実行する存在確認

| 入力方法 | 処理 |
|---|---|
| **PMID 直接入力** | 各 PMID を E-utilities で fetch。成功 → `ingest_format=pmid_direct, is_valid=true`、title/year 補完。失敗 → `is_valid=false, exclusion_reason=pmid_not_found` でそのまま保存（title/year は null） |
| **NBIB アップロード** | 各エントリから PMID 抽出 → E-utilities で fetch（NBIB も古い / 統合された PMID が残り得るため **必ず確認**）。成功/失敗は直接入力と同じロジック。`ingest_format=nbib` |
| **RIS アップロード** | エントリごとに PMID 解決（下記 RIS ロジック）→ PMID が取れたら E-utilities で fetch → 成功/失敗フラグ付きで保存。PMID 自体が取れなかったエントリのみスキップサマリへ |

#### RIS ingest ロジック（エントリごと）

各エントリを順に以下の順序で判定。**最初にヒットした経路でその行の `ingest_format` と `original_db` を決定する**。PMID 取得後は上記と同じ E-utilities 存在確認ステップに入る。

1. `DB` タグが `PubMed` → `ingest_format=ris_pubmed`, `original_db=PubMed`
2. `AN`（PubMed-AN）タグ等に純粋な PMID が入っている → `ingest_format=ris_pmid_field`, `original_db=<DB タグ値 or null>`
3. `DO`（DOI）タグが存在 → E-utilities `esearch` で `{doi}[aid]` を検索 → 1 件に解決できたら PMID 補完 → `ingest_format=ris_doi_resolved`, `original_db=<DB タグ値>`
4. 上記いずれでも PMID に辿り着けない → **スキップサマリ**に記録（`SeedPapers` には入れない）

#### 重複 PMID の扱い

- 同一プロジェクト内で既に `is_valid=true` の同 PMID 行が存在する場合は、2 回目の ingest は `is_valid=false, exclusion_reason=duplicate_pmid` で追記（監査用に入力履歴を残すため、上書きや完全スキップはしない）
- ユーザーが明示的に「この行を無効にする」を押した場合は `is_valid=false, exclusion_reason=user_removed`

#### ingest サマリ UI

- ingest 完了後、「登録: N 件（有効 K 件 / 無効 N-K 件）／スキップ: M 件」のサマリを表示
- **無効（`is_valid=false`）**: `SeedPapers` に残るが検証対象外。理由（`pmid_not_found` / `duplicate_pmid`）を列挙。ユーザーは一覧から「再試行」「削除」「そのまま残す」を選べる
- **スキップ（非 PubMed で PMID 取得不能）**: Sheets には保存しない。タイトル・元 DB を UI で確認可能。「note 欄へコピー」を促す。将来的に `SkippedSeeds` タブを追加するかは §11 で扱う

#### その他

- シード論文がない場合はスキップして次へ（§4.5 で対話的に追加）
- 対話的拡張（§4.5）で追加された seed は常に PubMed 由来なので `ingest_format=interactive`、`original_db=null`

### 4.4 検索式ドラフト作成（LLM、skills 構成）

AI による検索式作成を **4 つの skill（モジュール）** に分解する（各 skill は独立した LLM プロンプト＋後処理を持つ）。`search-formula-developper/.claude/skills/` の思想を Chrome 拡張内に移植するイメージ。

| Skill 名 | 責務 | 入力 | 出力 |
|---|---|---|---|
| `block-designer` | 各ブロック（`ProtocolBlocks` の 1 行）を検索式の 1 行 `#N` に展開する骨格設計 | ブロック description + RQ | ブロックごとの概念骨格（MeSH 要件とフリーワード要件の振り分け） |
| `mesh-suggester` | 各ブロックに対応する MeSH 記述子を提案 | ブロック概念 + seed PMIDs の MeSH（あれば） | MeSH 候補リスト（階層情報付き） |
| `freeword-designer` | tiab / ti / ab 向けのフリーワード・同義語を展開 | ブロック概念 + MeSH 候補 | フリーワード候補（近接演算子付与も含む） |
| `filter-designer` | 下記ルールに従い検索フィルタを提案 | プロトコル + `study_design` + （必要時）検索結果件数 | `Filters:` 行（適用するフィルタのみ列挙） |

#### `filter-designer` の厳格ルール（LLM 過剰フィルタ対策）

LLM は検索式生成時に、プロトコルに書かれていないフィルタ（`English[lang]` / `Humans[mh]` / 年代制限など）を勝手に追加しがちで、結果として**本来捕捉すべき論文を漏らす**ケースが頻発する。本 skill はこのドリフトを抑えるために、以下のホワイトリスト方式で動作する。

**デフォルトで適用するフィルタ**:

| 条件 | 適用するフィルタ |
|---|---|
| `study_design` が `RCT` / `randomized trial` に該当（または `inclusion_criteria` に RCT 明記） | **Cochrane Highly Sensitive Search Strategy（sensitivity-maximizing 版）** を RCT ブロックとして挿入。最終結合式に `AND #RCTfilter` を追加 |
| プロトコルに年代指定あり（例: 組入基準に "2015 年以降" 等の明示） | その年範囲で `("YYYY/MM/DD"[Date - Publication] : "YYYY/MM/DD"[Date - Publication])` を追加 |

**デフォルトでは適用しないフィルタ**（LLM は自発的に足してはいけない）:

- `English[lang]`（言語制限）
- `Humans[mh]` / `Animal[mh]`（被験種制限 — 新規文献は MeSH 付与前なので取りこぼす）
- `Review[pt]` / その他 publication type 制限
- Cochrane RCT フィルター以外の出版タイプフィルタ（例: RCT なら `randomized controlled trial[pt]` 単体）

**例外**: 検索実行後に **ヒット数が過大**（閾値は §11 で決定、暫定: 50,000 件超）だった場合のみ、`filter-designer` が候補フィルタを複数提示し、**ユーザーに承認を求める**。ユーザー承認なしにフィルタを追加してはならない。

**プロンプト設計の含意**: `filter-designer` の LLM プロンプトには「**プロトコルに明示されていないフィルタは絶対に追加しないこと**。Cochrane RCT フィルタと明記された年代のみ許可」を明示する。

> `study_design` が RCT 以外（observational / scoping 等）の場合は本 skill はフィルタを提案しない（年代指定のみ扱う）。観察研究向けフィルタ（BMJ 観察研究フィルタ等）は P1 以降で検討。

- 4 skill の出力を統合して `search_formula.md` 互換フォーマット（`## PubMed/MEDLINE` セクション、`#N` 行番号、最終行に `Protocol.combination_expression` の内容）に整形。Cochrane RCT フィルタは別ブロック（例: `#RCTfilter`）として挿入し、`combination_expression` に追記する
- `FormulaVersions` に `created_by=ai_draft` で保存
- 各 skill の LLM 呼び出しは個別に `LLMApiLog` に記録（`purpose` で識別: `draft_block` / `suggest_mesh` / `expand_freeword` / `design_filter`）

### 4.5 対話的シード拡張

- 現在の検索式で PubMed を検索 → **ヒット結果から 50 件をランダム抽出** → **AI が境界事例として 5 件を選定**（include/exclude の判別が自明でない文献を優先）。50→5 の二段階にすることで、LLM に大量結果を渡さずコストを抑え、かつユーザーが無限にスクロールするのも防ぐ
- メインビューで 1 件ずつ Title + Abstract を表示、ユーザーが `include` / `exclude` / `maybe` を判定
- `include` は `SeedPapers` に `source=interactive` として追記
- 1 ラウンド（5 件）終了ごとに `check_final_query` 相当の再検証を自動実行、捕捉率を表示
- ユーザーは「もう 1 ラウンド」か「検索式の修正に戻る」を選べる

### 4.6 検索式検証（CLI 移植機能、P0）

| 機能 | UI | 移植元スクリプト |
|---|---|---|
| 行ごとヒット数 | 検索式の各行の横にヒット数バッジを表示 | `check_search_lines.py` |
| シード捕捉率 | 「✅ 5/5 captured」のサマリ + 漏れ PMID の原因分析（AI） | `check_final_query.py` |
| MeSH 抽出・階層可視化 | Mermaid ダイアグラムをメインビューに表示 | `extract_mesh.py` |
| 全 DB 変換 | ワンクリックで CENTRAL / Embase / CT.gov / ICTRP を生成・ダウンロード | `generate_all_database_search.py` |

> **検証対象 seed の選別**: シード捕捉率・MeSH 抽出等の全検証機能は `SeedPapers.is_valid=true` の行のみを対象にする。`is_valid=false`（`pmid_not_found` / `duplicate_pmid` / `user_removed`）は計算から除外する。UI には「有効 seed: K 件（全 N 件中）」と明示する。

### 4.7 検索式編集

- メインビュー上でマークダウンエディタ（シンタックスハイライト）
- 行単位で「このブロックを AI に改善させる」ボタン → 該当 skill（`block-designer` / `mesh-suggester` / `freeword-designer` / `filter-designer` のうち対応するもの）を再実行 → 差分表示 → accept / reject
- accept 時は `FormulaVersions` に `created_by=user_edit` または `auto_optimize` で新バージョン追記

### 4.8 変換・エクスポート

- 確定版 `version_id` を選び、4 DB を一括変換して `Conversions` に保存
- 各変換結果を `.md` ファイルとしてダウンロードボタン提供
- 各 DB の実行方法を案内（PubMed は `https://pubmed.ncbi.nlm.nih.gov/?term=...` を開く、CT.gov / ICTRP も同様）

### 4.9 LLM プロバイダ抽象化

- `LLMProvider` インターフェースは **低レベル**（`chat(messages, options) -> response`）のみ。skill ごとのロジックは skill 側に持つ。これにより skill（何をしたいか）と provider（誰に頼むか）を直交させる
- MVP は `GeminiProvider` のみ実装
- 将来の OpenAI / Claude / OpenRouter 追加時に `Config.llm_provider` を切り替えるだけで全 skill がそのまま動く構造
- 全 skill は呼び出しごとに `LLMApiLog` + Drive にログを残す（`purpose` 列で skill を識別）

## 5. 機能要件（MVP 後 / P1 以降）

- ブロック重複分析（`check_block_overlap.py` 移植）: 各 OR 要素の寄与度を可視化
- MeSH 用語単発チェック（`check_mesh.py` / `check_mesh_overlap.py`）
- 他 LLM プロバイダ（OpenAI / Claude / OpenRouter）
- 検索式バージョン間 diff ビュー
- Ovid → PubMed 変換（P2）

## 6. 非機能要件

| カテゴリ | 要件 |
|---|---|
| パフォーマンス | 1 プロジェクトあたりシード 100 件・検索式 30 行・LLM ログ 1,000 件までストレスなく動作 |
| オフライン耐性 | LLM / NCBI API 呼び出し失敗時はローカルキューに退避、復旧時に同期 |
| 監査性 | 全 LLM 呼び出しの full payload を Drive に保存（再現性・学術的透明性のため） |
| セキュリティ | API キーはログ・レスポンスに絶対に出力しない。出力前に `token.substring(0, 8) + '...'` でサニタイズ |
| i18n | UI 日本語優先、英語は将来対応 |
| アクセシビリティ | キーボードショートカット（include/exclude/maybe 判定、次へ / 前へ） |

## 7. キーボードショートカット（対話的シード拡張画面）

tiab-review-plugin と合わせる：

- `i` : Include
- `e` : Exclude
- `m` : Maybe
- `n` / `→` : 次へ
- `p` / `←` : 前へ

## 8. エラーハンドリング方針

- **OAuth 失効**: `chrome.identity.removeCachedAuthToken` → 再取得を促す UI
- **Sheets API 権限不足**: シート共有設定への導線表示
- **NCBI クォータ超過**: 指数バックオフ（初回 1 秒、最大 32 秒）
- **LLM API エラー**: `LLMApiLog` にエラー記録、ユーザーへ再試行ボタン提示
- **50,000 文字セル超過**: 自動的に Drive へ退避、Sheet には URL を格納

## 9. 将来の統合アプリとの接続設計

- 本拡張が発行する `project_id`（UUID v4）・`spreadsheet_id`・`drive_folder_id` がプロジェクトの一次キー。すべて `Meta` タブに格納されており、統合アプリはスプレッドシートを 1 つ読めばこれらを取得できる
- 統合アプリ（未開発）は自身の「プロジェクトレジストリ用スプレッドシート」を持ち、ユーザーが各下位拡張のスプレッドシートを **手動で紐づけ**する（`project_id` 自動マージは行わない。手動選択の方がミスが少ないと判断）
- 紐づけ時、統合アプリは下位拡張の `Meta` タブを読んで `project_id` / `drive_folder_id` をレジストリに転記
- 下位アプリ間の遷移は「該当スプレッドシートを開く」または「該当拡張のメインビューを新規タブで起動する」方式。データコピーは行わない
- エクスポート用 JSON スキーマを定義し、tiab-review-plugin 等が import しやすい形を保つ（MVP 後期に確定）

## 10. 想定リスクと対策

| リスク | 影響 | 対策 |
|---|---|---|
| `search-formula-developper` の CLI ロジック TS 移植工数が膨らむ | MVP スケジュール遅延 | P0 4 スクリプトに絞り込み、MVP 段階では `check_block_overlap` 等は諦める |
| LLM のトークン消費が BYOK ユーザーのコスト負担に直結 | ユーザー離脱 | `LLMApiLog.cost_estimate_usd` で累積コスト可視化、プロンプト最適化 |
| 50,000 文字 / セル制限 | データ欠損 | Drive 退避で回避（実装済み方針） |
| OAuth スコープ過大で Chrome Web Store 審査遅延 | リリース遅延 | `drive.file` に限定（`drive.readonly` 等は使わない） |
| Gemini API 仕様変更 | 検索式生成不能 | プロバイダ抽象化で即座に別 LLM へ切替可能に |
| LLM が勝手にフィルタを追加（`English[lang]` / `Humans[mh]` 等）→ 感度低下で seed 捕捉漏れ | 検索品質低下（SR 方法論上の致命傷） | `filter-designer` skill をホワイトリスト方式に固定（Cochrane RCT フィルタ + 明示された年代のみ）。他フィルタは「ヒット数過大 → ユーザー承認」経路でのみ追加 |

## 11. 未決事項（次フェーズで詰める）

- [ ] UI 画面遷移図（メインビュー内のルーティング）
- [ ] `extract-protocol` skill のプロンプトテンプレート（どのように RQ・ブロック・結合式を抽出させるか）
- [ ] ブロック承認 UI の具体設計（並び替え・統合・分割・`combination_expression` 編集の UX）
- [ ] LLM プロンプトテンプレート（ドラフト生成 / 境界事例抽出 / シノニム展開）
- [ ] スキップされた seed 論文（PubMed 非収載）を Sheets にも残すか。MVP は UI 表示のみだが、監査要件が固まれば `SkippedSeeds` タブ追加を検討
- [ ] `filter-designer` の「ヒット数過大」閾値の確定（暫定 50,000 件超）。また Cochrane HSSS の sensitivity 版 / balanced 版どちらをデフォルトにするか
- [ ] Cochrane RCT フィルタ文字列の版管理（PubMed 版 2008 / 2024 改訂版等）。検索式内にフィルタ版番号をコメントで残すか
- [ ] MVP のリリース判定基準（テストカバレッジ、動作確認項目）
- [ ] ディレクトリ構造（`src/` 配下）の詳細
- [ ] CI / CD（GitHub Actions、Chrome Web Store 自動公開の是非）
- [ ] ライセンス表記の各サードパーティ（mammoth.js、jstat 等）確認

## 12. 参考リンク

- [tiab-review-plugin AGENTS.md](../tiab-review-plugin/AGENTS.md)
- [search-formula-developper CLAUDE.md](../search-formula-developper/CLAUDE.md)
- [search-formula-developper Readme](../search-formula-developper/Readme.md)
- [Chrome Extension Manifest V3](https://developer.chrome.com/docs/extensions/mv3/)
- [Google Sheets API](https://developers.google.com/sheets/api)
- [NCBI E-utilities](https://www.ncbi.nlm.nih.gov/books/NBK25501/)
