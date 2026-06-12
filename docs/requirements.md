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
https://www.googleapis.com/auth/drive.file          # Drive Picker + LLM ログ保存用
```

ユーザーのメールアドレスは OAuth スコープではなく、Chrome 拡張 API の `chrome.identity.getProfileUserInfo()` で取得する（§2.2 の `identity.email` permission を参照）。こちらはプロファイル情報の取得だけなので OAuth スコープを広げずに済む。

### 2.2 Manifest V3 要件

- `permissions`: `identity`, `identity.email`, `storage`, `tabs`（メインビューを新規タブで開く用途）
  - `identity.email` は `chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' })` でユーザーのメールアドレスを取得するために必須。`created_by` / `decided_by` 列にはこの API で取得したメールを書き込む（OAuth の `userinfo.email` スコープは取得せず、Chrome の同期アカウント情報を使う）
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
| raw_text_inline | string | | `manual` 時のフォーム入力（プロトコル全文テキストエリア）の本文を直接保存する。セル上限 50,000 字。`markdown` / `docx` では null（Drive 側が正本のため） |
| created_at | iso8601 | ✓ | |
| created_by | email | ✓ | |

> **元テキスト保存ポリシー**: `markdown` / `docx` アップロード時は Drive の `raw_protocols/{version}_{filename}.txt` に常に保存する（LLM ログと同じ監査性方針）。50,000 文字制限を気にせず原文を残せる。`manual` 入力は Drive を経由せず、`raw_text_inline` 列にシート上でそのまま保存する（セル上限に達することはほぼ想定しないが、超えた場合のみ §8 のフォールバックで Drive 退避→`raw_text_ref` 埋めへ切り替える）。いずれの経路でも監査に足る元テキストがプロジェクトに常に 1 箇所以上残る設計。

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

**方針**: ユーザーが入れた seed の入力履歴は**すべて保存する**（PMID が解決できなかった RIS 非 PubMed エントリも含む）。存在確認に失敗した PMID（タイポ・削除・統合済み等）や、そもそも PMID に辿り着けなかった RIS エントリは `is_valid=false` + `exclusion_reason` 付きで残し、検証ロジックではフィルタして無視する。これにより「入れたはずなのに消えてる」現象が起きず、監査要件（誰が何を入れようとしたか）も満たせる。

> **設計判断**: §11 当初案では PMID を取れなかった RIS エントリ用に `SkippedSeeds` タブを別途設ける案もあったが、タブを増やすと統合アプリ側の読み出しコストが上がるため、`SeedPapers` 内に `ingest_format=ris_no_pmid` 行として混在させ、`is_valid=false` フラグで検証対象から外す方式に統一した（§11 で確定）。

| 列 | 型 | 必須 | 説明 |
|---|---|---|---|
| pmid | string | | ユーザーが入力 / ファイルから抽出した PMID。`is_valid=false` の場合も値は保持（ユーザーがどの PMID を入れようとしたかの記録）。`ingest_format=ris_no_pmid` 行のみ null 可 |
| title | string | | PubMed E-utilities から自動取得。`is_valid=false` では null。`ris_no_pmid` 行のみ RIS の `TI` タグから直接転記 |
| year | int | | 同上。`ris_no_pmid` 行は RIS の `PY` / `Y1` から転記 |
| source | enum | ✓ | `initial`（初期登録） / `interactive`（対話的追加） |
| ingest_format | enum | ✓ | `pmid_direct`（ユーザーが PMID を直接入力）/ `nbib`（PubMed NBIB ファイル）/ `ris_pubmed`（RIS で `DB=PubMed` と明記）/ `ris_doi_resolved`（RIS 由来だが DOI を PubMed E-utilities で PMID に解決）/ `ris_pmid_field`（RIS の AN フィールドに PMID が入っていた）/ `ris_no_pmid`（RIS だが PMID に辿り着けなかった。検証対象外）/ `interactive`（対話的拡張で抽出） |
| original_db | string | | `ris_*` 由来の場合、RIS の `DB` タグに書かれていた元 DB（`PubMed` / `Embase` / `CENTRAL` / `Scopus` 等）。監査用。`pmid_direct` / `nbib` / `interactive` の場合は null |
| is_valid | bool | ✓ | E-utilities で存在確認できたか。検索式の捕捉率計算等ではこの列が `true` の行のみ対象にする。`ris_no_pmid` は常に `false` |
| exclusion_reason | enum | | `is_valid=false` の理由: `pmid_not_found`（E-utilities で PMID 不在）/ `duplicate_pmid`（同プロジェクト内で既存）/ `user_removed`（ユーザーが「削除」で論理削除）/ `user_disabled`（ユーザーがチェックボックスで一時無効化。再有効化で `is_valid=true` に戻る）/ `no_pmid_resolved`（RIS から PMID を一切解決できなかった）。`is_valid=true` では null |
| original_payload_ref | string(url) | | `ris_no_pmid` 行のみ、元 RIS エントリ全体を Drive の `raw_protocols/skipped_seeds/{seed_id}.ris` として保存した URL。他形式では null |
| user_decision | enum | | `include` / `exclude` / `maybe`（interactive 時必須） |
| decided_at | iso8601 | | |
| decided_by | email | | |
| note | string | | |

#### `FormulaVersions`

| 列 | 型 | 必須 | 説明 |
|---|---|---|---|
| version_id | string(uuid) | ✓ | |
| parent_version_id | string(uuid) | | 派生元バージョン |
| protocol_version | int | ✓ | この検索式が拠って生成された `Protocol.version`。プロトコル改訂後も当時の要件文脈を復元するためのキー |
| protocol_snapshot_ref | string(url or inline) | ✓ | 生成時点のプロトコル元テキストの**凍結スナップショット**。`markdown` / `docx` 経路ではその版の `Protocol.raw_text_ref` の Drive ファイル ID（= `raw_protocols/{version}_{filename}.txt` の ID）をコピー。`manual` 経路では同版の `Protocol.raw_text_inline` 本文をそのまま格納する。Protocol 側が後から編集された場合に備え、FormulaVersions タブ側で独立にスナップショットを持つ（追記型・上書きなし） |
| formula_md | string | ✓ | `search_formula.md` 派生フォーマットのマークダウン全文（`#N` 数値行に加え `#RCTfilter` のような名前付きブロックを許可。§4.4 参照） |
| created_by | enum | ✓ | `ai_draft` / `user_edit` / `auto_optimize` |
| created_at | iso8601 | ✓ | |
| note | string | | 変更理由・コメント |

> `formula_md` は 50,000 文字上限に当たる可能性は低いが、超えた場合は Drive へ退避して URL を格納する（`LLMApiLog` と同方針）。
>
> **履歴保持ポリシー**: `Protocol` タブと `FormulaVersions` タブはいずれも**追記型・上書き禁止**。`Protocol.version` は改訂のたびに新しい行を追加する。`FormulaVersions` は生成のたびに新しい `version_id` + `protocol_version` + `protocol_snapshot_ref` を記録し、過去の検索式がどのプロトコル版・どの元テキストから出たかを後から再現できる状態を保つ。

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

入力 UI は 3 系統で**排他**。どの系統でも、最終的に 1 本のプロトコル全文テキストが `extract-protocol` skill に渡り、RQ・組入/除外基準・ブロックが自動抽出される（ユーザーは次の「ブロック承認」画面で編集する）。入力フォーム側には RQ / 組入 / 除外基準の個別欄は**持たせない**（情報入力を二度手間にしないため）。

| 形式 | 処理 |
|---|---|
| 手入力 | プロトコル全文の 1 つのテキストエリアに貼り付け。そのまま `extract-protocol` skill に渡す |
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

**MVP 方針**: 本拡張の検証ロジック（シード捕捉率チェック等）は PubMed 検索結果に対して行うため、**PubMed にインデックスされていない論文は seed として扱えない**。ただし、ingest 時に投入されたエントリは**すべて `SeedPapers` に保存**し、検証対象外のものは `is_valid=false` + `exclusion_reason` のフラグ付きで残す。検証ロジックは `is_valid=true` の行のみ対象にする。

これには以下が含まれる：

- E-utilities で存在確認が取れなかった PMID → `exclusion_reason=pmid_not_found`
- RIS から PMID に辿り着けなかったエントリ（DB タグなし・DOI 解決失敗等） → `exclusion_reason=no_pmid_resolved`、`pmid` 列は null、元 RIS エントリ本体は Drive に退避

タブを増やさない設計（§3.1 設計判断参照）のため、`SeedPapers` 内で全 ingest 履歴を一元管理する。

#### 受付フォーマットと必ず実行する存在確認

| 入力方法 | 処理 |
|---|---|
| **PMID 直接入力** | 各 PMID を E-utilities で fetch。成功 → `ingest_format=pmid_direct, is_valid=true`、title/year 補完。失敗 → `is_valid=false, exclusion_reason=pmid_not_found` でそのまま保存（title/year は null） |
| **NBIB アップロード** | 各エントリから PMID 抽出 → E-utilities で fetch（NBIB も古い / 統合された PMID が残り得るため **必ず確認**）。成功/失敗は直接入力と同じロジック。`ingest_format=nbib` |
| **RIS アップロード** | エントリごとに PMID 解決（下記 RIS ロジック）→ PMID が取れたら E-utilities で fetch → 成功/失敗フラグ付きで保存。PMID 自体が取れなかったエントリは `ingest_format=ris_no_pmid, is_valid=false, exclusion_reason=no_pmid_resolved` で同タブに保存し、元 RIS エントリ本体を Drive に退避 |

#### RIS ingest ロジック（エントリごと）

各エントリを順に以下の順序で判定。**最初にヒットした経路でその行の `ingest_format` と `original_db` を決定する**。PMID 取得後は上記と同じ E-utilities 存在確認ステップに入る。

1. `DB` タグが `PubMed` → `ingest_format=ris_pubmed`, `original_db=PubMed`
2. `AN`（PubMed-AN）タグ等に純粋な PMID が入っている → `ingest_format=ris_pmid_field`, `original_db=<DB タグ値 or null>`
3. `DO`（DOI）タグが存在 → E-utilities `esearch` で `{doi}[aid]` を検索 → 1 件に解決できたら PMID 補完 → `ingest_format=ris_doi_resolved`, `original_db=<DB タグ値>`
4. 上記いずれでも PMID に辿り着けない → `ingest_format=ris_no_pmid, is_valid=false, exclusion_reason=no_pmid_resolved` として `SeedPapers` に追加（`pmid` は null、`title` / `year` は RIS から転記）。元 RIS エントリ本体は `{drive_folder_id}/raw_protocols/skipped_seeds/{seed_id}.ris` に保存し、`original_payload_ref` に URL を格納

#### 重複 PMID の扱い

- 同一プロジェクト内で既に `is_valid=true` の同 PMID 行が存在する場合は、2 回目の ingest は `is_valid=false, exclusion_reason=duplicate_pmid` で追記（監査用に入力履歴を残すため、上書きや完全スキップはしない）
- ユーザーがチェックボックスで行を一時的に無効化した場合は `is_valid=false, exclusion_reason=user_disabled`（チェックを戻すと `is_valid=true, exclusion_reason=null` へ復帰）
- ユーザーが「削除」ボタンを押した場合は `is_valid=false, exclusion_reason=user_removed`（論理削除。再有効化 UI は提供しない）

#### ingest サマリ UI

- ingest 完了後、「登録: N 件（有効 K 件 / 無効 N-K 件）」のサマリを表示。無効内訳として `pmid_not_found` / `duplicate_pmid` / `no_pmid_resolved` の件数を列挙
- **無効（`is_valid=false`）**: `SeedPapers` に残るが検証対象外。ユーザーは一覧から「再試行」「チェックボックスで無効化」「削除」「そのまま残す」を選べる
  - **有効/無効チェックボックス**: 一覧の各行（有効行・`user_disabled` 行）の左端にチェックボックスを置く。OFF で `is_valid=false, exclusion_reason=user_disabled` に書き換え、行は一覧に表示されたまま（グレーアウト）。ON で `is_valid=true, exclusion_reason=null` に復帰する。完全に見えなくなる無効化を避け、いつでも往復できる一時除外として扱う
  - **「削除」ボタンは論理削除**に統一する（物理削除は行わない）。押下時の挙動は当該行を `is_valid=false, exclusion_reason=user_removed` に書き換えるだけで、行自体は `SeedPapers` に残す。§4.3 冒頭の「ingest されたものはすべて保存する」監査性方針と整合させるため。削除後はデフォルト一覧から消える
  - 再 ingest で同じ PMID が入ってきた場合も、既に `user_removed` / `user_disabled` 付きの行があれば `exclusion_reason=duplicate_pmid` の新規行を追記する（上書きしない）。「ユーザーが一度削除・無効化した事実」を監査ログとして残すため（`user_disabled` の復帰はチェックボックスで行う）
  - 一覧 UI はデフォルトで `is_valid=true` と `user_disabled` の行を表示し、「取込失敗・削除済みの行も表示」トグルで全件見られるようにする（ノイズで一覧が圧迫されるのを防ぐ）。`ris_no_pmid` 行は無効行ビュー上で別グルーピング表示し、タイトルと元 DB から手動で PMID を補完できる「PMID を入力する」ボタンを提供（補完成功時は新規 `pmid_direct` 行として追記、元の `ris_no_pmid` 行は `note` に紐付けを残す）

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
| `study_design` が `RCT` / `randomized trial` に該当（または `inclusion_criteria` に RCT 明記） | **Cochrane Highly Sensitive Search Strategy（PubMed 版・2024 改訂版・sensitivity-maximizing バージョン）** を RCT ブロックとして挿入。最終結合式に `AND #RCTfilter` を追加。フィルタ文字列の冒頭に `# Cochrane HSSS PubMed 2024 (sensitivity-maximizing)` というコメント行を入れて版を明示する |
| プロトコルに年代指定あり（例: 組入基準に "2015 年以降" 等の明示） | その年範囲で `("YYYY/MM/DD"[Date - Publication] : "YYYY/MM/DD"[Date - Publication])` を追加 |

**デフォルトでは適用しないフィルタ**（LLM は自発的に足してはいけない）:

- `English[lang]`（言語制限）
- `Humans[mh]` / `Animal[mh]`（被験種制限 — 新規文献は MeSH 付与前なので取りこぼす）
- `Review[pt]` / その他 publication type 制限
- Cochrane RCT フィルター以外の出版タイプフィルタ（例: RCT なら `randomized controlled trial[pt]` 単体）

**例外**: 検索実行後に **ヒット数が過大**（閾値: **10,000 件超**）だった場合のみ、`filter-designer` が候補フィルタを複数提示し、**ユーザーに承認を求める**。ユーザー承認なしにフィルタを追加してはならない。

**プロンプト設計の含意**: `filter-designer` の LLM プロンプトには「**プロトコルに明示されていないフィルタは絶対に追加しないこと**。Cochrane RCT フィルタと明記された年代のみ許可」を明示する。

> `study_design` が RCT 以外（observational / scoping 等）の場合は本 skill はフィルタを提案しない（年代指定のみ扱う）。観察研究向けフィルタ（BMJ 観察研究フィルタ等）は P1 以降で検討。

- 4 skill の出力を統合して `search_formula.md` **派生フォーマット**（`## PubMed/MEDLINE` セクション、`#N` 数値行＋任意の名前付きブロック、最終行に `Protocol.combination_expression` の内容）に整形。Cochrane RCT フィルタは別ブロック（例: `#RCTfilter`）として挿入し、`combination_expression` に追記する
- **search_formula.md 互換方針の明示**: 本拡張のフォーマットは上流 `search-formula-developper` の `search_formula.md` を出発点としつつ、`#RCTfilter` のような名前付きブロックを許すよう拡張する。上流 Python スクリプトは `#N` 数値行のみを前提にパースしているため、**完全な逆方向互換は保証しない**。TS へ移植する検証・変換ロジック（`check_search_lines` / `check_final_query` / `generate_all_database_search` 等）は、ブロック識別子を「数値または英字トークン」として扱えるよう要件定義側に寄せて改修する（`ProtocolBlocks` と 1:1 対応するのは `#1`〜`#5` のみで、`#RCTfilter` 等の自動生成ブロックはユーザーブロックの一覧からは独立）
- `FormulaVersions` に `created_by=ai_draft` で保存
- 各 skill の LLM 呼び出しは個別に `LLMApiLog` に記録（`purpose` で識別: `draft_block` / `suggest_mesh` / `expand_freeword` / `design_filter`）

### 4.5 対話的シード拡張

- 現在の検索式で PubMed を検索 → **ヒット結果から 50 件をランダム抽出** → **AI が境界事例として 5 件を選定**（include/exclude の判別が自明でない文献を優先）。50→5 の二段階にすることで、LLM に大量結果を渡さずコストを抑え、かつユーザーが無限にスクロールするのも防ぐ
- メインビューで 1 件ずつ Title + Abstract を表示、ユーザーが `include` / `exclude` / `maybe` を判定
- **5 件の判定はすべて `SeedPapers` に `source=interactive`、`user_decision=include|exclude|maybe` として追記する**（監査性と「同じ論文を次ラウンドで再提示しない」制御のため）。`exclude` / `maybe` の行は捕捉率計算など検証ロジックからは除外する（検証対象は従来どおり `is_valid=true` かつ `user_decision=include`（初期登録行では null）のみ）
- 既に `SeedPapers` に同一 PMID が入っている論文は次ラウンドの 50 件ランダム抽出から除外する（無効化済み・maybe 判定済みも含む）。これにより同じ境界事例を何度も判定させられる事態を防ぐ
- 1 ラウンド（5 件）終了ごとに `check_final_query` 相当の再検証を自動実行、捕捉率を表示
- ユーザーは「もう 1 ラウンド」か「検索式の修正に戻る」を選べる

### 4.6 検索式検証（CLI 移植機能、P0）

| 機能 | UI | 移植元スクリプト |
|---|---|---|
| 行ごとヒット数 | 検索式の各行の横にヒット数バッジを表示 | `check_search_lines.py` |
| シード捕捉率 | 「✅ 5/5 captured」のサマリ + 漏れ PMID の原因分析（AI） | `check_final_query.py` |
| MeSH 抽出・階層可視化 | Mermaid ダイアグラムをメインビューに表示 | `extract_mesh.py` |
| 全 DB 変換 | ワンクリックで CENTRAL / Embase / CT.gov / ICTRP を生成・ダウンロード | `generate_all_database_search.py` |

> **検証対象 seed の選別**: シード捕捉率・MeSH 抽出等の全検証機能は `SeedPapers.is_valid=true` の行のみを対象にする。`is_valid=false`（`pmid_not_found` / `duplicate_pmid` / `user_removed` / `user_disabled`）は計算から除外する。UI には「有効 seed: K 件（全 N 件中）」と明示する。

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
| LLM が勝手にフィルタを追加（`English[lang]` / `Humans[mh]` 等）→ 感度低下で seed 捕捉漏れ | 検索品質低下（SR 方法論上の致命傷） | `filter-designer` skill をホワイトリスト方式に固定（Cochrane HSSS PubMed 2024 sensitivity-maximizing + 明示された年代のみ）。他フィルタは「ヒット数 10,000 件超 → ユーザー承認」経路でのみ追加 |

## 11. 未決事項と確定事項

### 11.1 確定事項（2026-04-17 確定）

| 項目 | 決定内容 | 反映先 |
|---|---|---|
| スキップされた seed 論文の扱い | `SkippedSeeds` タブは作らず、`SeedPapers` 内に `ingest_format=ris_no_pmid, is_valid=false, exclusion_reason=no_pmid_resolved` の行として保存。元 RIS エントリ本体は Drive に退避 | §3.1 SeedPapers / §4.3 |
| `filter-designer` のヒット過大閾値 | **10,000 件超** | §4.4 |
| Cochrane HSSS のバージョン | **PubMed 版 2024 改訂版・sensitivity-maximizing バージョン**を既定。フィルタ文字列冒頭に版コメントを残す | §4.4 / §10 |
| MVP リリース判定基準 | **本拡張のために新規に書いたコード（`src/` 配下の TS）に対するテストカバレッジ 100 %**（行・分岐とも）。テストは本実装フェーズで Claude が書いたものを正本とする。サブモジュール（`tiab-review-plugin` / `search-formula-developper`）は対象外 | 実装フェーズ |
| ディレクトリ構造 | Claude が起案（[docs/architecture.md](architecture.md) 参照）。承認は実装着手のタイミングで取る | docs/architecture.md |
| サードパーティライセンス表記 | Claude が起案。`THIRD_PARTY_NOTICES.md` をルート直下に作成し、`mammoth.js` / `jstat` 等を MIT 表記でまとめる | 実装フェーズ（依存追加時） |
| CI / CD | MVP では不要。リリース判定が固まってから別途検討 | （MVP 対象外） |

### 11.2 実装時に Claude が起案 → 開発者がレビュー・修正

以下は要件定義時点では確定させず、実装着手時に Claude がドラフトを書き、実際の動作で検証してから開発者が修正する：

- `extract-protocol` skill のプロンプトテンプレート（RQ / ブロック / 結合式の抽出方法）
- 4 skill（`block-designer` / `mesh-suggester` / `freeword-designer` / `filter-designer`）の LLM プロンプトテンプレート
- 対話的シード拡張（§4.5）の境界事例抽出プロンプト
- フリーワード展開時のシノニム / 異綴り展開プロンプト

### 11.3 モックアップ（要件定義フェーズで作成）

- UI 画面遷移図 → [docs/ui-flow.md](ui-flow.md)
- ブロック承認 UI ワイヤーフレーム → [docs/ui-block-approval.md](ui-block-approval.md)

## 12. 参考リンク

- [tiab-review-plugin AGENTS.md](../tiab-review-plugin/AGENTS.md)
- [search-formula-developper CLAUDE.md](../search-formula-developper/CLAUDE.md)
- [search-formula-developper Readme](../search-formula-developper/Readme.md)
- [Chrome Extension Manifest V3](https://developer.chrome.com/docs/extensions/mv3/)
- [Google Sheets API](https://developers.google.com/sheets/api)
- [NCBI E-utilities](https://www.ncbi.nlm.nih.gov/books/NBK25501/)
