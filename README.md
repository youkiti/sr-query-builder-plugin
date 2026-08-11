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

## ライセンス

- 本拡張: [MIT](LICENSE)
- サードパーティライブラリ: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
