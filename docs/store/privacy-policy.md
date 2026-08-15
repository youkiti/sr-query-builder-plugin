# プライバシーポリシー — SR Query Builder（sr-query-builder-plugin）

- **最終更新**: 2026-08-15
- **対象バージョン**: v0.3.0
- **対象**: Chrome 拡張機能「SR Query Builder」（sr-query-builder-plugin）
- **配布元**: 本拡張は MIT ライセンス（[LICENSE](../../LICENSE)）の OSS です。

このページは、Chrome ウェブストアの審査および利用者への開示のために、本拡張が扱うデータとその流通経路を説明します。

## 要点

**本拡張の開発者が運用するサーバーは存在しません。** 利用者のデータが開発者側に送信・保存・収集されることは一切ありません。データはすべて、以下の各主体との間でのみ流通します。

1. **利用者のブラウザ**（本拡張の実行環境。`chrome.storage` を含む）
2. **利用者の Google アカウント**（Google Sheets = プロジェクト DB、Google Drive = LLM API ログなどの実体保管）
3. **利用者が自分の API キー（BYOK: Bring Your Own Key）で契約する LLM API（Gemini または OpenRouter。既定は Gemini）、NCBI E-utilities、および NLM MeSH RDF（MeSH 階層情報の取得。API キー不要の公開エンドポイント）**

## 取り扱うデータと送信先

| データ | どこへ | 目的 |
|---|---|---|
| 研究プロトコル（RQ・PICO 等）・検索式ブロック定義・シード論文（PMID）・検索式ドラフト・検証結果・LLM API ログ | 利用者の Google Sheets（プロジェクトのスプレッドシート内の各タブ） | プロジェクト DB。監査ログ・バージョニング目的 |
| LLM API ログのフル payload | 利用者の Google Drive（プロジェクトの Drive フォルダ配下 `logs/llm/*.json`） | Sheets のセル文字数制限を超える内容の退避 |
| 研究プロトコル本文・検索式ブロック定義・検索式ドラフトなど | 利用者が選択した LLM プロバイダ（Gemini または OpenRouter。既定は Gemini）の API（BYOK） | AI による検索式ドラフト生成・MeSH 提案・シノニム展開等。本文が外部へ送信されるのはこの経路と NCBI E-utilities のみ（NLM MeSH RDF へは研究プロトコル本文を送信せず、descriptor 名・tree number のみを送信します） |
| 検索式・PMID | NCBI E-utilities（`eutils.ncbi.nlm.nih.gov`） | ヒット数検証・MeSH 用語の取得・シード論文の捕捉率計算 |
| ブロック内の MeSH 用語（descriptor 名・tree number） | NLM MeSH RDF（`id.nlm.nih.gov` の SPARQL エンドポイント） | MeSH 階層（親子関係）の解析。ブロック内の用語重複・カテゴリ分散の検出（次回の拡張機能更新から適用。現在配信中の v0.3.0 はこの通信を行いません） |
| 開こうとした共有スプレッドシートの ID・サインイン中のメールアドレス | 本拡張の公開ページ（`youkiti.github.io` の `picker.html`）。URL フラグメント（`#` 以降）で渡すため、HTTP リクエストとしては送信されません | Google ピッカーで対象ファイルを選択し、そのファイルだけにアクセスを許可するため（次回の拡張機能更新から適用。現在配信中の v0.3.0 はこの画面を使いません） |
| Google OAuth トークン | 利用者のブラウザ内（`chrome.storage`） | Google API 認証。開発者へは送信されません |
| LLM プロバイダ（Gemini / OpenRouter）の API キー・NCBI API キー | 利用者のブラウザ内（`chrome.storage`） | 各 API の認証（BYOK）。開発者へは送信されません |

## Google ユーザーデータへのアクセス範囲

本拡張が要求する OAuth スコープは以下の 1 つ **のみ** です。

- `https://www.googleapis.com/auth/drive.file` — **利用者が作成に関与したファイル（本拡張が作成したスプレッドシート・Drive フォルダ・ログファイル、および利用者が Google ピッカーで明示的に選択したファイル）だけ** にアクセスします。Drive 全体を読むスコープ（`drive.readonly` 等）や、全スプレッドシートへアクセスできる `https://www.googleapis.com/auth/spreadsheets` スコープは要求しません。

### 共有スプレッドシートを開くとき（Google ピッカー）

（次回の拡張機能更新から適用。現在配信中の v0.3.0 はこの画面を使いません）

他の利用者が作成して共有したスプレッドシートは、上記スコープの性質上、**利用者がそのファイルを明示的に選択するまで本拡張からは読めません**。このため、共有スプレッドシートを開こうとしたときに Google 公式の「ピッカー」（ファイル選択画面）を表示し、対象ファイルを 1 回だけ選んでもらいます。選択されたファイルにのみアクセスが許可され、Drive 上の他のファイルは対象になりません。

ピッカーの画面は、Chrome 拡張のセキュリティ制約（Manifest V3 の CSP）により拡張内に埋め込めないため、本拡張の公開ページ（`https://youkiti.github.io/sr-query-builder-plugin/picker.html`。GitHub Pages で配信される静的ページ）に置いています。このページは Google の公式スクリプトを読み込んでファイル選択画面を表示し、**選択されたファイルの ID を拡張機能へ返すだけ**です。開発者が運用するサーバーは介在せず、ファイルの内容もサインイン情報もこのページには保存されません。なお、選択の際に利用者のメールアドレスを URL のフラグメント（`#` 以降。HTTP リクエストとして送信されない部分）で渡し、拡張でサインイン中のアカウントと同一かを確認します。異なるアカウントで許可された場合は、取得したトークンを破棄して選択をやり直してもらいます。

サインイン中アカウントのメールアドレスは OAuth スコープではなく、Chrome 拡張 API の `chrome.identity.getProfileUserInfo()`（`identity.email` permission）で取得します。これは Chrome プロファイルの同期アカウント情報を読むだけで、OAuth スコープを広げるものではありません。取得したメールアドレスは `FormulaVersions` 等の記録者列に書き込む目的にのみ使用し、開発者へ送信することはありません。

本拡張は、Google API から取得したユーザーデータを、上記の機能提供以外の目的（広告・分析・第三者への提供・機械学習モデルの学習等）に **一切使用しません**。Google API Services User Data Policy（Limited Use 要件を含む）を遵守します。

## LLM API・NCBI API への送信について

- **LLM プロバイダ（Gemini または OpenRouter。既定は Gemini）**: 検索式のドラフト生成や検証結果の解釈補助を実行すると、研究プロトコルの本文・検索式ブロック定義・検索式ドラフトなどが、利用者が選択した LLM プロバイダの API キー（BYOK）を用いて、そのプロバイダ（Google の Gemini API、または OpenRouter）へ送信されます。送信先によるデータの取り扱いは、各プロバイダ自身のプライバシーポリシー・利用規約に従います。本拡張はプロバイダを仲介せず、利用者のブラウザから直接 API を呼び出します。
- **NCBI E-utilities**: 検索式の検証（ブロックごとのヒット数、シード論文捕捉率、MeSH 用語抽出）のため、検索式や PMID を NCBI の E-utilities（`eutils.ncbi.nlm.nih.gov`）へ送信します。NCBI API キーは任意で BYOK として設定でき、レート制限緩和のために使用します。
- **NLM MeSH RDF（SPARQL エンドポイント）**: ブロック内の MeSH 用語について、MeSH ツリー上の親子関係（祖先・子ノードの名称）を取得するため、descriptor 名や tree number を NLM の MeSH RDF エンドポイント（`id.nlm.nih.gov/mesh/sparql`）へ SPARQL クエリとして送信します。PMID や研究プロトコルの本文は送信されません。認証や API キーは不要です。

## データの保存・削除

- すべてのデータは利用者自身の Google アカウント（Sheets / Drive）とブラウザローカルストレージに保存されます。削除は、利用者が Google Drive / Sheets 上のファイルを削除し、拡張を削除（またはブラウザのストレージをクリア）することで完結します。
- 本拡張をアンインストールすると、`chrome.storage` 内の設定（LLM プロバイダ（Gemini / OpenRouter）・NCBI の API キー、認証状態等）は Chrome によって削除されます。Google Drive / Sheets 上のプロジェクトデータは利用者の資産としてそのまま残ります。

## 第三者提供・データ販売

本拡張は、利用者のデータを第三者へ販売・提供しません。開発者はデータを収集しないため、そもそも提供しうるデータを保持しません。

## お問い合わせ

本ポリシーに関する問い合わせは、GitHub リポジトリの Issues へお願いします: <https://github.com/youkiti/sr-query-builder-plugin/issues>
