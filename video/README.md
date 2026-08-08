# 操作解説動画 制作パイプライン

SR Query Builder Plugin の操作解説動画（YouTube 公開用）を、Playwright による自動収録 +
VOICEVOX による自動音声合成 + ffmpeg による自動合成で作るためのパイプライン。
姉妹リポジトリ [sr-data-extraction-plugin/video](https://github.com/youkiti/sr-data-extraction-plugin/tree/master/video)
からの移植（同一著者・MIT ライセンス）で、あちらは
[tiab-review-plugin/video](https://github.com/youkiti/tiab-review-plugin/tree/main/video) からの
移植だったため、本件は3リポジトリ目の移植になる。本拡張固有の適応点は
[REQUIREMENTS.md §5](./REQUIREMENTS.md#5-パイプライン構成移植後のディレクトリ) を参照。

> **現状**: PR1（パイプライン基盤 + スモークシーン1本）・PR2（デモビルド層 `dist-demo/`）・
> PR3（章 **01〜07**）・PR4（章 **08〜14**）・PR5（QA/QC）まで完了。**全 14 章がそろい、
> `final.mp4` は 20 分 01 秒**。残るのは YouTube 公開（PR6）だけ。
> QA の実施結果は下の「[QA/QC 実施記録](#qaqc-実施記録)」。
>
> `npm run video:assemble`（引数無し・`--include-examples` 無し）で `final.mp4` まで通る。
> 章ごとの初期状態は `?demoSeed=`、進捗表示を映すための人工レイテンシは `?demoLatency=`
> で渡す（REQUIREMENTS.md §6-4 に係数の実測表がある）。
>
> **第 10 章は AI 改善提案を扱っていない**（issue #39 の不具合で提案が表示されないため）。
> 解決したら追加収録して章を差し替えること。
>
> 動画を作り直す・章を追加する前に、必ず下の「制作の勘所（DO / DON'T）」の節を読むこと。
> 移植元（sr-data-extraction-plugin。そのまた移植元は tiab-review-plugin）の制作過程で
> 実際に踏まれた失敗（日本語が中華フォントで描画される・撮り直したつもりが撮れていない・
> webm が壊れたまま合成される 等）と、その確認コマンドをまとめてある。どれも気づかないまま
> 最後まで進んでしまう種類の失敗で、本編収録後に見つかるほど撮り直しの手戻りが大きい。

## ディレクトリ構成

```
video/
├── REQUIREMENTS.md    要件定義書・制作計画（正典。PR 分割・QA/QC チェックリストはこちら）
├── README.md          本書
├── scenes/            Playwright シーンスクリプト（video/scripts/record.mjs が読み込む）
│   ├── examples/       スモーク / デモ確認用シーン（シーン番号 00。record.mjs の一括収録対象外）
│   └── lib/            共通ヘルパー（gestures.mjs / pacing.mjs / cursor.mjs / zoom.mjs）
├── narration/          ナレーション原稿（日本語、チャプターごとに1ファイル）
├── subtitles/          英語字幕ソース（narration と対になるチャプターごとに1ファイル）
├── assets/             タイトルカード・エンドカード・サムネイルテンプレート等の静的素材
├── scripts/            パイプライン本体（Node.js ESM, .mjs）
│   ├── config.mjs       共通設定（パス・解像度・VOICEVOX/ffmpeg 接続先・収録対象拡張ディレクトリの解決 等）
│   ├── record.mjs       収録（シーン → video/build/scenes/<NN-slug>/）
│   ├── tts.mjs           音声合成（原稿 → video/build/audio/<NN-slug>/）
│   ├── assemble.mjs      合成（build/ 一式 → 最終動画・チャプター・字幕・説明文・サムネイル）
│   ├── setup.sh          環境セットアップ（冪等）
│   └── lib/              パーサ・ffmpeg ラッパー等の共通ユーティリティ
├── tools/              ffmpeg / VOICEVOX の実体（git 管理外。setup.sh が展開）
└── build/              生成物（git 管理外。.gitignore 済み）
```

## 前提環境

- Node.js 18 以上（`package.json` の `engines` 参照）
- Linux + [xvfb](https://www.x.org/releases/X11R7.6/doc/man/man1/Xvfb.1.xhtml)（拡張機能を読み込んだ Chromium
  をヘッド付きで動かして収録するため。収録コマンドは常に `xvfb-run` 経由で実行する）
- Python3 + [py7zr](https://pypi.org/project/py7zr/)（`pip install py7zr`）
  （VOICEVOX エンジンの配布形式が 7z のため、`video/scripts/setup.sh` の展開に使用）
- 日本語フォント（Noto Sans JP 等）。無いと fontconfig が中国語フォントにフォールバックし、
  収録した動画の日本語が中華フォントで描画されてしまう。フォント本体を入れるだけでは
  直らず、総称 `sans-serif` を Noto Sans JP に強制する fontconfig alias が別途必要
  （下記「収録を始める前」参照）。`npm run video:setup` が両方まとめて面倒を見る
- ネットワーク到達性（初回セットアップ時のみ。Playwright の Chromium、ffmpeg、VOICEVOX
  エンジン、日本語フォントをダウンロードする）
- 収録対象の拡張機能ビルド。**現時点（PR1）ではデモビルド層が無いため `npm run dev` の
  `dist/`**（プロジェクト未選択状態）を使う。デモビルド `dist-demo/`（`npm run build:demo`）は
  後続 PR（REQUIREMENTS.md の PR2）で追加予定で、追加され次第 `resolveExtensionDir()` が
  自動的にそちらを優先する（後述「収録対象ディレクトリ」参照）

## 使い方（基本の流れ）

デモビルド層の追加後（PR2 以降）を見込んだ、パイプラインの完成形の実行順は以下の通り
（`video/REQUIREMENTS.md §5` の実行順）。**この順序は崩さない**（★の理由は後述）。

```bash
# 0. 環境セットアップ（セッションごとに必要。冪等なので再実行しても安全）
npm run video:setup

# 1. 収録対象ビルド。現時点（PR1）はデモビルドが無いため npm run dev を使う
#    （PR2 でデモビルド層が追加されたら npm run build:demo に置き換わる）
npm run dev

# 2. ナレーション音声合成（VOICEVOX エンジンが起動していること）★ 収録より先に行う
npm run video:tts

# 3. シーン収録（Playwright + xvfb）
xvfb-run -a -s "-screen 0 1920x1080x24" npm run video:record

# 4. 最終合成（動画結合・チャプター・字幕・説明文・サムネイル生成）
npm run video:assemble
```

★ **原稿 → TTS → 収録の順を守る。** `scenes/lib/pacing.mjs` の `loadCueDurations()` は
`video/build/audio/<key>/index.json`（`tts.mjs` の出力）を読んで各 cue の実尺を得る。音声より
先に収録すると、シーン側が待つべき秒数を知らないままナレーションと画面がずれる。

章 01〜07 が揃った現在は、引数無しの通常運用がそのまま使える。

```bash
npm run video:tts                                                        # narration/ 全部
xvfb-run -a -s "-screen 0 1920x1080x24" node video/scripts/record.mjs    # scenes/ 直下全部
npm run video:assemble
```

1 章だけ撮り直すときは番号を渡す（`record.mjs 07` のように、`NN` でも `NN-slug` でも一致する）。
原稿を変えた章は `tts.mjs` も同じキーで回してから収録し直すこと。

```bash
npm run video:tts -- 07-draft
xvfb-run -a -s "-screen 0 1920x1080x24" node video/scripts/record.mjs 07
npm run video:assemble
```

`assemble.mjs` は `00-` 始まりのシーン（examples/ 用の予約番号。後述）を**既定では**最終動画から
除外する。実チャプターが 1 本も無い状態で `npm run video:assemble` を実行すると
「本編シーンがありません」で意図的に停止する。

**実チャプターを撮らずにパイプライン全体（収録 → TTS → 合成）が通ることだけを検証したいときは**、
`--include-examples` を明示的に渡す。この場合だけ `00-` シーンも合成対象に含まれ、その旨が
ログに出る（黙って本編扱いにはしない）。

```bash
node video/scripts/assemble.mjs --include-examples
```

このオプションは検証用の抜け道であり、実チャプターが揃った後の通常運用（`npm run
video:assemble`）では使わない（既定の「`00-` は本編から除外」という挙動そのものは変えていない）。

### 収録対象の拡張ディレクトリ（`EXT_DIST_DIR`）

`scripts/config.mjs` の `resolveExtensionDir()` が、以下の優先順位で収録対象ディレクトリを
解決する（tiab-review-plugin の `dist-demo/` 固定からの適応点で、sr-data-extraction-plugin
から本拡張へもそのまま踏襲している。詳細は [REQUIREMENTS.md §5](./REQUIREMENTS.md)）。

1. 環境変数 `EXT_DIST_DIR`（明示指定。存在しなければエラー）
2. `<repo>/dist-demo`（`npm run build:demo` の出力。PR2 で追加予定。存在すればこちらが
   優先される）
3. `<repo>/dist`（`npm run dev` / `npm run build` の出力。現時点ではこちらを使う）

いずれも見つからない場合は `npm run dev` の実行を促すエラーで落ちる。

### ffmpeg / ffprobe の実行ファイル指定

`video/scripts/setup.sh` が `video/tools/` 配下に展開した場合、`config.mjs` は
**環境変数 → PATH 上のコマンド** の順でしか自動解決しないため、`video/tools/` に置いた
バイナリを使うときは明示的に環境変数を指定する（`setup.sh` 実行時にも案内が表示される）。

```bash
export FFMPEG_PATH="$(pwd)/video/tools/ffmpeg-master-latest-linux64-gpl/bin/ffmpeg"
export FFPROBE_PATH="$(pwd)/video/tools/ffmpeg-master-latest-linux64-gpl/bin/ffprobe"
```

### Playwright の Chromium 実行ファイル指定

既定では `/opt/pw-browsers/chromium` があればそれを使い、無ければ Playwright 標準の解決
（開発機で `npx playwright install chromium` 実行後に使われるパス）にフォールバックする。
別の場所を明示したい場合は `PLAYWRIGHT_CHROMIUM_PATH` を設定する。

### VOICEVOX エンジンの接続先

既定は `http://127.0.0.1:50021`、話者は四国めたん（ノーマル・話者ID 2）。変更する場合は
`VOICEVOX_URL` / `VOICEVOX_SPEAKER` を環境変数で指定する。

## 制作の勘所（DO / DON'T）

移植元 sr-data-extraction-plugin（初版 v0.6.0 / 全14章。そのまた移植元は
tiab-review-plugin）の制作過程で実際に踏まれた失敗と、その対処をそのまま引き継いだもの。
**本拡張で新しい章を書く・撮り直す前に、まずここを読むこと。** どれも「気づかないまま最後まで
進んでしまう」種類の失敗で、10数分ぶんの撮り直しに直結する。

### 収録を始める前

- **DO: 日本語フォントが入っているか確認する。** 収録用コンテナに日本語フォントが無いと、
  Chromium は中国語フォント（WenQuanYi Zen Hei = 文泉驛正黑）で日本語を描画する。字形が
  中国語になるだけでレイアウトは崩れないため、**完成後に見返すまで気づかない**。移植元では
  全14章を撮り終えてから発覚し、丸ごと撮り直した経緯がある。

  **注意（本拡張で実測して判明した落とし穴）**: Noto Sans JP を「導入するだけ」（フォント
  ファイルを置くだけ）では直らない。本コンテナには元から中国語フォント（WenQuanYi Zen
  Hei）を総称 `sans-serif` の第一候補にする fontconfig ルールが入っており、Noto Sans JP を
  後から入れても素朴な alias 設定では順番負けする。`npm run video:setup` は
  フォント本体の導入に加えて **fontconfig alias（`binding="strong"` の
  `family=sans-serif` 上書き）を書き出すところまで**を自動で行うので、通常は
  このコマンドを実行するだけでよい。詳しい原因は `video/scripts/setup.sh` の
  ステップ 3 のコメントを参照（`fc-match -s "sans-serif:lang=ja"` は正しく解決できても
  実際の Chromium 描画では直っていない、というズレも実測で踏んだので合わせて記載している）。

  ```bash
  fc-match -s "sans-serif:lang=ja" | head -1   # Noto Sans JP が返れば OK
  ```

  なお `src/styles/tokens.css` の `--font-family-sans`（`-apple-system, BlinkMacSystemFont,
  "Segoe UI", "Hiragino Sans", "Yu Gothic UI", "Meiryo", sans-serif`）は正しく、実機の
  macOS / Windows 利用者には起きない。Linux の収録環境では Hiragino Sans / Yu Gothic UI /
  Meiryo のいずれも存在せず末尾の総称 `sans-serif` まで落ちるため、fontconfig の
  `sans-serif` 解決先が日本語フォントかどうかがそのまま描画結果を左右する
  （**収録環境固有の問題なので `src/` は直さない**）。

- **DO: 原稿 → TTS → 収録の順を守る。** `scenes/lib/pacing.mjs` の `loadCueDurations()` は
  `video/build/audio/<key>/index.json`（`tts.mjs` の出力）を読んで各 cue の実尺を得ている。
  音声を作る前に収録すると、シーン側が待つべき秒数を知らないままナレーションと画面がずれる。

- **DO: 原稿を書く前に実際の画面を見る。** 収録対象ビルド（現状は `dist/`、PR2 以降は
  `dist-demo/`）を起動してスクリーンショットを撮り、何が表示されるかを確認してから書く。
  セレクタも実 DOM から取る（推測で書かない）。

### 原稿の書き方

- **DON'T: 画面に映らないものを「これが〜です」と説明しない。** 現状の `dist/` は OAuth
  同意画面を出せない（プロジェクト未選択状態のまま）ため、ログイン手順の説明は避け、
  **映っている画面を起点に**説明する。映っていない画面を指して断定すると視聴者が混乱する。

- **DON'T: 章の内容を重複させない。** REQUIREMENTS.md §4 の章立てでは、02（準備・初回
  セットアップで API キーを入れる）と 13（バージョン履歴・設定画面そのものの機能と
  トラブルシューティング）の役割を分けている。新しい章を書く前に、隣接する章の原稿を
  読むこと。

- **DO: 略語の読みを VOICEVOX に確認させる。** 本拡張は固有語彙が多い（PubMed / MeSH /
  PICO / PMID / nbib / CENTRAL / Embase / Dialog / ICTRP / ClinicalTrials.gov / tiab /
  E-utilities / BYOK / SR 等）。不安な語は確認する。

  ```bash
  curl -sS -X POST "http://127.0.0.1:50021/audio_query?speaker=2&text=$(python3 -c "
  import urllib.parse; print(urllib.parse.quote('確認したい文'))")" \
    | python3 -c "import json,sys; q=json.load(sys.stdin); print(''.join(m['text'] for ap in q['accent_phrases'] for m in ap['moras']))"
  ```

  誤読する語は原稿側をカタカナに書き下す（例: `MeSH` → `メッシュ`）。

  **実測済みの誤読一覧**（話者2 = 四国めたん ノーマル。次の PR で同じ調査を繰り返さないための記録）:

  | 語 | VOICEVOX の読み | 対処 |
  | --- | --- | --- |
  | Plugin（製品名の一部） | プルウジン | 「プラグイン」と書き下す |
  | PICO | ピイアイシイオオ | 「ピコ」と書き下す |
  | CENTRAL | シイイイエヌティイアアルエエエル（1 文字ずつ） | 「セントラル」と書き下す |
  | nbib | ニブ | 「エヌビブ」と書き下す |
  | **ECMO** | **イイシイエムオオ** | **「エクモ」と書き下す**（PR3 で追加） |
  | **efetch** | **エフェッチ** | **「イーフェッチ」と書き下す**（PR3 で追加） |
  | **Sheets** | **シイツ**（寝具の「シーツ」と同音） | **「Google スプレッドシート」と書き下す**（PR3 で追加） |
  | Embase | エンベイス | 許容範囲（「エンベース」推奨） |
  | PubMed | パブメド | そのままでよい |
  | MeSH / MeSH 階層 | メッシュ / メッシュカイソオ | そのままでよい |
  | PMID | ピイエムアイディイ | そのままでよい |
  | tiab | タイアブ | そのままでよい |
  | ICTRP | アイシイティイアアルピイ | そのままでよい |
  | BYOK | ビイワイオオケエ | そのままでよい |
  | SR | エスアアル | そのままでよい |
  | ARDS | エエアアルディイエス | そのままでよい（PR3 で確認） |
  | esearch | イイサアチ | そのままでよい（PR3 で確認） |
  | OAuth | オオオオス | そのままでよい（PR3 で確認） |
  | Gemini / Drive | ジェミニ / ドライブ | そのままでよい（PR3 で確認） |
  | NCBI | エヌシイビイアイ | そのままでよい（PR3 で確認） |
  | 検索式 / 捕捉率 / シード論文 | ケンサクシキ / ホソクリツ / シイドロンブン | そのままでよい |
  | 結合式 / 組入基準 / 除外基準 | ケツゴオシキ / クミイレキジュン / ジョガイキジュン | そのままでよい（PR3 で確認） |

  「SR Query Builder Plugin」のような製品名の英語表記全体も上記の Plugin の誤読を含むため、
  ナレーションでは「エスアール・クエリビルダー・プラグイン」のようにカタカナで書き下す
  （`video/narration/00-smoke.md` cue 01 で実施済み）。

### デモデータの設計（`src/demo/`。PR2 以降）

- **DON'T: 実在の論文に架空の値を紐づけない。** 移植元では実在論文のタイトルと DOI を
  出しつつ本文や抽出値は創作、という状態を一度作ってしまった。本拡張は検索式ドラフトの
  シード論文として PMID を画面に出すため、**架空論文を自作し、現在の PubMed が到達しない
  番号帯（`90000001`〜）の PMID を使う**（REQUIREMENTS.md §6-2）。タイトル・抄録・MeSH・
  「どのクエリにヒットするか」を1つの正典ファイルから生成し、esearch のヒット数と efetch の
  中身と捕捉率の計算が構造的にずれ得ないようにする。

- **DO: 見せたい機能が「成功する」ことを確認する。** 移植元ではある機能の実演が
  「AI でも見つかりませんでした」で終わっていた（デモの LLM モックが対応するプロンプトに
  未対応だったため）。**機能が失敗する絵をチュートリアルに載せない。** 本拡張で特に注意が
  必要なのは対話的シード拡張（境界事例選定）とブロック改善案（REQUIREMENTS.md §6-3）。

- **DON'T: デモのブロック判定を「プロンプト全体」で行わない。** PR3 で踏んだ失敗。
  `mesh-suggester` / `freeword-designer` のユーザープロンプトは末尾に seed の MeSH 一覧や
  ti/ab コーパスを丸ごと含むため、`detectBlockKey` をテキスト全体に掛けると seed 側の語を拾う。
  デモの seed は ARDS/ECMO の論文なので、**ECMO ブロックにも RCT ブロックにも ARDS の
  フリーワードが返り、3 ブロックがほぼ同じ検索式になっていた** — 第 7 章の中心となる絵が
  壊れていたのに、収録した映像を目視するまで気づけなかった。判定はブロック自身の記述に絞る
  （`src/demo/llmFixtures.ts` の `extractBlockScope`）。

- **DO: デモのフィクスチャは seed 込みでテストする。** 上の不具合を既存テストが素通りしたのは、
  `seedMesh` / `seedSamples` を空で渡していたためだった。**他ブロックのキーワードを含む
  現実的な seed コーパスを渡す回帰テストを書く**（`src/demo/llmFixtures.test.ts` の
  「seed 側の語に引きずられない」）。空の入力しか試さないテストは、この種の取り違えを検出できない。

- **DO: 原稿を書く前に、その機能を実際に押して動くことを確かめる。** PR4 で第 10 章の
  「AI に改善させる」を実演しようとしたところ、**提案もエラーも出ずに黙って何も起きない**
  ことが分かった（issue #39。LLM コスト更新による全ビュー再描画で、提案の描画先 DOM が
  破棄される）。jest のフィクスチャテストは緑で、静的にコードを読んでも気づけない類の
  不具合だった。**画面を開くだけでなく、章で押すつもりのボタンを実際に押すこと。**
  同時に「その機能を実演できないなら章の構成を変える」判断もこの段階でやる
  （第 10 章は手動編集だけに絞り、AI 改善は #39 解決後に追加収録する方針にした）。
  新しい機能を章に入れるときは、`src/demo/llmFixtures.ts` がその skill に対応しているか
  先に見る。

### シーンスクリプト

- **DO: 幅の狭い画面は `applyPageZoom` で拡大する。** `popup/popup.html` は 320px 固定幅なので、
  1920x1080 では画面の約 85% が空白になり文字が読めない。`scenes/lib/zoom.mjs` を使う。

- **DON'T: 拡大に `transform: scale` を使わない。** `zoom` はレイアウトに影響するプロパティなので
  `locator.boundingBox()` が拡大後の座標を返し、`gestures.mjs` のホバー計算がそのまま動く。
  `transform: scale` だと座標がずれる。

- **注意: 可視カーソルは `<html>` 直下にマウントしてある**（`scenes/lib/cursor.mjs`）。`body` に
  `zoom` を掛けると、`position: fixed` のカーソルの `translate` 量まで倍率がかかって描画位置が
  ずれるため（実測 clientX 約 950 → 描画 約 1730 = ちょうど 1.8 倍）。マウント先を変えないこと。

- **DO: マウス移動を伴う操作を各 cue に入れる。** ホバーが無いと視聴者はどこを見ればよいか
  分からない。`gestures.mjs` の `hoverSlow` / `hoverSequence` / `smoothWheel` を使う。

- **注意: `zoom` はナビゲーションのたびにリセットされる。** `openExtensionPage()` や `goto()` の
  **直後に毎回** `applyPageZoom` を呼び直すこと。自動での再適用はしない（`scenes/lib/zoom.mjs`）。

- **DO: 新しいタブへ移るときは `ctx.newSegment(page)` を使う。** `ctx.openExtensionPage()` は
  現ページを `goto` するだけで**新しいタブを作らない**。popup の「作成」のように
  `chrome.tabs.create` が走る導線を追うには、`ctx.page.context().waitForEvent('page')` で
  新規ページを拾って `newSegment` に渡す（第 3 章 `03-project.mjs` が実例。segment-0 = popup /
  segment-1 = メインビュー の 2 本になる）。

- **DO: `chrome.storage` にしか無い前提条件は `storageSeed` で入れる。** `record.mjs` は
  シーンごとに使い捨てのプロファイルを作るので、前の章で入れた設定は残らない。
  第 3 章は Gemini API キーが未設定だと popup が `app.html` ではなく `#/settings` へ
  リダイレクトしてしまい、章の筋書きが成立しない（`openAppOrRedirect`。実測で確認済み）。
  アプリの業務状態のほうは `?demoSeed=` で入れる（使い分けは REQUIREMENTS.md §6-4）。

- **DO: モックが即答する画面には `?demoLatency=` で人工的な待ちを入れる。** デモ層の fetch は
  in-memory で即答するため、そのままだと進捗インジケータもライブ表示も**映らないまま静止画**になる。
  何倍にすべきかは章ごとに実測して決める（REQUIREMENTS.md §6-4 の表）。とくに
  **実行中にナレーションが流れる章は、実行時間をその cue の合計尺に合わせる**こと
  （第 7 章は cue 02〜05 の合計 62.3 秒に対して係数 5.4）。ずれると「生成中です」と
  言っているのに画面は終わっている、という絵になる。

- **DO: 実行時間の係数は「録画を回した状態」で測る。** PR3 で踏んだ失敗。素の Playwright で
  測って係数を決めたところ、収録時は 1920×1080 の録画ぶんの CPU 負荷が乗って倍近く遅くなり、
  ナレーションが終わったあとに 70 秒の無音が残った。録画ありで測り直すこと
  （第 7 章は録画ありで係数 2.4 → 29.9 秒 / 3.4 → 39.8 秒。傾き ≒ 9.9 秒／係数 1）。

- **DON'T: 実行中にしか出ない要素を素の `hoverSlow` でなぞらない。** 実行が終わって DOM から
  消えると `scrollIntoViewIfNeeded` → `locator.hover()` の既定 30 秒タイムアウトで詰まり、
  1 つの cue が 90 秒スタックした（PR3 で実測）。`isVisible()` で存在を確かめてから
  ホバーするヘルパーを噛ませる（`video/scenes/07-draft.mjs` の `hoverIfVisible`）。
  待ちが残るときも `waitFor` で固まらず、カーソルを動かしながら待つ（静止画区間を作らない）。

- **DON'T: 人工レイテンシを収録前の準備にまで効かせない。** PR3 で踏んだ失敗。
  `?demoLatency=` を**モジュール読み込み時**に立てたところ、`applyDemoSeed()` が
  プリセットを Sheets/Drive モックへ書き込む数十回の fetch にも倍率がかかり、
  **章の冒頭に無音の待ちが生まれた**（実測: 第 7 章 14.9 秒 / 第 4 章 13.9 秒。
  cue 01 の発火時刻が異常に遅いことで気づいた）。seed の投入は演出ではなく準備なので、
  倍率は `applyDemoSeed()` の**あと**に立てる（`src/demo/app-entry.ts`）。
  修正後は 0.2〜1.4 秒。**収録ログの `cue 01 @ ... t=` が 1 秒前後に収まっているかを
  毎回確認すること。** 大きければ、待たせるべきでないものを待たせている。

### 収録・合成

- **DO: 「撮り直した」を必ずファイルのタイムスタンプで確認する。** 移植元では再収録したつもりが
  実際には走っておらず、古い映像のまま合成して「直った」と誤認する事故が起きた。総尺が
  ミリ秒まで一致していたら再収録されていない疑いが濃い。

  ```bash
  ls -la --time-style=+%H:%M:%S video/build/scenes/*/segment-0.webm
  ```

- **DO: 合成の前に全 webm の健全性を検査する。** 収録プロセスが途中で止まると webm が
  finalize されず、ファイルサイズはあるのに `ffprobe` が再生時間を返さない状態になる
  （`assemble.mjs` がそのシーンで失敗する）。該当章だけ撮り直せばよい。

  ```bash
  for d in video/build/scenes/*/; do
    dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$d/segment-0.webm")
    [ "$dur" = "N/A" ] || [ -z "$dur" ] && echo "❌ 壊れている: $d"
  done
  ```

- **DO: 一過性の収録エラーはリトライする。** `Target.createTarget: Failed to open a new tab`
  （Chromium 起動直後）や、一時プロファイル削除の `ENOTEMPTY` が稀に出る。`record.mjs` は
  シーン単位で自動リトライし、後片付けの失敗では異常終了しないようにしてあるが、それでも
  落ちた場合は該当章だけ再実行すれば通る。

- **注意: シーン番号 `00` は `scenes/examples/` 予約。** `assemble.mjs` が `00-` 始まりを最終動画から
  自動除外する（除外時はログに出る）。`video/build/` は git 管理外で毎回消えるとは限らないため、
  過去のスモーク収録が残っていても本編に混入しない。

- **DO: 1 章だけ直したいときは該当章だけ収録し直す。** `assemble.mjs` は毎回 `video/build/` 全体から
  作り直すので、`record.mjs 09` → `assemble.mjs` で済む。原稿を変えた章は `tts.mjs 09-verify` も回す
  （本文ハッシュが一致する cue は自動でスキップされる）。

### 完成後

- **DO: 章ごとにフレームを切り出して目視確認する。** 「収録が成功した」と「その章の説明対象が
  実際に映っている」は別物。`timeline.json` に各 cue の絶対時刻が入っているので、確認したい
  cue の時刻でフレームを抜く。

  ```bash
  ffmpeg -ss 722 -i video/build/final.mp4 -frames:v 1 /tmp/check.png
  ```

- **注意: 完成品はチャプター数に比例したサイズになる（移植元は16分で約50MB）。** 30 MB 制限の
  ある経路で受け渡すときは、再エンコードせず（`-c copy`）チャプター境界で分割する。画質を
  落とすと 1080p の文字が読めなくなる。

  ```bash
  ffmpeg -i final.mp4 -t 531 -c copy part1.mp4
  ffmpeg -ss 531 -i final.mp4 -c copy part2.mp4
  # 結合: printf "file 'part1.mp4'\nfile 'part2.mp4'\n" > parts.txt
  #       ffmpeg -f concat -safe 0 -i parts.txt -c copy final.mp4
  ```

- **DO: cue ごとの無音を機械計測してから合成する。** 「収録が成功した」と「喋りと画が繋がっている」
  も別物。待ち受けが `.catch(() => {})` 付きでタイムアウトすると、**収録は成功扱いのまま無音だけが
  伸びる**（PR4 で章 10 に 50.7 秒の無音が入った）。目視では見つけにくいので必ず測る。
  **複数セグメントのシーンでは `tRel` がセグメント内相対時刻なので、`assemble.mjs` と同じ
  切り詰めロジック（非最終セグメントは次セグメント開始までの実時間で切る）で測ること。**
  単一タイムラインとして測ると、章 03 が実際は 5.2 秒なのに「54 秒の無音」に見える。

QA/QC チェックリスト（収録前〜公開前まで、いつ・何のコマンドで確認するか）は
[REQUIREMENTS.md §8](./REQUIREMENTS.md#8-qaqc-計画) にまとめてあるので、ここでは重複して書かない。

## QA/QC 実施記録

### 2026-08-08 全 14 章（PR5）

`final.mp4` **20 分 01 秒 / 1920×1080 / 30fps / h264 + aac**。§8 の全項目を消化した。

| 群 | 結果 |
|---|---|
| 8-1 環境 | フォントは CDP の `CSS.getPlatformFontsForNode` で **Noto Sans JP** を確認（中国語フォントではない）。ffmpeg / ffprobe / VOICEVOX / `dist-demo` の鮮度（src に新しいものなし）も確認 |
| 8-2 原稿 | 未実装・スコープ外機能への言及なし。章間の重複を是正（下記）。誤読 2 件を是正（下記）。全 14 章で字幕と本文の cue が一致 |
| 8-3 収録物 | 全 webm 健全。撮り直しをタイムスタンプで確認 |
| 8-4 完成品 | 3 秒おき **400 フレームすべて md5 相異**（静止画なし）。章内の無音は最大 5.2 秒。チャプター 14 本（0:00 開始・昇順・最短間隔 40 秒）。字幕 207 件に重なり・総尺超過なし。スモークシーンの混入なし |
| 8-5 映り込み | API キーはマスク（伏せ字）を目視確認。メールは `demo@example.com` のみ、PMID は `90000001`〜 の架空値のみ、スプレッドシート / Drive の識別子は合成値（`src/demo/` を機械検査）。拡張名は接尾辞なしの `SR Query Builder Plugin`。バッジは 3 素材とも **QB / `#54B7D1`** で `src/icons/icon128.png` と一致。説明文に VOICEVOX クレジットあり、本文も全 14 章の実収録範囲と一致 |

**QA で見つけて直したもの**

1. **VOICEVOX の誤読 2 件**。`maybe` → 「メイベ」、`Embase` → 「エンベイス」。それぞれ
   「メイビー」「エムベース」へ書き下し、`ClinicalTrials.gov` も
   「クリニカルトライアルズ・ドット・ガブ」に改めた（章 09・11 を再収録）。
   なお `i、e、m` は句が分かれて正しく読まれるので、そのままでよい
   （`/audio_query` の kana を連結表示すると `アイイイエム` に見えるが、
   実際には句間に 0.6 秒の無音が入る。**連結表示だけで誤読と判定しないこと**）。
2. **章 07 と 08 の重複**。どちらも「極端に少なければ〜という当たりが付く」と同じ解釈を述べていた。
   08 は「AND で掛け合わせたときの落ち込み」に着目する内容へ差し替えた（章 08 を再収録）。

**判断して現状維持にしたもの**

- **章 02 の課金バッジが「有料プラン」表示**。ナレーションは「無料プランだった場合は」と
  条件形で述べるだけで、画面と矛盾しない。無料プラン側にすると自動切替でモデルが
  `Gemini 2.0 Flash` になり、原稿の「既定は Gemini 3.5 Flash」と食い違うため、現状が自己整合的。

## シーンを1本だけ再収録する

機能追加時などにチャプター1本だけを更新したい場合、対象シーンの `video/scenes/NN-slug.mjs`
（と、必要なら `video/narration/NN-slug.md` / `video/subtitles/NN-slug.md`）だけを編集し、
以下のように収録対象を絞って再実行する。

```bash
xvfb-run -a -s "-screen 0 1920x1080x24" \
  node video/scripts/record.mjs 05-blocks

npm run video:tts -- 05-blocks            # 原稿を変更した場合のみ（未変更のcueは自動でスキップされる）
npm run video:assemble                    # 常に build/ 全体から再生成する
```

引数はシーンファイルのフルネーム（`05-blocks`）でも、番号部分（`05`）だけでも一致する。
引数を省略すると `video/scenes/` 直下（`examples/` は除く）・`video/narration/` 配下の
全ファイルが対象になる。

`tts.mjs` は原稿本文と話者IDのハッシュを `video/build/audio/<key>/index.json` に保存しており、
変更の無い cue は再生成をスキップする。`assemble.mjs` は毎回 `video/build/` 全体から作り直す
（各シーン mp4・最終 mp4・チャプター・字幕・説明文・サムネイルをすべて再生成する）。

## 可視マウスカーソル（tiab-review-plugin/video には無い新機能）

`scenes/lib/cursor.mjs` が、収録対象の全ページに擬似カーソル DOM 要素（矢印）を注入し、
`mousemove` に追従・クリック時にリップルアニメーションを表示する。`record.mjs` が
`browserContext` 生成直後に自動で組み込むため、シーンスクリプト側での追加配線は不要。
詳細（拡張ページの CSP に引っかからない理由等）は `cursor.mjs` 冒頭のコメントを参照。

## ナレーション原稿・字幕・シーンスクリプトの対応関係（CONTRACT）

1チャプター = 1シーンスクリプト（`video/scenes/NN-slug.mjs`）+ 1ナレーション原稿
（`video/narration/NN-slug.md`）+ 1英語字幕ソース（`video/subtitles/NN-slug.md`）が基本単位。
`NN` はチャプター番号（2桁ゼロ埋め）、`slug` はシーン名。

### ナレーション原稿の形式（`video/narration/NN-slug.md`）

```markdown
---
scene: "NN"
slug: slug-name
title: チャプタータイトル      # chapters.txt・description.txt に使われる
target_seconds: 90            # 目安秒数（パイプラインは参照のみ、強制はしない）
---

## cue 01
<!-- action: 画面操作の補足メモ（TTSには渡らない。HTMLコメントは自動で除去される） -->
実際にTTSで読み上げる本文。複数行に分けて書いても、合成時は半角スペースで
1つの発話として結合される。

## cue 02
...
```

### 英語字幕ソースの形式（`video/subtitles/NN-slug.md`）

ナレーション原稿と同じ `## cue NN` 形式。`title` 等の frontmatter は無くてもよい。
cue 番号（`n`）はナレーション原稿・シーンスクリプトの `ctx.cue(n)` と対応させる。

### シーンスクリプトの CONTRACT（`video/scenes/NN-slug.mjs`）

CONTRACT の全文と ctx API の詳細は `video/scripts/record.mjs` の先頭コメントに記載している
（実装時はそちらを一次情報として参照すること）。要点:

- `export default { id, slug, title, narration?, storageSeed?, async run(ctx) {...} }`
- `narration`（省略可）: 使用するナレーション原稿・字幕ソースのキー。省略時は `${id}-${slug}`。
  ナレーション無し（映像のみ）のシーンにしたい場合は `narration: null` を指定する。
- `storageSeed`（省略可）: 収録前に `chrome.storage.local` へ流し込む初期状態。ログイン画面を
  スキップしたい場合等に使う（デモビルド層が追加される後続 PR で本格的に使う想定。
  PR1 のスモークシーンはプロジェクト未選択状態のまま撮るため未使用）。
- `run(ctx)` の中で `ctx.openExtensionPage('app/app.html#/home')` のように拡張内ページを開き
  （本リポジトリ固有の適応点。tiab-review-plugin の `pageQuery` 方式は使わない）、
  `ctx.cue(n)` を呼んだタイミングが、そのナレーション cue の発声開始時刻の目安として
  記録される。`ctx.newSegment(page)` を呼ぶと、以後の `ctx.page`/`ctx.cue()`/`ctx.openExtensionPage()`
  は新しいタブを基準に切り替わる。

サンプル: [`video/scenes/examples/00-smoke.mjs`](./scenes/examples/00-smoke.mjs)（スモークテスト用。
専用の原稿 `narration/00-smoke.md` / `subtitles/00-smoke.md` で収録→TTS→合成の一連のパイプラインを
音声付きで最後まで通す）。`video/scenes/` 直下ではなく `examples/` サブディレクトリに置いているのは、
`record.mjs` のシーン列挙が拡張子 `.mjs` のファイルのみを対象とし、サブディレクトリを無視するため
（`npm run video:record` を引数無しで実行してもスモークテストは収録対象に含まれない）。
実際のチャプター01〜14のシーンは後続 PR で `video/scenes/NN-slug.mjs` として追加される
（このファイルを土台にしてよい）。

**シーン番号 `00` は examples/（スモークテスト等）専用の予約番号**であり、実チャプターには使わない
（実チャプターは 01〜14。REQUIREMENTS.md §4 参照）。`assemble.mjs` は `video/build/scenes/` 配下の
`00-` 始まりのシーンキーを最終動画の対象から自動的に除外する（`video/build/` は git 管理外で
毎回消えるとは限らないため、過去のスモーク収録が残っていても `final.mp4` に紛れ込まない）。

## タイミング精度についての注意

- `ctx.cue(n)` が記録するのは「その瞬間の壁時計時刻」を、アクティブなセグメント（ページ）が
  作られた瞬間からの相対秒数に変換した値。sub秒（1秒未満）オーダーの誤差が生じうる。
- `assemble.mjs` は各キューの音声を「その cue の想定発声時刻」と「直前の cue 音声終了 +
  最短間隔（`MIN_CUE_GAP_SEC` = 0.3秒）」の遅い方に配置するため、多少のタイミングのズレは
  自然に吸収される（早口で操作してもナレーションが重ならない）。
- ナレーション音声の合計がシーン映像より長くなった場合は、映像の最終フレームを複製して
  引き伸ばす（`tpad`）。逆に映像がナレーションより長い場合は、映像の自然な尺がそのまま使われる。

## 生成物一覧（`video/build/`, git 管理外）

| パス | 内容 |
| --- | --- |
| `scenes/<NN-slug>/segment-K.webm` | 収録した生の映像セグメント（`record.mjs`） |
| `scenes/<NN-slug>/meta.json` | セグメント・キュー時刻等のメタデータ（`record.mjs`） |
| `audio/<NN-slug>/cue-NN.wav` | 合成したナレーション音声（`tts.mjs`） |
| `audio/<NN-slug>/index.json` | cue ごとの音声メタ・再合成スキップ用ハッシュ（`tts.mjs`） |
| `scenes/<NN-slug>.mp4` | シーン単体の完成動画（映像+ナレーション、`assemble.mjs`） |
| `final.mp4` | 全シーンを結合した最終動画（`assemble.mjs`） |
| `chapters.txt` | YouTube 説明欄に貼るチャプタータイムスタンプ |
| `timeline.json` | シーンごとの尺・cue 配置時刻の記録 |
| `subtitles-en.srt` | 英語字幕（YouTube の字幕トラックとしてアップロード） |
| `description.txt` | YouTube 説明欄用テキスト（チャプター・リンク・クレジット込み） |
| `thumbnail.png` | サムネイル（`video/assets/thumbnail.html` を撮影） |

これらはすべて `video/build/` から再生成可能なため git 管理しない
（`.gitignore` の `video/build/` / `video/tools/` を参照）。

## 移植の系譜と本拡張固有の適応点

`tiab-review-plugin/video` → `sr-data-extraction-plugin/video` → 本リポジトリ（3リポジトリ目）
という順で移植されている。移植時の設計判断・変更点は
[REQUIREMENTS.md §5](./REQUIREMENTS.md#5-パイプライン構成移植後のディレクトリ) にまとめている。要点:

1. 収録対象ディレクトリの解決（`resolveExtensionDir()`。デモビルド層が無い間は `dist/` を使う）
2. 拡張のページ構成の違い（`ctx.openExtensionPage()`。app/popup/options の複数ページ構成）
3. 可視マウスカーソル（`scenes/lib/cursor.mjs`。配色は本拡張の公開ページ（青系）に合わせて調整）
4. ffmpeg / VOICEVOX の取得元は移植元と同一（`setup.sh` は冪等）
5. 説明文・カード類のリンク・配色を本拡張向けに差し替え（Chrome ウェブストアの掲載 URL は
   審査中で未確定のため、確定するまで説明欄・エンドカードから行ごと省略している）
6. スモークシーンはデモビルド前提にせず、素の `dist/`（プロジェクト未選択状態）で撮れる内容にした
