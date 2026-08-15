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
