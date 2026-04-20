# sr-query-builder-plugin

研究プロトコル（RQ / PICO / PECO / PCC / SPIDER / custom など）から PubMed 検索式を生成・検証し、CENTRAL / Embase(Dialog) / ClinicalTrials.gov / ICTRP 向けに変換する MIT ライセンスの OSS Chrome 拡張です。

> **ステータス**: 要件定義完了、実装スケルトン構築中。詳細は [docs/requirements.md](docs/requirements.md) と [docs/architecture.md](docs/architecture.md) を参照してください。

## 主なドキュメント

- [要件定義書](docs/requirements.md)
- [画面遷移図](docs/ui-flow.md)
- [ブロック承認 UI ワイヤーフレーム](docs/ui-block-approval.md)
- [アーキテクチャ / ディレクトリ構造](docs/architecture.md)
- [ライブラリアンフローチャート](docs/librarian-flowchart.md)
- [UI レビュー戦略](docs/ui-review-strategy.md)
- [UI 状態マトリクス](docs/ui-states.md)

## 開発環境

- Node.js ≥ 18
- npm ≥ 10

```bash
npm install
cp .env.example .env  # OAuth クライアント ID を設定
npm run dev           # 開発ビルド
npm run watch         # 差分ビルド
npm run build         # 本番ビルド
npm run build:zip     # dist/ を zip 化
npm run lint
npm run lint:css      # stylelint（[hidden] 規約の固定化）
npm run typecheck
npm run test
npm run test:coverage
npm run test:e2e      # Playwright スモーク（事前に `npx playwright install chromium` が必要）
```

### UI レビュー層（[docs/ui-review-strategy.md](docs/ui-review-strategy.md)）

`npm run lint:css` は CSS の `[hidden]` リセット規約を固定化する Tier 0、`npm run test:e2e` は実 Chromium で popup の可視状態と axe a11y 監査を回す Tier 2 / Tier 3。`tests/e2e/popup.spec.ts` の各ケースは [docs/ui-states.md](docs/ui-states.md) の状態 ID に対応する。

CI 投入は MVP 直前の予定（要件 §11.1）。それまではローカルで以下を一通り通す:

```bash
npm run lint && npm run lint:css && npm run typecheck && npm test && npm run test:e2e
```

## 拡張の読み込み方法（開発時）

1. Google Cloud Console で OAuth クライアント（アプリケーションタイプ: Chrome 拡張）を作成
2. クライアント ID を `.env` の `LOCAL_OAUTH_CLIENT_ID` に設定
3. `npm run dev` で `dist/` を生成
4. Chrome の `chrome://extensions` で「デベロッパーモード」を ON にし、「パッケージ化されていない拡張機能を読み込む」で `dist/` を選択

## ライセンス

- 本拡張: [MIT](LICENSE)
- サードパーティライブラリ: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
