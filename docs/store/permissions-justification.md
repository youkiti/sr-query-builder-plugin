# 権限の使用理由説明（Chrome ウェブストア審査フォーム用）

- **最終更新**: 2026-08-15
- **用途**: Chrome ウェブストアのアイテム登録時、各権限に求められる「使用理由（justification）」欄へそのまま貼り付けるための原稿。日本語と英語を併記します。
- **正典**: 権限の一覧は [src/manifest.json](../../src/manifest.json)、データフローは [privacy-policy.md](privacy-policy.md) を参照。

## 単一用途（Single purpose）

- **JA**: 本拡張の単一の用途は、研究プロトコル（リサーチクエスチョン・PICO 等）から PubMed 検索式を生成・検証し、他データベース（CENTRAL / Embase(Dialog) / ClinicalTrials.gov / ICTRP）向けに変換する作業の支援です。ユーザーが入力した研究プロトコルをもとに、ユーザー自身の API キー（BYOK）で生成 AI（Gemini）が検索式ドラフトを作成し、NCBI E-utilities を用いてヒット数・シード論文の捕捉率・MeSH 用語を検証、最終的な検索式を各データベース向けの構文へ変換して出力します。すべての機能（プロトコル入力、検索式ブロック承認、シード論文登録、検索式ドラフト生成・検証、各 DB への変換・エクスポート）はこの単一のワークフローを構成する段階であり、これ以外の用途（ブラウジング支援、他サイトの改変等）はありません。
- **EN**: The single purpose of this extension is to support generating and validating a PubMed search strategy from a research protocol (research question, PICO, etc.), and converting it for other databases (CENTRAL / Embase(Dialog) / ClinicalTrials.gov / ICTRP). Based on the protocol the user enters, a generative AI (Gemini), called with the user's own API key (BYOK), drafts a search strategy; NCBI E-utilities are used to validate line-by-line hit counts, seed-paper capture rate, and MeSH terms; the finalized strategy is then converted into the syntax of each target database and exported. Every feature (protocol input, search-block approval, seed-paper registration, draft generation and validation, per-database conversion and export) is a stage of this single workflow; the extension does nothing else (no browsing assistance, no modification of other sites).

## リモートコード使用の申告

「リモートコードを使用していますか」→ **いいえ**。全 script は拡張パッケージ内のローカルバンドルのみ（webpack でバンドル。CDN 不使用・CSP は MV3 既定）。

**補足（共有スプレッドシートの許可用 Picker ページについて）**: 拡張パッケージの外に、GitHub Pages が配信する通常の Web ページ（`hosted/picker.html`。公開 URL: <https://youkiti.github.io/sr-query-builder-plugin/picker.html>）がある。このページは Google のスクリプト（`accounts.google.com/gsi/client` と `apis.google.com/js/api.js`）を読み込むが、これは**そのページ自身のオリジン（`youkiti.github.io`）で実行され、拡張機能のコンテキストには一切入らない**。拡張機能はこのページを `chrome.identity.launchWebAuthFlow` で開くだけで、受け取るのはリダイレクト URL（`https://<拡張ID>.chromiumapp.org/picker#picked=<ファイルID>`）に含まれる**ファイル ID のみ**。MV3 の CSP（`script-src 'self'`）により、拡張ページ内にリモートスクリプトを読み込むことはそもそもできない構成であり、上記「いいえ」の回答はこの構成を前提にしている。

**`externally_connectable` は設定していない**（`src/manifest.json` に該当キーは無い）。Picker ページと拡張機能の間はメッセージパッシングではなく、上記のリダイレクト URL 経由でファイル ID を受け渡すだけのため不要。

## permissions

### `identity` / `identity.email`

- **JA**: 通常のサインインには Google OAuth 2.0（`chrome.identity.getAuthToken`）を使用し、Chrome プロファイルに紐づく Google アカウントでプロジェクト DB である Google Sheets とファイル実体の Google Drive にアクセスします。`identity.email` は `chrome.identity.getProfileUserInfo()` により、サインイン中アカウントのメールアドレスを取得するために使用します。取得したメールアドレスは `FormulaVersions` 等の記録者列（誰が検索式を作成・判定したか）に書き込む監査証跡目的、および下記の Picker 許可フローでのアカウント照合（`login_hint` と一致確認）に使用し、OAuth スコープとしては要求しません。加えて、他人が作成した共有スプレッドシートを開こうとして 403/404 になった場合に限り、`chrome.identity.launchWebAuthFlow` を使用します。これは GitHub Pages で配信する Picker 許可ページ（`hosted/picker.html`）を開き、利用者がそのページ上で選択したファイルの ID を `https://<拡張ID>.chromiumapp.org/picker#picked=<ファイルID>` へのリダイレクトで受け取るためのもので、この用途でアクセストークン自体が拡張機能へ渡ることはありません（拡張が受け取るのはファイル ID のみ）。いずれの経路でも、メールアドレスやアクセストークンを開発者サーバーへ送信することはありません（開発者サーバーは存在しません）。
- **EN**: For ordinary sign-in, this extension uses Google OAuth 2.0 (`chrome.identity.getAuthToken`), which signs in with the Google account associated with the Chrome profile to access the user's Google Sheets (used as the project database) and Google Drive (used to store files). `identity.email` is used via `chrome.identity.getProfileUserInfo()` to obtain the signed-in account's email address, which is written to audit-trail columns (e.g., `FormulaVersions`) to record who created or judged a given search strategy, and is also used for account matching (as a `login_hint` and for verification) in the Picker grant flow described below; it is not requested as an OAuth scope. In addition, `chrome.identity.launchWebAuthFlow` is used only when opening a spreadsheet shared by someone else results in a 403/404. It opens a Picker grant page hosted on GitHub Pages (`hosted/picker.html`) and receives the ID of the file the user selected there via a redirect to `https://<extension-id>.chromiumapp.org/picker#picked=<fileId>`; the access token itself is never handed to the extension in this flow (only the file ID is received). In neither path is the email address or any access token sent to a developer-operated server (there is none).

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

**補足（Picker 許可ページの OAuth クライアントについて）**: 上記は拡張機能本体（`src/manifest.json` の `oauth2` 設定）が要求するスコープであり、`drive.file` 1 本のままです。これとは別に、GitHub Pages で配信する Picker 許可ページ（`hosted/picker.html` / [src/picker/picker.ts](../../src/picker/picker.ts)）は、拡張機能とは異なる（ウェブアプリ型の）OAuth クライアントを使い、`drive.file` に加えて `userinfo.email` を要求します。`userinfo.email` は「拡張機能でログイン中のアカウントと同一のアカウントで許可されたか」を照合するためだけに使用し、照合およびファイル選択（Google Picker の表示）が終わった時点でこのページの用は済み、トークンはページの遷移とともに失われます。拡張機能側へアクセストークンが渡ることはなく、拡張が受け取るのは選択されたファイルの ID のみです。なお、このウェブ用 OAuth クライアントは拡張機能の OAuth クライアントと同一の GCP プロジェクトに属している必要があります（`drive.file` の付与がプロジェクト単位のため）。
