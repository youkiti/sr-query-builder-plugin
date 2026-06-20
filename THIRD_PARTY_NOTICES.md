# サードパーティライセンス表記

本拡張は以下の OSS ライブラリを利用しています。MVP 時点で依存関係に含めるものを列挙します。実際にインストールされた版とライセンスは `package-lock.json` と各パッケージの `LICENSE` ファイルが正となります。

## ランタイム依存

| ライブラリ | ライセンス | 用途 |
|---|---|---|
| [uuid](https://github.com/uuidjs/uuid) | MIT | UUID v4 発番（`project_id` 等） |
| [fflate](https://github.com/101arrowz/fflate) | MIT | `.docx`（zip）の展開と本文プレーンテキスト化 |

## 開発依存

| ライブラリ | ライセンス | 用途 |
|---|---|---|
| [TypeScript](https://github.com/microsoft/TypeScript) | Apache-2.0 | 言語処理系 |
| [webpack](https://github.com/webpack/webpack) | MIT | バンドラ |
| [ts-loader](https://github.com/TypeStrong/ts-loader) | MIT | webpack loader |
| [copy-webpack-plugin](https://github.com/webpack-contrib/copy-webpack-plugin) | MIT | 静的ファイル転写 |
| [dotenv](https://github.com/motdotla/dotenv) | BSD-2-Clause | `.env` 読み込み |
| [jest](https://github.com/jestjs/jest) | MIT | テストランナー |
| [ts-jest](https://github.com/kulshekhar/ts-jest) | MIT | TS を jest で実行 |
| [jest-environment-jsdom](https://github.com/jsdom/jsdom) | MIT | jest 用 DOM 環境 |
| [eslint](https://github.com/eslint/eslint) | MIT | Lint |
| [@typescript-eslint](https://github.com/typescript-eslint/typescript-eslint) | BSD-2-Clause | TS 向け ESLint プラグイン |
| [prettier](https://github.com/prettier/prettier) | MIT | フォーマッタ |
| [@types/chrome](https://github.com/DefinitelyTyped/DefinitelyTyped) | MIT | Chrome 拡張 API 型定義 |
| [@types/jest](https://github.com/DefinitelyTyped/DefinitelyTyped) | MIT | jest 型定義 |
| [@types/uuid](https://github.com/DefinitelyTyped/DefinitelyTyped) | MIT | uuid 型定義 |

## 将来追加予定（MVP 実装で追加するもの）

| ライブラリ | ライセンス | 用途 |
|---|---|---|
| [zod](https://github.com/colinhacks/zod) | MIT | ランタイムバリデータ |
| [mermaid](https://github.com/mermaid-js/mermaid) | MIT | MeSH 階層ダイアグラム描画 |
| [@codemirror/\*](https://github.com/codemirror/dev) | MIT | マークダウンエディタ |
| [jsep](https://github.com/EricSmekens/jsep) | MIT | 結合式パーサ |

実際にインストール済みのバージョンとライセンス条文は `node_modules/<pkg>/LICENSE` を参照してください。
