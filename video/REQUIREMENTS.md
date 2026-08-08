# 操作解説動画 要件定義書・制作計画

作成日: 2026-08-07
ステータス: **PR0（計画）+ PR1（パイプライン基盤 + スモークシーン 1 本）完了**（2026-08-07）。
PR2 以降（デモビルド層 → 実チャプター 01〜14 → QA/QC → 公開）は未着手。PR1 の達成内容と実測値は §11。

姉妹リポジトリ [sr-data-extraction-plugin/video](https://github.com/youkiti/sr-data-extraction-plugin/tree/master/video)
で実績のある「Playwright 収録 → VOICEVOX で TTS → ffmpeg で合成 → YouTube 手動公開」パイプラインを
本拡張へ移植する。同一著者・MIT ライセンスのため流用可。あちらは
[tiab-review-plugin/video](https://github.com/youkiti/tiab-review-plugin/tree/main/video) からの移植なので、
本件は 3 リポジトリ目の移植になる。

**移植元の初版制作で踏んだ失敗は
[sr-data-extraction-plugin/video/README.md 「制作の勘所（DO / DON'T）」](https://github.com/youkiti/sr-data-extraction-plugin/blob/master/video/README.md)
に全部書いてある。本書 §8（QA/QC 計画）はそれをチェックリスト化したもので、着手前に必ず両方読むこと。**

---

## 1. 背景とゴール

[ヘルプページ](https://youkiti.github.io/sr-query-builder-plugin/help.html) の内容を、実際の画面で
通しで見られる操作解説動画にする。

### ゴール

1. **1 本の動画を YouTube に公開し、各工程ごとに頭出し（チャプター）できる状態**にする
2. **機能追加に応じて随時更新できる状態**にする（該当章だけ再収録 → 再合成）
3. 公開ページ（`hosted/index.html` / `hosted/help.html`）に埋め込み、ストア掲載ページからも到達できるようにする

### スコープ

企画 → デモビルド層 → 収録 → 合成 → **QA/QC** → **YouTube アップロード** → 公開ページ反映 まで。

---

## 2. 確定させる要件

| 項目 | 決定内容 | 理由・補足 |
| --- | --- | --- |
| 制作方式 | **実拡張を `--load-extension` + xvfb で収録**（Playwright） | 操作をシーンスクリプトとしてリポジトリ管理。機能追加時はスクリプト修正 + 再実行で該当章だけ撮り直せる |
| 収録対象ビルド | **デモビルド `dist-demo/`**（`npm run build:demo`） | OAuth・LLM・NCBI・Sheets をすべてモックし、いつ撮っても同じ画面になるようにする（§6） |
| ナレーション | **AI 音声（VOICEVOX・四国めたん ノーマル / 話者 ID 2）** | 原稿をリポジトリ管理し、更新時は該当 cue だけ再生成。クレジット表記（`ナレーション: VOICEVOX:四国めたん`）は必須 |
| 言語 | **日本語ナレーション + 英語字幕（.srt）** | 本拡張の UI は日本語のみ（`_locales` は拡張名・説明のみで、画面の i18n は未実装）。英語話者へは字幕で対応 |
| カバー範囲 | **全機能**（イントロ〜アウトロの全 14 章。§4） | `hosted/help.html` の全セクションに対応させる |
| 動画の長さ | **標準 15〜16 分** | 各機能 40 秒〜2 分半。細部はヘルプページへ誘導 |
| 解像度 / 形式 | 1920×1080 / 30fps / h264 + aac | 移植元と同じ |
| 更新時の公開運用 | **新規公開 + リンク更新**（旧版は非公開化） | YouTube は動画本体を差し替えられない。ユーザーは常にヘルプページ経由で最新版に到達する |
| アップロード方法 | **手動アップロード**（YouTube Studio） | パイプラインは「mp4 + チャプター入り説明文 + 字幕 + サムネイル」までを生成する |

---

## 3. 前提環境（本セッションのコンテナで確認済み）

| 要素 | 状態 | 対応 |
| --- | --- | --- |
| `xvfb-run` | ✅ あり（`/usr/bin/xvfb-run`） | そのまま使える |
| Playwright Chromium | ✅ あり（`/opt/pw-browsers/chromium`） | `setup.sh` はダウンロードをスキップする |
| 日本語フォント | ❌ **無い**（`fc-match -s "sans-serif:lang=ja"` が `wqy-zenhei`＝中国語フォントを返す） | `setup.sh` が Noto Sans JP を `raw.githubusercontent.com` から導入する。**収録前に必ず再確認**（§8-1） |
| ffmpeg / ffprobe | ❌ PATH に無い（Playwright 同梱の `/opt/pw-browsers/ffmpeg-1011` は最小ビルドで不足） | `setup.sh` が BtbN ビルドを `video/tools/` へ展開 → `FFMPEG_PATH` / `FFPROBE_PATH` を明示 |
| VOICEVOX エンジン | ❌ 無い（約 1 GB） | `setup.sh` が取得・起動。`python3` + `py7zr` が必要 |
| `node_modules` | ❌ 無い | `npm ci` |
| ディスク | ✅ 30 GB 空き | 収録一式（VOICEVOX + 素材 + build）で十分 |

**リスク**: ffmpeg / VOICEVOX の配布元は GitHub Releases で、ネットワークポリシー次第では弾かれる
（移植元は同じ理由でフォントを `raw.githubusercontent.com` 経由に変更した経緯がある）。**PR1 の最初の
タスクを「`setup.sh` の疎通確認」にして、ここで詰まるかどうかを真っ先に判定する。**

---

## 4. チャプター構成（案）

`hosted/help.html` のセクション構成に対応させる。各章 = 1 シーンスクリプト = 1 ナレーション原稿 = 1 字幕ソース。

| # | チャプター | 目安 | help.html 対応 | 主な画面 |
| --- | --- | --- | --- | --- |
| 1 | イントロ（何ができるか・SR 3 部作での位置づけ） | 0:40 → **1:00** | 冒頭 | タイトルカード → `?demoSeed=11-export#/home` |
| 2 | 準備（インストール・BYOK の API キー登録） | 1:20 → **1:44** | `#setup` | **`#/settings`**（`options.html` ではない。下記 ⚠️ 参照） |
| 3 | プロジェクトを作る・開く | 1:00 → **1:08** | `#project` | `popup.html`（要ページ拡大）→ **`#/protocol`** |
| 4 | 研究プロトコルを入力する | 1:30 → **1:45** | `#protocol` | `?demoSeed=04-protocol#/protocol` |
| 5 | 検索式ブロックを承認する | 1:20 → **1:21** | `#blocks` | `?demoSeed=05-blocks#/blocks` |
| 6 | シード論文を登録する | 1:10 → **1:19** | `#seeds` | `?demoSeed=06-seeds#/seeds` |
| 7 | 検索式を生成して検証する | 2:00 → **2:13** | `#draft` | `?demoSeed=07-draft#/draft`（生成 → line_hits ライブ表示） |
| 8 | 検証結果を読む（捕捉率・MeSH・行ごとのヒット数） | 1:20 | `#draft` | `#/draft`（検証結果パネル） |
| 9 | 対話的シード拡張（実験的機能） | 1:30 | `#expand` | `#/expand` |
| 10 | 検索式を編集して再検証する | 1:10 | `#edit` | `#/edit` → `#/draft` |
| 11 | 各データベースへ変換・エクスポートする | 1:20 | `#export` | `#/export` |
| 12 | 完了画面と nbib のダウンロード案内 | 0:40 | `#done` | `#/done` |
| 13 | バージョン履歴と設定・困ったときは | 1:00 | `#history` / `#troubleshooting` | `#/history` → `#/settings` |
| 14 | アウトロ | 0:30 | — | エンドカード |

合計目安: **約 15 分 50 秒**（章 01〜07 の実測合計は **10 分 30 秒**。太字は PR3 で TTS 実測に置き換えた値）

> **シーン番号 `00` は `scenes/examples/`（スモークテスト）専用の予約番号**。実チャプターは 01〜14。
> `assemble.mjs` は `00-` 始まりのシーンキーを最終動画から自動除外する。

> ⚠️ **PR3 で判明した実装とのずれ（章 01〜07 ぶんは解消済み）**
>
> 1. **第 2 章の主画面は `options.html` ではなく `app/app.html#/settings`。**
>    `options.html` を開く UI 導線が実装に存在しない（`options_ui` 経由＝ chrome://extensions からしか
>    開けない）。popup の「設定を開く」(`#open-options`) が開くのも `#/settings` で、こちらは
>    `settingsView.ts` の別実装のため ID 体系も別（`#settings-gemini-key` 等。§8-5 も修正済み）。
>    利用者がたどり着けない画面を「これが設定画面です」と説明するのは下記「章立ての注意」3 に反するため、
>    `#/settings` を撮る。
> 2. **第 3 章の着地は `#/home` ではなく `#/protocol`。** `DEFAULT_ROUTE = 'protocol'`（`src/app/router.ts`）
>    なので、作成後に開く `app.html`（ハッシュ無し）は `#/protocol` になる。第 4 章へ自然に繋がるので
>    実装どおりとする。
> 3. **第 6 章に include / exclude / maybe の判定は無い。** `#/seeds` に判定 UI は存在せず、
>    境界事例の判定は `#/expand`（第 9 章）の `button[data-decision]`。第 6 章は
>    「登録・詳細確認・有効無効の切り替え」までで切る。
> 4. **第 3 章は `storageSeed` で Gemini キーを先に入れる必要がある。** `openAppOrRedirect`
>    （`src/popup/bootstrap.ts`）がキー未設定だと `app.html` ではなく `#/settings` へ飛ばすため。
>    `record.mjs` はシーンごとに使い捨てプロファイルを作るので、第 2 章で入れた値は残らない。

### 章立ての注意（移植元の失敗の反映）

- **章の内容を重複させない。** 移植元では「準備」章と「設定」章がどちらも設定画面の話になりかけた。
  本件では **02 = 初回セットアップとして API キーを入れる**、**13 = 履歴・設定画面そのものの機能と
  トラブルシューティング** と役割を分ける。
- **07 と 08 を分ける理由**: `#/draft` は「生成して検証する」1 操作で生成 → line_hits ライブ表示 →
  捕捉率・MeSH 検証まで一気に走る。1 章に詰めると 2 分半を超えて頭出しの粒度が粗くなるため、
  「操作して待つ」（07）と「出てきた結果の読み方」（08）で切る。
- **画面に映らないものを「これが〜です」と説明しない。** デモビルドは OAuth 同意画面を出せないので、
  ログイン手順は「拡張アイコンをクリックすると、**この**プロジェクト選択画面が開きます。初回はここで
  『Google でログイン』を押し…」のように、映っている画面を起点に説明する。
- **未実装機能を映さない・語らない。** `.docx` 取り込みは実装済み（`fflate` ベース）だが、本動画では
  収録スコープを絞る判断として第 4 章は **手入力と `protocol.md` の 2 系統だけ**を扱い、.docx には
  触れない（実装済みだが本動画のスコープ外。未実装機能を語らない、という原則そのものは OpenAI /
  Anthropic 直接連携など他の未実装項目に引き続き適用する）。

---

## 5. パイプライン構成（移植後のディレクトリ）

```
video/
├── REQUIREMENTS.md   本書
├── README.md         使い方 + 制作の勘所（DO / DON'T）        … PR1
├── scenes/           Playwright シーンスクリプト               … PR1（lib + examples）/ PR3・PR4（01〜14）
│   ├── examples/00-smoke.mjs
│   └── lib/          gestures.mjs / pacing.mjs / cursor.mjs / zoom.mjs
├── narration/        ナレーション原稿（日本語・章ごと 1 ファイル）
├── subtitles/        英語字幕ソース（narration と対）
├── assets/           タイトルカード / エンドカード / サムネイル（HTML）
├── scripts/          config.mjs / record.mjs / tts.mjs / assemble.mjs / setup.sh / lib/
├── tools/            ffmpeg・VOICEVOX の実体（git 管理外）
└── build/            生成物（git 管理外）
```

`package.json` に追加するスクリプト（移植元と同名で揃える）:

```
"video:setup"    : bash video/scripts/setup.sh
"video:record"   : node video/scripts/record.mjs
"video:tts"      : node video/scripts/tts.mjs
"video:assemble" : node video/scripts/assemble.mjs
"build:demo"     : webpack --mode development --env demo
```

`.gitignore` に `video/build/` と `video/tools/`、`dist-demo/` を追加する。

### 実行順（この順序は崩さない）

```bash
npm run video:setup                                              # 0. 環境（冪等）
npm run build:demo                                               # 1. 収録対象ビルド → dist-demo/
npm run video:tts                                                # 2. 先に音声（★）
xvfb-run -a -s "-screen 0 1920x1080x24" npm run video:record     # 3. 収録
npm run video:assemble                                           # 4. 合成
```

★ **原稿 → TTS → 収録の順を守る。** `scenes/lib/pacing.mjs` の `loadCueDurations()` は
`video/build/audio/<key>/index.json`（`tts.mjs` の出力）を読んで各 cue の実尺を得る。音声より先に
収録すると、シーン側が待つべき秒数を知らないままナレーションと画面がずれる。

---

## 6. デモビルド層の設計（本件の最大の作業。PR2）

移植元は `src/demo/` に約 3,200 行のデモ層を持ち、`webpack --env demo` で
エントリ差し替え + `resolve.alias` により実依存をモックへ置換して `dist-demo/` を吐く。
本拡張は PDF 描画（pdfjs）が無いぶん小さく、**1,000〜1,300 行**を見込む。

### 6-1. モックする外部依存

| 実依存 | デモ差し替え | 理由 |
| --- | --- | --- |
| `chrome.identity.getAuthToken` / `getProfileUserInfo` | `src/demo/identity.ts` | OAuth 同意画面を出さずログイン済み状態から始める。表示メールは `demo@example.com` |
| Google Sheets / Drive API（`src/lib/google/`） | `src/demo/fetchMock.ts` + `sheetStore.ts`（in-memory + `chrome.storage.local` 永続） | プロジェクト作成・各タブ書き込みが成功する。実アカウントを映さない |
| LLM（`generativelanguage.googleapis.com`） | `src/demo/llmFixtures.ts` | ブロック抽出・ドラフト生成・MeSH 提案・ブロック改善案・境界事例選定の固定応答 |
| NCBI E-utilities（`eutils.ncbi.nlm.nih.gov`） | `src/demo/eutilsMock.ts` | esearch のヒット数、efetch の論文メタデータ。レート制限も待ち時間も無い |

`src/app/bootstrap.ts` は `buildEutilsDeps` / `buildLlmProviderFactory` / `createChromeRuntimeDeps` で
DI されているので、**`globalThis.fetch` レベルのモック 1 枚 + `chrome.identity` スタブ**で足りる見込み
（移植元の `fetchMock.ts` と同じ方式）。エントリだけ `src/demo/{app,popup,options}-entry.ts` に差し替え、
モックを注入してから本物の `app.ts` を import する。

### 6-2. デモデータの正典（`src/demo/paperData.mjs` 相当）

**実在の論文に架空の値を紐づけない**（移植元が一度作ってしまい、公開前に作り直した失敗）。
本拡張は PMID を画面に出すので、より具体的に:

- **架空論文 12 本を自作**し、PMID は現在の PubMed が到達していない番号帯（`90000001`〜）を使う
- **タイトル・抄録・MeSH・PMID・「どのクエリにヒットするか」を 1 つの正典ファイルから生成**する。
  esearch のヒット数（`#/draft` の line_hits）と efetch の中身と捕捉率の計算が、
  **構造的にずれ得ない**ようにする（移植元の「本文と quote を同じ正典から生成する」の本件版）
- デモプロジェクト名に「（デモ・架空データ）」を入れ、画面上でも架空と分かるようにする

### 6-3. デモの筋書き（章をまたいで一貫させる）

E2E フィクスチャと同じテーマを使う（`tests/e2e/fixtures/scenarios/fullState.ts` を土台にできる）。

| 章 | 状態 |
| --- | --- |
| 04 | RQ「成人 ARDS に対する ECMO は生存率を改善するか」を PICO で入力 |
| 05 | ブロック #1 = ARDS / #2 = ECMO / #3 = RCT フィルタ、`#1 AND #2 AND #3` を承認 |
| 06 | シード論文 5 本（PMID 90000001〜90000005）を登録 |
| 07 | 生成 → line_hits が #1/#2/#3 の順に表示され、最終行のヒット数が出る |
| 08 | **捕捉率 80%（5 本中 4 本）**。1 本取りこぼす。MeSH 検証が `"Extracorporeal Membrane Oxygenation"[Mesh]` の追加を提案 |
| 09 | 拡張式の margin から境界事例 3 本を提示 → 1 本を include（`source=interactive`）|
| 10 | 提案語をブロック #2 に追加して保存 → 再検証で **捕捉率 100%** |
| 11 | CENTRAL / Embase(Dialog) / ClinicalTrials.gov / ICTRP へ変換、`.md` を出力 |
| 13 | v1 → v2 の履歴が並ぶ |

**見せたい機能が「成功する」ことを事前に確認する。** 移植元では quote 再配置の実演が「AI でも
見つかりませんでした」で終わっていた（デモの LLM モックがその skill のプロンプトに未対応だった）。
本件で危ないのは **09 の境界事例選定**と **08 のブロック改善案** — どちらも LLM 応答が空だと
「候補がありません」の絵になる。章を書く前に `llmFixtures.ts` が該当 skill に対応しているか確認する。

### 6-4. 章ごとの状態の作り分け

1 つのプロジェクトで全章を撮ると状態が衝突する（12 の完了画面を撮ったあとに 07 の未検証状態は撮れない）。
**章ごとに初期状態を流し込む**方式にする。`record.mjs` はシーンごとに使い捨ての Chrome プロファイルを
作る（`mkdtempSync` → `finally` で削除）ので、章をまたいで状態が漏れることはない。

投入口は 2 つあり、**用途で使い分ける**（PR2 の実装に合わせて PR3 で追記）。

| 方式 | 実体 | 使いどころ |
| --- | --- | --- |
| **`?demoSeed=<name>`**（主） | `src/demo/app-entry.ts` が読み、`applyDemoSeed()` が Sheets/Drive の in-memory バックエンドへ書いて store の初期値にする | アプリの業務状態（プロトコル・ブロック・シード・検索式）。プリセットは `04-protocol` / `05-blocks` / `06-seeds` / `07-draft` / `08-validation` / `09-expand` / `10-edit` / `11-export` / `13-history`（`src/demo/seeds.ts`） |
| **`storageSeed`**（従） | シーンの default export に書くと `record.mjs` が収録前に `chrome.storage.local.set()` する | `chrome.storage` にしか無い設定値。第 3 章の Gemini API キー（未設定だと popup が `#/settings` へリダイレクトする）が唯一の実例 |

章 01 / 02 / 03 に `demoSeed` プリセットは無い。それぞれタイトルカード・設定画面・popup が主画面で、
業務状態を必要としないため（章 01 だけは「完成状態を見せる」意図で `11-export` を流用する）。

あわせて **`?demoLatency=<係数>`** で fetch モックの人工レイテンシ倍率を渡す（`src/demo/fetchMock.ts`）。
モックは in-memory で即答するため、無効のままだと進捗表示やライブ表示が映らないまま静止画になる。
PR3 で実測して決めた章ごとの係数は次のとおり。

| 章 | 係数 | 実測 |
| --- | --- | --- |
| 01 | 0 | fetch は起動時の seed 適用のみ |
| 02 | 8 | プラン判定 ≒ 4.8 秒（「確認中...」が読める） |
| 03 | 2 | 作成 → 新規タブ ≒ 3.6 秒 |
| 04 | 8 | submit → `#/blocks` 6.9 秒（進捗の 2 段階が両方出る） |
| 05 | 3 | 承認時の保存に間を持たせる |
| 06 | 2 | シード 5 件の登録 ≒ 5.8 秒 |
| 07 | 5.4 | 生成 → 検証 ≒ 62 秒（実行中に流れる cue 02〜05 の合計 62.3 秒に合わせた） |

---

## 7. 作業フェーズ（PR 分割）

| PR | 内容 | 主な成果物 | 目安 |
| --- | --- | --- | --- |
| **PR0** | 本書（計画） | `video/REQUIREMENTS.md` | 完了 |
| **PR1** | パイプライン基盤の移植 + スモークシーン | `video/scripts/` `video/scenes/lib/` `video/assets/` `video/README.md`、`package.json` の `video:*`、`.gitignore` | 半日 |
| **PR2** | デモビルド層 | `src/demo/`（1,000〜1,300 行）、`webpack.config.js` の `--env demo`、`build:demo` | 1〜1.5 日 |
| **PR3** | 章 01〜07 のシーン・原稿・字幕 | `scenes/01〜07`, `narration/`, `subtitles/` | 1 日 |
| **PR4** | 章 08〜14 のシーン・原稿・字幕 | `scenes/08〜14`, `narration/`, `subtitles/` | 1 日 |
| **PR5** | 通し収録 → QA/QC → 是正 | 是正コミット（原稿・シーンの微修正）、`video/README.md` に本件固有の勘所を追記 | 0.5〜1 日 |
| **PR6** | 公開ページへの反映 | `hosted/help.html` / `hosted/index.html` に埋め込み、`hosted/style.css` に `.video-frame`、`gh-pages` デプロイ | 半日 |

PR1〜PR4 は `npm test` / `npm run typecheck` / `npm run lint` / `npm run dev` が緑であることを条件にする
（`src/demo/` を追加する PR2 は jest の対象外にするか、カバレッジ設定から除外するかを決めること）。

---

## 8. QA/QC 計画

移植元の初版で実際に踏んだ失敗をチェックリスト化したもの。**どれも「気づかないまま最後まで進む」
種類の失敗**で、見つかるのが遅いほど 16 分ぶんの撮り直し（30〜40 分）に直結する。
各項目は「いつ」「何のコマンドで」確認するかまで固定する。

### 8-1. 収録前（環境）

- [ ] **日本語フォントの確認**。無いと Chromium が中国語フォント（WenQuanYi Zen Hei）で日本語を描画する。
      字形が変わるだけでレイアウトは崩れないので、完成後に見返すまで気づかない。
      **本コンテナは初期状態で未導入であることを確認済み（§3）。毎セッション必ず見る。**
      **フォント本体を入れるだけでは直らない**（本コンテナに元から入っている中国語フォント
      向けの fontconfig alias に順番で負ける）。`npm run video:setup` は総称 `sans-serif` を
      Noto Sans JP に強制する fontconfig alias（`binding="strong"`）の書き出しまで行う
      （詳細・実測の経緯は `video/scripts/setup.sh` ステップ3のコメントと
      [video/README.md](./README.md#制作の勘所do--dont) 参照）。

  **一次スクリーニング**（速いが偽陽性がありうる。下の最終確認とセットで使うこと）:
  ```bash
  fc-match -s "sans-serif:lang=ja" | head -1   # Noto Sans JP が返れば一次チェックは通過
  ```
  これだけでは不十分（実測で確認済み）: fontconfig は `lang=ja` を**実際に描画するテキストの
  文字種からではなく、本コンテナのロケール環境変数（`LANG`/`LC_ALL`）から**補うため、
  この CLI 呼び出しのように明示的に `lang=ja` を指定すれば正しく解決できても、`LANG` が
  未設定な本コンテナで Chromium が実際に発行するフォント問い合わせには `lang=ja` が乗らず、
  中国語フォントのまま描画されることがある（Playwright の `locale: 'ja'` も Blink 側の設定で
  fontconfig には効かない）。

  **最終確認は Chromium の実描画で行う。** CDP の `CSS.getPlatformFontsForNode` で、実際に
  日本語テキストを描画したときの解決フォントを直接見る。`playwright` パッケージの解決に
  リポジトリの `node_modules/` を使うため、**リポジトリルートで実行する**こと（`/tmp` 等では
  `ERR_MODULE_NOT_FOUND` になる）。確認用の一時スクリプトなので、確認後は削除する。
  ```bash
  cat > fontcheck-tmp.mjs <<'EOF'
  import { chromium } from 'playwright';
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const p = await b.newPage();
  await p.setContent(`
    <div id="app" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Hiragino Sans','Yu Gothic UI','Meiryo',sans-serif;font-size:32px">検索式を生成して検証する</div>
  `);
  const cdp = await p.context().newCDPSession(p);
  await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
  const { root } = await cdp.send('DOM.getDocument');
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#app' });
  const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
  console.log(fonts.map((f) => `${f.familyName} (${f.glyphCount} glyphs)`).join(', '));
  await b.close();
  EOF
  node fontcheck-tmp.mjs   # "Noto Sans JP ..." が出れば OK。WenQuanYi 等が出たら fontconfig alias を疑う
  rm fontcheck-tmp.mjs
  ```
  なお `src/styles/` のフォント指定（Hiragino → Noto Sans JP → Yu Gothic UI）は正しく、実機の
  macOS / Windows 利用者には起きない。**収録環境固有の問題なので `src/` は直さない。**
- [ ] ffmpeg / ffprobe が `FFMPEG_PATH` / `FFPROBE_PATH` で解決できる
- [ ] VOICEVOX エンジンが応答する（`curl -sS http://127.0.0.1:50021/version`）
- [ ] `npm run build:demo` が成功し、`dist-demo/` が最新（原稿を書いた時点の画面と一致しているか）

### 8-2. 原稿を書く前・書いた後

- [ ] **デモビルドを起動して実際の画面を見てから書く。** セレクタも実 DOM から取る
- [ ] 隣接章の原稿を読み、内容が重複していない（特に 02 と 13、07 と 08）
- [ ] 画面に映らないものを「これが〜です」と説明していない
- [ ] 未実装機能（OpenAI / Anthropic 直接連携）や本動画のスコープ外機能（`.docx` パース。実装済みだが第 4 章は手入力と `protocol.md` の 2 系統のみ扱う）に触れていない
- [ ] **略語の読みを VOICEVOX に確認させる。** 本拡張は固有語彙が多い —
      **PubMed / MeSH / PICO / PECO / PMID / nbib / CENTRAL / Embase / Dialog / ICTRP /
      ClinicalTrials.gov / tiab / E-utilities / BYOK / SR**
  ```bash
  curl -sS -X POST "http://127.0.0.1:50021/audio_query?speaker=2&text=$(python3 -c "
  import urllib.parse; print(urllib.parse.quote('確認したい文'))")" \
    | python3 -c "import json,sys; q=json.load(sys.stdin); print(''.join(m['text'] for ap in q['accent_phrases'] for m in ap['moras']))"
  ```
      誤読する語は原稿側をカタカナに書き下す（`MeSH` → `メッシュ` 等）。
      実測済みの誤読一覧は [video/README.md](./README.md#制作の勘所do--dont) を参照
- [ ] 英語字幕が日本語ナレーションと同じ内容を言っている（cue 番号の対応も）

### 8-3. 収録直後

- [ ] **「撮り直した」をファイルのタイムスタンプで確認する。** 移植元では再収録したつもりが実際には
      走っておらず、古い映像のまま合成して「直った」と誤認する事故が起きた
  ```bash
  ls -la --time-style=+%H:%M:%S video/build/scenes/*/segment-0.webm
  ```
- [ ] **全 webm の健全性を検査する。** 収録が途中で止まると finalize されず、サイズはあるのに
      再生時間が取れない状態になる（`assemble.mjs` がそこで落ちる）
  ```bash
  for d in video/build/scenes/*/; do
    dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$d/segment-0.webm")
    { [ "$dur" = "N/A" ] || [ -z "$dur" ]; } && echo "❌ 壊れている: $d"
  done
  ```
- [ ] 一過性の収録エラー（`Target.createTarget: Failed to open a new tab`、後片付けの `ENOTEMPTY`）は
      該当章だけ再実行すれば通る。**執拗に全体を撮り直さない**

### 8-4. 合成後（完成品の目視）

- [ ] **章ごとにフレームを切り出して目視する。** 「収録が成功した」と「その章の説明対象が実際に
      映っている」は別物。`timeline.json` に各 cue の絶対時刻がある
  ```bash
  ffmpeg -ss 722 -i video/build/final.mp4 -frames:v 1 /tmp/check.png
  ```
- [ ] 可視カーソルが映っていて、各 cue で「見るべき場所」を指している
- [ ] ナレーションと画面のズレ（各章の冒頭・末尾を重点的に）
- [ ] **長時間の静止画（フリーズフレーム）が無い。** ナレーションが画面操作より長い cue があると、
      `assemble.mjs` が最終フレームを複製して尺を合わせる（`tpad`）ため、「もう終わった操作」を
      喋り続ける絵になる。PR1 のスモークシーンで実際に総尺の 68% が静止画になった
      （収録 18 秒 / 完成 58 秒）。**シーン側で `scenes/lib/pacing.mjs` を使えば起きない**ので、
      起きていたらシーンスクリプトの側を直す（原稿を削るか、操作を足す）。
      検出は「収録尺と完成尺の比較」と「フレームの md5 が連続して一致しないこと」で行う
  ```bash
  # 収録尺と完成尺（乖離が大きいほど静止画が長い）
  ffprobe -v error -show_entries format=duration -of csv=p=0 video/build/scenes/<NN-slug>/segment-0.webm
  ffprobe -v error -show_entries format=duration -of csv=p=0 video/build/final.mp4
  # 3 秒おきに抜いたフレームの md5 が全て異なることを確認する
  for t in $(seq 3 3 60); do ffmpeg -v error -ss $t -i video/build/final.mp4 -frames:v 1 -y /tmp/p$t.png; done
  md5sum /tmp/p*.png | awk '{print $1}' | sort | uniq -d   # 何か出たら静止区間あり
  ```
- [ ] `00-` 始まりのスモークシーンが `final.mp4` に混入していない
- [ ] 総尺・解像度・コーデック（1920×1080 / 30fps / h264 + aac / 15〜16 分）
- [ ] `chapters.txt` が YouTube のチャプター要件を満たす（**最初が `0:00`**・**3 個以上**・**昇順**・
      各チャプター 10 秒以上）
- [ ] `subtitles-en.srt` のタイミングが本編とずれていない

### 8-5. 公開前（映り込みの確認）★ 本拡張固有

- [ ] **API キーが映っていない。** 第 2 章で `#/settings` に API キーを入力する。入力欄は
      `type="password"` でマスクされる（`src/app/views/settingsView.ts` の
      `#settings-gemini-key` / `#settings-openrouter-key` / `#settings-ncbi-key` で確認済み。
      表示切替の目アイコンは無い）が、
      **デモビルドでは実キーではなくダミー文字列を入力し、完成品でもマスクを目視確認する**
- [ ] **実在のメールアドレス・スプレッドシート URL・Drive フォルダが映っていない**
      （デモ層は `demo@example.com` と架空 ID で固定）
- [ ] **実在論文の PMID が映っていない**（架空 PMID `90000001`〜。§6-2）
- [ ] 拡張名の表示（デモビルドは ` (demo)` 付きになる想定）が動画として不自然でないか判断する。
      不自然なら webpack 側でデモビルドのサフィックスを外す
- [ ] 説明文（`description.txt`）に **VOICEVOX クレジット**が入っている

---

## 9. アップロード手順（YouTube）

パイプラインが `video/build/` に出す成果物をそのまま使う。**アップロードと公開設定は手動**。

| 成果物 | 用途 |
| --- | --- |
| `final.mp4` | 本体 |
| `description.txt` | 説明欄（チャプター・リンク・クレジット込み） |
| `chapters.txt` | 説明欄に貼るチャプタータイムスタンプ（`description.txt` に同梱） |
| `subtitles-en.srt` | 英語字幕トラック |
| `thumbnail.png` | サムネイル |

### 手順

1. **YouTube Studio でアップロード**（まず **限定公開** で上げる。公開前レビューのため）
2. タイトル: `SR Query Builder Plugin 操作解説（研究プロトコルから PubMed 検索式を作る）`
3. 説明欄に `description.txt` を貼る。含めるリンク:
   - ヘルプ: `https://youkiti.github.io/sr-query-builder-plugin/help.html`
   - GitHub: `https://github.com/youkiti/sr-query-builder-plugin`
   - Chrome ウェブストア: **v0.2.0 が 2026-08-07 に審査提出済みで URL 未確定**（`docs/store/README.md`）。
     公開前に確定していなければ、この行は落とすか公開後に追記する
   - `ナレーション: VOICEVOX:四国めたん`（必須）
4. 字幕: `subtitles-en.srt` を **English** としてアップロード
5. サムネイル: `thumbnail.png`
6. **限定公開のまま §8-4 / §8-5 のチェックを実機の YouTube 上で再確認**
   （説明欄のタイムスタンプがチャプターとしてリンク化されているか・字幕が出るか）
7. **一般公開**に切り替え、動画 ID を控える

### 公開ページへの反映（PR6）

移植元（`sr-data-extraction-plugin`）と同じ構造をそのまま持ってくる。

- `hosted/help.html` の目次直後に `<section id="video">` を追加し、
  `https://www.youtube-nocookie.com/embed/<動画ID>` を `<iframe loading="lazy">` で埋め込む
  （プライバシー強化モード。ja / en 併記ではなく `lang.js` の切替方式に合わせて両言語分を書く）
- `hosted/index.html` にも同じ埋め込みを置く
- `hosted/style.css` に `.video-frame`（`aspect-ratio: 16 / 9` のレスポンシブ枠）を移植
- `video/README.md` の冒頭に公開 URL を記録する
- `gh-pages` ブランチへ手動デプロイ（`hosted/README.md` の手順）
- **更新時**: YouTube は差し替え不可なので新規公開 → 上記リンクを同じ PR で更新 → 旧版を非公開化

---

## 10. 未決事項

| 項目 | 選択肢 | 決める時期 |
| --- | --- | --- |
| デモビルドの拡張名サフィックス | ` (demo)` を付ける / 付けない（動画映えを優先） | PR2 |
| `src/demo/` を jest カバレッジ対象にするか | 対象外にする / 最小限のテストを書く | PR2 |
| ~~第 2 章で見せる LLM プロバイダ~~ | **決定: Gemini のみ**（PR3）。OpenRouter のカードは画面に映るので 1 文だけ触れ、操作はしない | 決定済み |
| サムネイルの文言・配色 | `hosted/style.css` のトンマナに合わせる | PR4 |
| ストア URL を説明欄に入れるか | 審査結果次第 | 公開直前 |

---

## 11. 受け入れ基準

### PR1（基盤）— 2026-08-07 達成
- [x] `bash video/scripts/setup.sh` が冪等に完走する（既存の ffmpeg / VOICEVOX / フォントを検出してスキップ）
- [x] `xvfb-run -a -s "-screen 0 1920x1080x24" node video/scripts/record.mjs 00-smoke` で
      `video/build/scenes/00-smoke/segment-0.webm` と cue 時刻入り `meta.json` が生成される
- [x] `node video/scripts/tts.mjs 00-smoke` で音声が生成され、2 回目はハッシュ一致でスキップされる
      （実測: 2 回目は「合成 0 件 / 再利用 3 件」）
- [x] `node video/scripts/assemble.mjs --include-examples` が `final.mp4` を出す
      （実測: h264 High + aac 48kHz stereo / 1920×1080 / 30fps / 54.15 秒）。
      **`--include-examples` は PR1 で追加した検証専用のオプトイン**。既定では `00-` 始まりの
      シーンを本編から除外する規約（§4）を維持しており、スモークシーンしか無い PR1 の段階で
      合成まで通すためだけに使う
- [x] 可視カーソルが `final.mp4` に映っている（PNG 切り出しで目視）
- [x] **日本語が中国語フォントで描画されていない**（PNG 切り出しで目視 + CDP による実描画確認。
      §8-1 参照。フォント本体の導入だけでは解決せず、fontconfig alias の書き出しが必要だった）
- [x] **ナレーションと画面がずれていない**（収録 54.12 秒 / 完成 54.15 秒 = 引き伸ばし 0.06%。
      3 秒おきに抜いた 9 フレームの md5 がすべて異なり、静止区間が無いことを確認）
- [x] `typecheck` / `lint` / `test` / `dev` が緑（`test` は Linux 環境で元から落ちている
      `tests/playwright-server.test.ts` の 1 件を除く。下記「既知の失敗」参照）

> **既知の失敗（PR1 と無関係・本作業前から）**: `tests/playwright-server.test.ts` の
> 「rejects traversal into sibling paths that only share the same prefix」は、POSIX が
> バックスラッシュをパス区切りとして扱わないため Linux でのみ失敗する（Windows では通る）。
> 本 PR は `src/` にも `tools/` にも触れていないため対象外とした。

### PR2（デモビルド層）— 2026-08-08 達成
- [x] `npm run build:demo` が `dist-demo/` を出す（manifest の `key` は保持し拡張 ID は
      `bckokafmjighegpjiocopkagghppnjld` のまま。拡張名は `(demo)` サフィックス付き）
- [x] `dist-demo/` を unpacked 読み込みすると、ネットワーク無しで §6-3 の筋書きを人手で通せる
      → 実 Chromium への unpacked 読み込みで自動確認済み。章 08 / 09 / 11 のいずれも
      **JS エラー 0 件・拡張外への通信 0 件**で描画され、`chrome.identity` の差し替えも
      実バインディングに対して機能した（残りは通し操作の目視のみ）
- [x] 実在の PMID・メールアドレス・スプレッドシート ID が画面に出ない
      → PMID は `90000001`〜`90000012` のみ、メールは `demo@example.com`、
      スプレッドシート ID は `demo-sheet-N` 形式
- [x] 09 の境界事例と 08 のブロック改善案が**空にならない**
      → skill 単体ではなく本番 service（`fetchBoundaryCandidates` /
      `requestBlockImprovement`）をデモモック越しに駆動して確認。09 は境界事例 3 本
      （original 4 / broadened 8 / margin 4）、08 は MeSH 追加の具体案が返る

**デモ固有の注意（PR3 以降で踏まないための申し送り）**
- **検索式の version ID は 8 文字以内にすること。** `formatFormulaVersionShort`
  （[src/app/views/formatHelpers.ts](../src/app/views/formatHelpers.ts)）がヘッダーの
  version 表示を 8 文字で切るため、`demo-formula-v1` のような ID にすると
  ほぼ全章のヘッダーに `Formula demo-for` という意味不明な文字列が映り込む
  （実装当初これを踏んだ。現在は `v1-demo` / `v2-demo`）
- **`hydrateCurrentProject` の Sheets エラーは握り潰される。**
  [src/app/bootstrap.ts](../src/app/bootstrap.ts) の `catch {}` により、デモの
  Sheets モックが hydrate 中に投げると**エラー表示が一切出ないまま**プロトコル・
  検索式が復元されない画面（＝一見「壊れているだけ」の絵）になる。章を追加して
  初期表示がおかしいときは、まず devtools コンソールではなくこの経路を疑うこと

### PR3・PR4（章）
- [ ] 各章が収録 → TTS → 合成まで通り、フレーム目視で説明対象が映っている
- [ ] 章間で内容が重複していない

### PR5（QA/QC）
- [ ] §8 のチェックリストを全項目消化し、結果を `video/README.md` に記録する

### PR6（公開）
- [ ] YouTube に一般公開され、説明欄のチャプターが機能している
- [ ] `hosted/help.html` / `hosted/index.html` から動画に到達でき、`gh-pages` に反映済み
