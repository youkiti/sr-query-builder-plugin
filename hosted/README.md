# hosted/ — GitHub Pages 配信ファイル（公開ページ）

`gh-pages` ブランチのルートへ配置する、ランディング・使い方ガイド・プライバシーポリシー・利用規約 4 ページの正典置き場。拡張本体とのメッセージプロトコル等の結合は無く、拡張側からは通常の外部リンク（`target="_blank"`）で新規タブに開くだけ。

## ファイルと公開 URL の対応

| ファイル | 役割 | 公開 URL |
|---|---|---|
| [index.html](index.html) | ランディング（なにをするツールか・画面イメージ・BYOK・はじめかた） | `https://youkiti.github.io/sr-query-builder-plugin/` |
| [help.html](help.html) | 使い方ガイド（ワークフローレベル。トラブルシューティング・FAQ を含む） | `https://youkiti.github.io/sr-query-builder-plugin/help.html` |
| [privacy-policy.html](privacy-policy.html) | プライバシーポリシー（`docs/store/privacy-policy.md` の転記＋英訳。ストア審査必須） | `https://youkiti.github.io/sr-query-builder-plugin/privacy-policy.html` |
| [terms-of-service.html](terms-of-service.html) | 利用規約 | `https://youkiti.github.io/sr-query-builder-plugin/terms-of-service.html` |
| [style.css](style.css) | 4 ページ共通スタイル（青基調。`src/styles/tokens.css` の `--color-primary: #2a63d6` に準拠） | `https://youkiti.github.io/sr-query-builder-plugin/style.css` |
| [lang.js](lang.js) | 表示言語（ja / en）の解決・切替 | `https://youkiti.github.io/sr-query-builder-plugin/lang.js` |
| [screenshots/](screenshots/) | index.html が参照するスクリーンショット 5 枚（`s1-protocol.png` 〜 `s5-export.png`） | `https://youkiti.github.io/sr-query-builder-plugin/screenshots/*.png` |

## 表示言語の仕組み（ja / en の切替。併記はしない）

- 本文は `.ja` / `.en` の span で両言語を持ち、表示・非表示は CSS（`html[data-lang]`）が行う
- `<title>` / meta description は `data-en`、`alt` / `aria-label` 等の属性は `data-en-<属性名>` に英語を持たせ、`lang.js` が差し替える（元の ja は `data-ja` / `data-ja-<属性名>` へ退避）
- 言語の決定順は **`?lang=` → `localStorage`（キー: `sr-query-builder-plugin.lang`） → ブラウザの言語設定 → `ja`**
- ヘッダー（index はヒーロー）の `[data-lang-switch]` に `lang.js` が切替ボタンを組み立てる。JS が無効な環境では `data-lang` が付かず、従来どおり両言語が並ぶ（degrade）
- `lang.js` は `<head>` から同期読み込みする（初回描画より前に `data-lang` を確定させ、切替のちらつきを避けるため）

## 更新時に守ること

- **プライバシーポリシーの正典は [../docs/store/privacy-policy.md](../docs/store/privacy-policy.md)**。`privacy-policy.html` はその転記＋英訳なので、**内容を変えるときは両方を直す**（乖離するとストア審査で参照される URL の内容とリポジトリの原稿がずれる）
- 文言を足すときは **ja / en の両方**を書く（`.ja` / `.en` の span 対、または `data-en-*` 属性）。「日本語 / English」のような 1 要素内での併記は作らない（切替で片方だけを見せられなくなる）
- `help.html` の内容は**ワークフローレベル**に留める（画面細部は拡張内のリード文が担う）。冒頭の「最終更新 / 対象バージョン」は内容を変えたら更新する
- 各ファイル冒頭コメントの `version:` を更新日に書き換える（デプロイ版の識別用）
- **Chrome ウェブストア公開後に差し替えが必要な箇所（現時点では未実施。ストア審査通過時に対応する）**:
  - `index.html` のヒーロー CTA（現在は「GitHub でソースを見る」）を、ストアのインストールリンクへ差し替える
  - `index.html`「はじめかた」の自前ビルド手順（`.env` の OAuth クライアント ID 発行を含む一連の手順）を、ストアからのインストール手順に差し替える

## デプロイ手順（初回。`gh-pages` ブランチはまだ存在しない）

> **作業ツリーを壊す操作（`git checkout --orphan` + `git rm -rf .` を今のツリーで実行する等）はしないこと。**
> このリポジトリは submodule を 2 つ持ち、かつ複数セッションが同じ作業ツリーを共有することがあるため、
> 今の作業ツリーの中身を消すコマンドは事故になる。`git worktree` で `gh-pages` 専用の別ディレクトリを作り、
> そちらでコミット・push する。

1. **先にスクリーンショットを撮る**: `npm run shots`（Playwright + stub 環境。実 API を叩かず無人実行できる）で `screenshots/` の 5 枚（`s1-protocol.png` 〜 `s5-export.png`）を取得する。撮影せずにデプロイすると `index.html` のスクリーンショットセクションの画像リンクが切れる。実際にアプリを動かした本物の画面で撮り直したいとき（stub のデモデータではなく実 Google/Gemini/NCBI API の応答を見せたいとき）は、代わりに `npm run manual:check -- --shots` を使う（詳細は [docs/manual-testing.md](../docs/manual-testing.md)）
2. `gh-pages` 用の孤立 worktree を、今の作業ツリーの外（兄弟ディレクトリ）に作る:
   ```bash
   git worktree add --orphan -b gh-pages ../sr-query-builder-plugin-gh-pages
   ```
   （`git worktree add --orphan` は Git 2.42 以降が必要。それ以前の git しか無い場合は、代わりに
   `git clone --no-checkout <このリポジトリの URL> ../sr-query-builder-plugin-gh-pages && cd ../sr-query-builder-plugin-gh-pages && git checkout --orphan gh-pages && git rm -rf .`
   で同じ状態を作れる。いずれも**今の作業ツリーには触れない**）
3. `hosted/` 配下の内容（`index.html` / `help.html` / `privacy-policy.html` / `terms-of-service.html` / `style.css` / `lang.js` / `screenshots/`）を、作成した worktree のルートへコピーする
4. worktree 側でコミットして push する:
   ```bash
   cd ../sr-query-builder-plugin-gh-pages
   git add index.html help.html privacy-policy.html terms-of-service.html style.css lang.js screenshots
   git commit -m "chore: GitHub Pages 公開ページを追加"
   git push -u origin gh-pages
   ```
5. worktree を片付ける（任意。残しておいて次回の更新にも使い回してよい）:
   ```bash
   cd -
   git worktree remove ../sr-query-builder-plugin-gh-pages
   ```
6. GitHub の Settings → Pages で Source を `gh-pages` ブランチ / `/ (root)` に設定して有効化する

## デプロイ手順（2 回目以降の更新）

1. 上記「更新時に守ること」を反映する
2. `gh-pages` ブランチのルートへ、変更したファイルを本ディレクトリの内容で上書きして push する。
   初回デプロイで作った worktree（`../sr-query-builder-plugin-gh-pages`）を消さずに残してあればそれを再利用する。
   消してしまった場合は `git worktree add ../sr-query-builder-plugin-gh-pages gh-pages`（`--orphan` は付けない。
   既存の `gh-pages` ブランチを普通にチェックアウトするだけでよい）で作り直せる。いずれも今の作業ツリーでは行わない

## デプロイ後の確認項目

PC 幅とスマホ幅の両方で確認する:

- 4 ページ間の相互リンク（ヘッダー nav / フッター / 本文内リンク）がすべて正しい URL を指しているか
- `index.html` のスクリーンショット 5 枚が表示されるか（リンク切れ・404 が無いか）
- 言語切替が機能するか: ヘッダー（index はヒーロー）の切替ボタン／URL に `?lang=en` を付けて開いた場合／言語を切り替えた状態で別ページへ遷移したときに選択が保持されるか（`localStorage`）

## 未実施の運用作業（本 README には手順のみ記載。実行はしていない）

- ストアダッシュボードの「プライバシーポリシー URL」欄を `https://youkiti.github.io/sr-query-builder-plugin/privacy-policy.html` に設定する
- ストアダッシュボードの「ウェブサイト」欄を `https://youkiti.github.io/sr-query-builder-plugin/` に設定する

（[docs/store/README.md](../docs/store/README.md) に記載の通り、本拡張はまだ Chrome ウェブストアに提出していないため、上記 2 点は提出フェーズで行う）
