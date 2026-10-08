# sr-query-builder-plugin

研究プロトコル（RQ / PICO / PECO / PCC / SPIDER / custom など）から PubMed 検索式を生成・検証し、CENTRAL / Embase(Dialog) / ClinicalTrials.gov / ICTRP 向けに変換する MIT ライセンスの OSS Chrome 拡張です。

**[Chrome ウェブストアでインストール →](https://chromewebstore.google.com/detail/sr-query-builder-plugin/bckokafmjighegpjiocopkagghppnjld)**

> **ステータス**: Chrome ウェブストアで**公開中**（v0.3.0）。`master` ブランチは次版を開発中です。プロトコル入力 → ブロック承認 → シード論文 → 検索式ドラフト → 検証 → エクスポートの各ルートと unit / E2E テストスイートを実装済みですが、P1 分析ロジック（ブロック重複・MeSH 分析）などは未実装です。詳細は [docs/requirements.md](docs/requirements.md)・[docs/architecture.md](docs/architecture.md)・[CLAUDE.md](CLAUDE.md) の「未実装・既知のギャップ」を参照してください。

## 公開ページ

- [ランディングページ](https://youkiti.github.io/sr-query-builder-plugin/)
- [使い方ガイド](https://youkiti.github.io/sr-query-builder-plugin/help.html)
- [プライバシーポリシー](https://youkiti.github.io/sr-query-builder-plugin/privacy-policy.html)
- [利用規約](https://youkiti.github.io/sr-query-builder-plugin/terms-of-service.html)

## 使う人向け

[Chrome ウェブストアからインストール](https://chromewebstore.google.com/detail/sr-query-builder-plugin/bckokafmjighegpjiocopkagghppnjld)してください。使い方は[使い方ガイド](https://youkiti.github.io/sr-query-builder-plugin/help.html)にまとめています。研究プロトコル・検索式・検証結果などのデータは開発者のサーバーではなく利用者ご自身の Google スプレッドシート / Google Drive に保存されます（詳細は[プライバシーポリシー](https://youkiti.github.io/sr-query-builder-plugin/privacy-policy.html)を参照）。

<a id="benchmark"></a>

## ベンチマーク（モデルごとの成績）

設定画面の「使用モデル」の横にある「?」は、この節を開きます。既定のモデルを Claude Opus 5.5 にした根拠も、この表です。

公開済みのシステマティックレビュー 20 件について、プロトコルだけを渡して PubMed 検索式を作らせ、そのレビューが組み入れた研究をどれだけ拾えたかを測りました（2026-10-08 測定。1 レビューにつき 3 本ずつ作り、1 本の値は 3 本の平均です）。

| モデル（推論の強さ） | 動かし方 | 平均再現率 | 全捕捉の割合 | ヒット件数（中央値） | 3 本束ねの平均再現率 ※1 | 所要時間（1 本、中央値） | 費用（1 本） |
|---|---|---|---|---|---|---|---|
| **Claude Opus 5.5（medium）** | **このアプリの生成経路** | **0.934** | **60.0%** | **1,040** | 測っていない | 64 秒 | 約 0.28 ドル以下 ※2 |
| Claude Opus 5.5（medium） | 実験用の実行環境 | 0.948 | 61.7% | 1,087 | 0.965 | 48 秒 | 金額は出していない |
| gpt-6-astra（medium） | 実験用の実行環境（codex） | 0.945 | 61.7% | 1,634 | 0.955 | 97 秒 | 金額は出していない ※3 |
| Claude Sonnet 5.5（medium） | 実験用の実行環境 | 0.905 | 55.0% | 1,297 | 0.934 | 30 秒 | 金額は出していない |
| Gemini 3.8 Flash（high） | 実験用の実行環境 | 0.861 | 46.7% | 694 | 0.869 ※4 | 300 秒 | 約 0.5 ドル ※5 |
| Claude Haiku 5.5（指定なし） | 実験用の実行環境 | 0.860 | 45.0% | 901 | 0.907 | — | 金額は出していない |
| GLM-5.3（high） | 実験用の実行環境（OpenRouter） | 0.826 | 45.0% | 629 | 0.885 | 67 秒 | 0.028 ドル |
| Qwen3.8 27B（high） | 実験用の実行環境（OpenRouter） | 0.812 | 43.3% | 718 | 0.880 | 166 秒 | 0.020 ドル |

- **平均再現率**: レビューが組み入れた研究のうち、式が拾えた割合（研究単位）。
- **全捕捉の割合**: 組み入れた研究を 1 つも落とさなかった実行の割合。
- **ヒット件数**: 作った式の PubMed でのヒット件数。20 件の中央値。
- ※1 同じ条件で作った 3 本を OR で束ねた式の成績です。**このアプリには束ねる機能が無いので、アプリでは出せない値です。**
- ※2 2026-10-08 の料金表で、キャッシュの割引を入れずに計算した上限です。
- ※3 ChatGPT のサブスクリプションの利用枠で実行しました。
- ※4 束ねた式 20 件のうち 1 件は、ワイルドカードが PubMed の上限（256 個）を超えて実行できず、再現率 0 として数えています。
- ※5 60 本あまりの合計（約 30 ドル。キャッシュの割引を入れない計算）を本数で割った値です。

### 読むときの注意

- **アプリのコードをそのまま動かしたのは、先頭の 1 行だけです。** ほかの行は、同じ手順書を実験用の実行環境で動かした結果で、アプリでそのモデルを選んだときの成績ではありません。とくに、Gemini と OpenRouter のモデルは、アプリでは道具を呼ばない別の経路で式を作ります。
- 20 件は、手順書を選ぶ過程で繰り返し使ったレビューです。それ以外のレビューで同じ成績になるかは確かめていません。
- モデルのあいだの差には、推論の強さ、API の形式、提供元の違いが混ざっています。
- 実験には人の確認が入っていません。アプリでは、概念ブロックを人が直してから式を作るので、実際の成績は確認のしかたで上下します。
- 測ったのは、式を最初に作る部分だけです。そのあとの自動調整は対象に入っていません。
- 既知の研究を拾えたことは、未知の適格研究を漏らさないことを保証しません。

条件・数え方・信頼区間・ほかの比較は、[実験の記録](experiments/protocol-to-formula-loop/log.md)（第 4〜6 ラウンドと「アプリの生成経路での確認」）と [集計の出力](experiments/protocol-to-formula-loop/reports/) にあります。

## 開発する人向け

ソースからビルドして動作確認・開発したい方向けの手順です。ストアからインストールするだけの一般利用者にはこの節は不要です。

### 主なドキュメント

- [要件定義書](docs/requirements.md)
- [画面遷移図](docs/ui-flow.md)
- [ブロック承認 UI ワイヤーフレーム](docs/ui-block-approval.md)
- [アーキテクチャ / ディレクトリ構造](docs/architecture.md)
- [ライブラリアンフローチャート](docs/librarian-flowchart.md)
- [UI レビュー戦略](docs/ui-review-strategy.md)
- [UI 状態マトリクス](docs/ui-states.md)

### 開発環境

- Node.js ≥ 18
- npm ≥ 10

```bash
npm install
cp .env.example .env  # OAuth クライアント ID を設定
npm run dev           # 開発ビルド（dist/ へ出力）
npm run watch         # 差分ビルド
npm run build         # 本番ビルド（dist-release/ へ出力）
npm run pack:release  # dist-release/ をストア提出用 zip に変換（要 npm run build）
npm run lint
npm run lint:css      # stylelint（[hidden] 規約の固定化）
npm run typecheck
npm run test
npm run test:coverage
npm run test:e2e      # Playwright スモーク（事前に `npx playwright install chromium` が必要）
```

### UI レビュー層（[docs/ui-review-strategy.md](docs/ui-review-strategy.md)）

`npm run lint:css` は CSS の `[hidden]` リセット規約を固定化する Tier 0、`npm run test:e2e` は実 Chromium で app 全 11 ルート + popup + options の可視状態・ガード・ジャーニー・axe a11y 監査を回す Tier 2 / Tier 3（[docs/ui-deep-test-plan.md](docs/ui-deep-test-plan.md) Phase A〜G）。各ケースは [docs/ui-states.md](docs/ui-states.md) の状態 ID に対応する。

テストの CI は未配置（GitHub Actions は公開ページのデプロイ [deploy-pages.yml](.github/workflows/deploy-pages.yml) のみ）。検証はローカルで以下を一通り通す:

```bash
npm run lint && npm run lint:css && npm run typecheck && npm test && npm run test:e2e
```

### 拡張の読み込み方法（開発時）

以下は自前ビルドを Chrome に読み込んで動作確認するための手順です。ストアからインストールする一般利用者には不要です（OAuth クライアント ID の発行も開発用）。

1. Google Cloud Console で OAuth クライアント（アプリケーションタイプ: Chrome 拡張）を作成
2. クライアント ID を `.env` の `LOCAL_OAUTH_CLIENT_ID` に設定
3. `npm run dev` で `dist/` を生成
4. Chrome の `chrome://extensions` で「デベロッパーモード」を ON にし、「パッケージ化されていない拡張機能を読み込む」で `dist/` を選択

### Google Picker（共有スプレッドシートを開く導線）の設定

OAuth スコープは `drive.file` の 1 本のみで、Drive 全体は読みません。その代わり、**他人が作って共有したスプレッドシートは、利用者が Google ピッカーでそのファイルを選択するまで開けません**（403/404 になる）。この選択画面は Manifest V3 の CSP により拡張内に置けないため、GitHub Pages 側の [hosted/picker.html](hosted/picker.html) でホストし、拡張は `chrome.identity.launchWebAuthFlow` でそれを開いて選択結果を受け取ります（実装は [src/picker/picker.ts](src/picker/picker.ts) と [src/lib/google/pickerUrl.ts](src/lib/google/pickerUrl.ts)）。

この導線を動かすには、**拡張用 OAuth クライアントと同一の GCP プロジェクト**で以下を用意します（`drive.file` の付与はプロジェクト単位のため、別プロジェクトのクライアントで選択させても拡張側からは読めません）。

1. Google Picker API（`picker.googleapis.com`）を有効化する（`photospicker.googleapis.com` は別物）
2. API キーを発行し、**発行と同時に**「HTTP リファラー制限（`https://youkiti.github.io/*` と `http://localhost:8080/*`）」「API 制限（Picker API のみ）」を設定する
3. OAuth クライアント（アプリケーションタイプ: **ウェブアプリケーション**）を作成し、承認済み JavaScript 生成元に `https://youkiti.github.io` と `http://localhost:8080` を登録する
4. 上記 2 つと GCP プロジェクト番号を `.env`（`PICKER_API_KEY` / `PICKER_WEB_CLIENT_ID` / `GCP_PROJECT_NUMBER`）と GitHub の repository **variables** に設定する

3 値はいずれも公開配信される JS に埋め込まれるため構造上秘匿できません（secrets ではなく variables に置くのはこのため）。API キーはリファラー制限と API 制限で守ります。ローカルでの確認手順とデプロイの仕組みは [hosted/README.md](hosted/README.md) を参照。

## ライセンス

- 本拡張: [MIT](LICENSE)
- サードパーティライブラリ: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
