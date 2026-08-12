# 権限の使用理由説明（Chrome ウェブストア審査フォーム用）

- **最終更新**: 2026-08-12
- **用途**: Chrome ウェブストアのアイテム登録時、各権限に求められる「使用理由（justification）」欄へそのまま貼り付けるための原稿。日本語と英語を併記します。
- **正典**: 権限の一覧は [src/manifest.json](../../src/manifest.json)、データフローは [privacy-policy.md](privacy-policy.md) を参照。

## 単一用途（Single purpose）

- **JA**: 本拡張の単一の用途は、研究プロトコル（リサーチクエスチョン・PICO 等）から PubMed 検索式を生成・検証し、他データベース（CENTRAL / Embase(Dialog) / ClinicalTrials.gov / ICTRP）向けに変換する作業の支援です。ユーザーが入力した研究プロトコルをもとに、ユーザー自身の API キー（BYOK）で生成 AI（Gemini）が検索式ドラフトを作成し、NCBI E-utilities を用いてヒット数・シード論文の捕捉率・MeSH 用語を検証、最終的な検索式を各データベース向けの構文へ変換して出力します。すべての機能（プロトコル入力、検索式ブロック承認、シード論文登録、検索式ドラフト生成・検証、各 DB への変換・エクスポート）はこの単一のワークフローを構成する段階であり、これ以外の用途（ブラウジング支援、他サイトの改変等）はありません。
- **EN**: The single purpose of this extension is to support generating and validating a PubMed search strategy from a research protocol (research question, PICO, etc.), and converting it for other databases (CENTRAL / Embase(Dialog) / ClinicalTrials.gov / ICTRP). Based on the protocol the user enters, a generative AI (Gemini), called with the user's own API key (BYOK), drafts a search strategy; NCBI E-utilities are used to validate line-by-line hit counts, seed-paper capture rate, and MeSH terms; the finalized strategy is then converted into the syntax of each target database and exported. Every feature (protocol input, search-block approval, seed-paper registration, draft generation and validation, per-database conversion and export) is a stage of this single workflow; the extension does nothing else (no browsing assistance, no modification of other sites).

## リモートコード使用の申告

「リモートコードを使用していますか」→ **いいえ**。全 script は拡張パッケージ内のローカルバンドルのみ（webpack でバンドル。CDN 不使用・CSP は MV3 既定）。

## permissions

### `identity` / `identity.email`

- **JA**: Google OAuth 2.0（`chrome.identity.getAuthToken`）でユーザーの Google アカウントにサインインし、プロジェクト DB である Google Sheets とファイル実体の Google Drive にアクセスするために使用します。本拡張は `chrome.identity.launchWebAuthFlow` ではなく `chrome.identity.getAuthToken` を使用しており、Chrome プロファイルに紐づく Google アカウントでのサインインとなります。`identity.email` は `chrome.identity.getProfileUserInfo()` により、サインイン中アカウントのメールアドレスを取得するために使用します。取得したメールアドレスは `FormulaVersions` 等の記録者列（誰が検索式を作成・判定したか）に書き込む監査証跡目的にのみ使用し、OAuth スコープとしては要求しません。開発者サーバーへ送信することはありません（開発者サーバーは存在しません）。
- **EN**: Used to sign in to the user's Google account via Google OAuth 2.0 (`chrome.identity.getAuthToken`) so the extension can access the user's Google Sheets (used as the project database) and Google Drive (used to store files). This extension uses `chrome.identity.getAuthToken`, not `chrome.identity.launchWebAuthFlow`, so sign-in uses the Google account associated with the Chrome profile. `identity.email` is used via `chrome.identity.getProfileUserInfo()` to obtain the signed-in account's email address, which is written to audit-trail columns (e.g., `FormulaVersions`) to record who created or judged a given search strategy; this is not requested as an OAuth scope. No information is sent to any developer-operated server (there is none).

### `storage`

- **JA**: ユーザーの API キー（Gemini・NCBI、BYOK）や認証状態などのアプリ設定を、ブラウザローカル（`chrome.storage`）に保存するために使用します。これらは端末外へ送信されません。
- **EN**: Used to store application settings in the browser's local storage (`chrome.storage`), such as the user's API keys (Gemini, NCBI; BYOK) and authentication state. None of these leave the user's device.

## host_permissions

### `https://sheets.googleapis.com/*` / `https://www.googleapis.com/*`

- **JA**: プロジェクト DB である Google Sheets（研究プロトコル・検索式ブロック・シード論文・検索式バージョン・検証結果・変換結果・LLM API ログ等）の読み書き、および Google Drive へのファイル（LLM API ログの JSON 等）の保存・取得に使用します。アクセス範囲は OAuth スコープ `drive.file`（本拡張が作成したファイルのみ）に限定されます。
- **EN**: Used to read/write the user's Google Sheets (the project database: research protocol, search-strategy blocks, seed papers, formula versions, validation results, conversion results, LLM API logs, etc.), and to store/retrieve files (such as LLM API log JSON) in Google Drive. Access is limited by the OAuth scope `drive.file` (only files created by this extension).

### `https://eutils.ncbi.nlm.nih.gov/*`

- **JA**: NCBI E-utilities を用いて、検索式のブロックごとのヒット数検証・MeSH 用語の取得・シード論文の捕捉率計算に使用します。
- **EN**: Used to call NCBI E-utilities for line-by-line hit-count validation of the search strategy, MeSH term retrieval, and seed-paper capture-rate calculation.

### `https://generativelanguage.googleapis.com/*`

- **JA**: ユーザーが設定した Gemini API キー（BYOK）で、検索式ドラフトの生成・MeSH 提案・シノニム展開・検証結果の解釈補助などのリクエストを送信するために使用します。
- **EN**: Used to send requests (search-strategy draft generation, MeSH suggestions, synonym expansion, validation-result interpretation assistance) to the Gemini API with the user's own API key (BYOK).

### `https://id.nlm.nih.gov/*`

- **JA**: NLM の MeSH RDF（SPARQL エンドポイント、`id.nlm.nih.gov/mesh/sparql`）を用いて、検索式ブロック内の MeSH 用語が MeSH ツリー上のどの親子関係にあるか（祖先・子ノードの名称）を取得するために使用します。NCBI E-utilities（`db=mesh`）は descriptor から tree number への解決はできますが、tree number から descriptor 名への逆引き（祖先ノードの名称表示）や、ある tree number の子ノード列挙はできないため、この情報を得るには本エンドポイントが別途必要です。認証や API キーは不要な公開エンドポイントで、送信するのは descriptor 名・tree number のみであり、PMID や研究プロトコルの本文は送信されません。
- **EN**: Used to call NLM's MeSH RDF SPARQL endpoint (`id.nlm.nih.gov/mesh/sparql`) to look up where a MeSH term used in a search block sits in the MeSH tree's parent/child hierarchy (the names of its ancestor and child nodes). NCBI E-utilities (`db=mesh`) can resolve a descriptor to its tree number, but cannot resolve a tree number back to a descriptor name (to display ancestor nodes) or enumerate a tree number's child nodes; this endpoint is required for that. It is a public endpoint that needs no authentication or API key; only descriptor names and tree numbers are sent, never PMIDs or protocol text.

## OAuth スコープ（審査の Google 用データアクセス欄）

| スコープ | 用途 |
|---|---|
| `.../auth/drive.file` | 本拡張が作成したファイル（プロジェクトのスプレッドシート・Drive フォルダ・LLM API ログ）のみへのアクセス（プロジェクト DB の Sheets 読み書きを含む）。Drive 全体は読まない |

`https://www.googleapis.com/auth/spreadsheets` のような全スプレッドシートへアクセスできるスコープは要求しません。取得したデータは、機能提供以外の目的（広告・分析・第三者提供・モデル学習）には使用しません。Google API Services User Data Policy（Limited Use を含む）を遵守します。
