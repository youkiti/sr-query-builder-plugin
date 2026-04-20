# UI レビュー戦略（提案 v0.1）

- **作成日**: 2026-04-20
- **動機**: ポップアップの「Google でログイン」セクションと「プロジェクト選択」セクションが同時表示された `[hidden]` CSS バグ ([popup.css] 修正済) を目視まで発見できなかった。同種のバグを構造的に拾う体制が必要。
- **前提**: 要件定義フェーズ終盤。画面数は popup / app / options の 3 つ、app 内のハッシュルートで 10 画面強。本腰のテスト投資は MVP 直前〜リリース直前が適切。

## 1. 今回のバグが何故漏れたか（失敗の解剖）

| レイヤ | 実際にやっていたこと | 漏れの本質 |
|---|---|---|
| 単体テスト (jest + jsdom) | `element.hidden === true/false` を assert | **HTML 属性**だけ見て、**実際に画面に見えているか**を見ていない |
| CSS | `.popup__section { display: flex }` を書いた | UA スタイル `[hidden] { display: none }` の specificity (0,1,0) に勝ってしまう副作用を誰も指摘しなかった |
| 目視 | 「ログイン後に画面が切り替わる」を手で確認 | **初回だけ**確認。その後のリグレッションに気付けない |

つまり「属性テストは通る」「CSS lint は警告なし」「目視は昔やった」で 3 層すべてを通り抜けた。この構図は同じパターンのバグ（`display: grid` 側・`visibility` 側・`pointer-events: none` 付け忘れ・z-index 競合 等）でも再現する。

## 2. UI バグのカテゴリと、今ある / 採り得る対策の対応表

| カテゴリ | 具体例 | jsdom 単体テスト | CSS lint | real-browser smoke (Playwright) | visual regression (screenshot) | a11y 監査 (axe) |
|---|---|---|---|---|---|---|
| **ロジック / 状態遷移** | 未ログインでも推移できてしまう | ✅ 現状ここを分厚くしてある | — | ✅ | — | — |
| **CSS specificity / 副作用** | 今回の `[hidden]` バグ | ❌ 属性だけ見ていて computed style を見ない | △ 規約化すれば | ✅ `isVisible()` で拾える | ✅ screenshot 差分で拾える | — |
| **レイアウト / はみ出し / 折返し** | 長いタイトルがボタンに被さる | ❌ | — | △ 寸法 assert すれば | ✅ 最強 | — |
| **アクセシビリティ** | label 無しの input / 低コントラスト | — | △ 一部 | ✅ axe 組込 | — | ✅ |
| **キーボード操作 / フォーカス** | i / e / m ショートカット動かない | △ jsdom は keyboard 弱 | — | ✅ | — | △ |
| **操作フロー E2E** | 新規作成してメインビューに遷移 | ✅ 現状カバー（モック依存） | — | ✅ 実 DOM で再確認できる | — | — |

現状は**ロジックに偏って分厚く、CSS / レイアウト系に対してほぼ無防備**。今回のバグはその空隙に落ちた。

## 3. 推奨レイヤ構成（小さく始めて段階的に）

### Tier 0: CSS 規約（実装済＋ stylelint で固定化）

- 今回の修正: [styles/globals.css](../src/styles/globals.css) に `[hidden] { display: none !important }` を追加。
- **追加推奨**: `stylelint` を導入し、以下のカスタムルールで同種の再発を防ぐ：
  - `hidden` 属性を使うページの CSS で `[hidden]` ルールが存在することを保証
  - `.popup__section { display: ... }` のような「要素 + display」を直書きする前に `:not([hidden])` で限定するよう警告
- コスト: **0.5 日**。`stylelint` + `stylelint-config-standard` + 独自ルール or `stylelint-plugin-no-unsupported-browser-features`。

### Tier 1: 状態マトリクス docs/ui-states.md（人+AI 共用のチェックリスト）

各画面 × 各状態 × 受入基準を列挙する。以後の目視レビューも AI レビューもこの spec に対してやる。

例（抜粋）:

```markdown
## Popup

### 状態 A: 未ログイン
- 表示: Title / 説明文 / 「Google でログイン」ボタン / 設定リンク
- 非表示: 最近のプロジェクト / 新規作成 / 既存を開く / ログアウト / email 表示
- `[hidden]` 属性: popup-auth=false, popup-projects=true

### 状態 B: ログイン済・最近のプロジェクト 0 件
- 表示: email / ログアウト / 新規作成 / 既存を開く / 設定リンク
- 非表示: Google ログインボタン / 最近のプロジェクト
- ステータス文言: "新しいプロジェクトを作成するか..."

### 状態 C: ログイン済・最近のプロジェクト N 件
- 表示: 上記 + 最近のプロジェクト一覧（N 件のボタン）
- ステータス文言: "最近のプロジェクトから選ぶか..."

### エッジ: プロジェクト名が長い (例: 100 文字)
- 折り返すか省略されるか、横スクロール出さない
```

- これは実装じゃなくてスペックなので、**Claude にレビューを頼む時もこの spec を渡す**。
- コスト: popup + app + options で **半日**程度。

### Tier 2: Playwright real-browser smoke（バグの大半を拾う一番費用対効果の高い層）

jsdom の限界（`[hidden]` を属性としてしか見ない）を超えるのに、**実 Chromium で popup.html / app.html を読み込んで computed style を assert する**。これが決め手。

```ts
// 例: tests/e2e/popup.spec.ts
test('ログイン済でプロジェクト N 件: 必要な要素だけが visible', async ({ page }) => {
  await page.goto(`file://${distDir}/popup/popup.html`);
  await page.evaluate(() => { /* chrome.* をスタブ */ });
  // 実 DOM + CSS で assert
  await expect(page.locator('#login-button')).toBeHidden();       // ← 今回のバグを一発で拾う
  await expect(page.locator('#logout-button')).toBeVisible();
  await expect(page.locator('#popup-recent button')).toHaveCount(2);
  await expect(page).toHaveScreenshot('popup-authed-2projects.png'); // ← 視覚回帰
});
```

- `await expect(locator).toBeHidden()` / `toBeVisible()` は `display / visibility / opacity / viewport inside` 全部見る → 属性テストでは拾えないものを拾う
- `toHaveScreenshot()` は baseline PNG と差分比較。レイアウトの見落とし防止
- chrome.* は `page.addInitScript` で差し替え。実認証不要
- コスト: **1〜1.5 日**（webdriver 環境構築 + 最初の 5-8 テスト + CI 設定）

### Tier 3: a11y 監査 + a11y テスト（ほぼ無料の上乗せ）

- `@axe-core/playwright` を Tier 2 と同じ test に組み込む（+1 行）
- label 無し input / heading 構造不正 / 低コントラスト / ARIA ミス を自動検出
- コスト: **0.5 時間**（Tier 2 を入れた後なら）

### Tier 4 （将来オプション）: Storybook / Chromatic

本拡張は画面数が限定的なので **当面不要**。将来コンポーネント化が進み再利用が重要になったら検討。

## 4. 推奨する実装順序

| フェーズ | 内容 | コスト | 期待リターン |
|---|---|---|---|
| 1（今すぐ） | **Tier 0 の stylelint 規約化** | 0.5 日 | 今回のバグ系統の再発ゼロ |
| 2（MVP 前半） | **Tier 1 の docs/ui-states.md** | 0.5 日 | AI レビュー精度向上・onboarding 資料化 |
| 3（MVP 直前） | **Tier 2 の Playwright smoke（主要 5-8 ケース）** | 1-1.5 日 | CSS / レイアウト / ロジックを横断的に捕捉 |
| 4（Tier 2 と同時） | **Tier 3 axe-core 組込** | +0.5 時間 | a11y 起因の恥ずかしいバグ防止 |

CI は MVP 判定（要件 §11.1）で後から議論となっているので、当面ローカル `npm run test:e2e` コマンドとして持ち、CI 導入と同時に自動化する。

## 5. このリポジトリでの具体的なアクション候補

1. **`stylelint` 導入 + カスタムルール**（Tier 0 固定化）
2. **`docs/ui-states.md` スケルトン作成**（Tier 1 ドキュメント化）
3. **Playwright 導入 + popup 5 ケース**（Tier 2 の最小セット）

ユーザーは 1→2→3 の順で、止めたいところまでの指示を出すだけでいい。例えば「2 まで今やって」「Playwright は来週」のように段階的に進められる。

## 6. 参考: 今回のバグを Tier 2 なら確実に落とせた理由

- `.popup__section { display: flex }` は specificity (0,1,0)。UA の `[hidden] { display: none }` も (0,1,0)。後から読まれる `.popup__section` が勝って `hidden` は無効化される。
- jsdom は CSSOM の一部しか実装していないため、`getComputedStyle(el).display` は CSS が完全に適用された値を返さない（未サポートのプロパティは `""` になる）。結果、jest では検出不能。
- Playwright は Chromium 本体を使うので同じコードを同じ描画で走らせ、`.toBeHidden()` は computed style を見て判定する。一発で false になる。

このバグは「3 層とも通り抜けるタイプ」ではなく「**実ブラウザの computed style を見る層が無いと通り抜けるタイプ**」だった。Tier 2 を 1 個足すだけで同系バグを一網打尽にできる。

[popup.css]: ../src/popup/popup.css
