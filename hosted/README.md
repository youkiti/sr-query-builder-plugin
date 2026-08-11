# hosted/ — GitHub Pages 配信ファイル（公開ページ）

GitHub Pages で配信する、ランディング・使い方ガイド・プライバシーポリシー・利用規約 4 ページの正典置き場。拡張本体とのメッセージプロトコル等の結合は無く、拡張側からは通常の外部リンク（`target="_blank"`）で新規タブに開くだけ。

**デプロイは自動**（`master` の `hosted/**` が変わると [.github/workflows/deploy-pages.yml](../.github/workflows/deploy-pages.yml) が公開する）。手動のコピー作業は不要になった。詳細は下記「デプロイ（GitHub Actions による自動デプロイ）」を参照。

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
| [README.md](README.md) | 本ファイル（開発者向け）。**配信セットからは除外する**（workflow が `_site/README.md` を削除する） | 配信しない |

`.nojekyll` は不要になった。GitHub Actions 方式では artifact をそのまま配信するので Jekyll のビルドが走らない（旧 `gh-pages` ブランチ方式では Jekyll 抑止のために必要だった）。

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
- **操作解説動画の埋め込みは `index.html` と `help.html` の 2 か所にある**（`.video-frame` +
  `https://www.youtube-nocookie.com/embed/<動画ID>`。現行の動画 ID は `RqUFlmncuIE`）。
  **YouTube は動画本体を差し替えられない**ので、動画を作り直したときは新規公開したうえで
  **2 か所とも**書き換え、旧版を非公開化する（[../video/REQUIREMENTS.md](../video/REQUIREMENTS.md) §9）。
  埋め込みは外部 iframe なので `screenshots/` のような追加の配信ファイルは増えない
- **公開ページは master の HEAD ではなく、ストアで配信中の版を基準に書く**。`hosted/` は master への push で即デプロイされるが、master に入っている機能が必ずしもストア審査を通っているとは限らない（審査中・申請前のこともある）。実装済み＝公開済みと思い込んで「◯◯に対応しています」「ストアで公開されています」のように書くと、実際にはまだその版がストアに並んでいない利用者に対して、使えない機能や存在しないインストール導線を案内してしまう。更新のたびに、対象の機能・バージョンが実際にストアで配信中かをまず確認してから文面を書くこと
- ストア掲載情報（詳細な説明・スクリーンショット）と `hosted/` の内容を乖離させない

## デプロイ（GitHub Actions による自動デプロイ）

**手動のコピー作業は不要。** `master` の `hosted/**` が変わると
[.github/workflows/deploy-pages.yml](../.github/workflows/deploy-pages.yml) が発火し、`hosted/` の内容を
そのまま GitHub Pages へ公開する。Pages のソースは **「GitHub Actions」**（`build_type: workflow`）。

workflow がやること:

1. `hosted/` を `_site/` へコピーし、開発者向けの `README.md` と `screenshots/.gitkeep` を除く
2. 4 ページ + `style.css` / `lang.js` + スクリーンショット 5 枚がそろっているか確認する（欠けていたら失敗させる）
3. `actions/upload-pages-artifact` → `actions/deploy-pages` で公開する

**通常の更新手順**: 上記「更新時に守ること」を反映して `hosted/` を編集し、PR を `master` へマージする。以上。
内容を変えずに再デプロイしたいときは Actions タブから `deploy-pages` を `workflow_dispatch` で手動実行する。

**Pages ソースの切り替え（一度だけ必要）**: このリポジトリの Pages は当初 legacy（`gh-pages` ブランチ / root）で
有効化されていた。workflow の `actions/configure-pages` に `enablement: true` を渡して `build_type: workflow` への
切り替えも試みているが、切り替わらずに失敗する場合は **Settings → Pages → Build and deployment → Source を
"GitHub Actions" に手で変更して** workflow を再実行する。公開 URL は変わらない
（`https://youkiti.github.io/sr-query-builder-plugin/`。ストアダッシュボードの登録 URL もそのまま有効）。

**スクリーンショットを撮り直したときは、生成物をコミットすること。** `hosted/screenshots/*.png` はリポジトリに
コミット済みで、workflow はそれをコピーするだけ（CI で `npm run shots` は走らせない）。撮り直しは
`npm run shots`（Playwright + stub 環境。実 API を叩かず無人実行）、実 API の応答を見せたいときは
`npm run manual:check -- --shots`（詳細は [docs/manual-testing.md](../docs/manual-testing.md)）。

### 旧方式（`gh-pages` ブランチへの手動 push）— 廃止

2026-08-09 まではこの方式だった。`git worktree` で `gh-pages` 専用ディレクトリを作り、`hosted/` の内容と
空の `.nojekyll` をコピーして push する運用で、**反映漏れが実際に起きた**（操作解説動画の埋め込みを
`index.html` / `help.html` / `style.css` に入れたあと、`gh-pages` への反映だけが残った）。自動化した動機はこれ。

`gh-pages` ブランチは Pages のソースから外れたため配信されない（履歴として残してある）。**手動 push しても
公開内容は変わらない**ので、緊急時も Actions の `workflow_dispatch` を使うこと。

> 旧方式に戻す必要が生じた場合の注意（当時の申し送り）: **作業ツリーを壊す操作
> （`git checkout --orphan` + `git rm -rf .` を今のツリーで実行する等）はしないこと。**
> このリポジトリは submodule を 2 つ持ち、かつ複数セッションが同じ作業ツリーを共有することがあるため、
> 今の作業ツリーの中身を消すコマンドは事故になる。`git worktree` で別ディレクトリを作り、そちらで作業する。
> また旧方式では Jekyll 抑止のため `.nojekyll` をルートに置く必要がある（Actions 方式では不要）。

## デプロイ後の確認項目

PC 幅とスマホ幅の両方で確認する:

- 4 ページ間の相互リンク（ヘッダー nav / フッター / 本文内リンク）がすべて正しい URL を指しているか
- `index.html` のスクリーンショット 5 枚が表示されるか（リンク切れ・404 が無いか）
- 言語切替が機能するか: ヘッダー（index はヒーロー）の切替ボタン／URL に `?lang=en` を付けて開いた場合／言語を切り替えた状態で別ページへ遷移したときに選択が保持されるか（`localStorage`）

## ストアダッシュボードへの反映（実施済み）

GitHub Pages への公開と、その URL のストアダッシュボードへの登録はどちらも完了している。
2026-08-07 の v0.2.0 提出時に、以下 2 欄を入力済み:

- 「プライバシーポリシー URL」欄 = `https://youkiti.github.io/sr-query-builder-plugin/privacy-policy.html`
- 「ウェブサイト」欄 = `https://youkiti.github.io/sr-query-builder-plugin/`

**この 2 つの URL を変えるとき（ページのファイル名変更・独自ドメインへの移行など）は、ダッシュボード側も必ず同時に直すこと。**
プライバシーポリシー URL は審査の必須要件なので、リンク切れのまま更新を提出すると審査で止まる。

提出状況と公開後の残作業は [docs/store/README.md](../docs/store/README.md) を参照。
