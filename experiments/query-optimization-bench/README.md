# 検索式自動調整のケース評価

完成した Cochrane レビューの適格基準から C0 を生成し、既知シード 3 群を与えた自動調整後の C1 と比較する Node ハーネスです。目的はハーネスの弱点を見つける形成的評価です。評価の根拠は [評価計画](../../docs/query-optimization-bench-plan.md) を参照してください。

## 前提と出典

Node 18 以上、既存の開発依存（tsx / dotenv）が必要です。Chrome・Sheets は使用しません。`efetchArticles`（seeded 版の C0 凍結と、`eval:optimize` の確認負荷集計で使用）はブラウザの DOMParser に依存するため、`freezeC0.ts` と `run.ts`（dry-run 以外）は起動時に jsdom の DOMParser を補います（`domParser.ts`）。
入力の既定ディレクトリは `C:\Users\youki\codes\Cochrane-bench`。`COCHRANE_BENCH_DIR` で変更できます。

fixtures の出典は [Cochrane-bench](https://github.com/youkiti/Cochrane-bench) の cc-by データです。各レビューの本文抜粋は CC BY ライセンスで、タイトルと PMCID を各 fixture に保持しています。

| ケース | 原レビュー | ライセンス | 検索日 |
|---|---|---|---|
| r1-mindfulness-smoking | [PMC9009295](https://pmc.ncbi.nlm.nih.gov/articles/PMC9009295/) | CC BY | 2021-04-15 |
| r2-pdr-prognostic | [PMC9943918](https://pmc.ncbi.nlm.nih.gov/articles/PMC9943918/) | CC BY | 2022-05-27 |
| r3-vascular-bleeding | [PMC9936832](https://pmc.ncbi.nlm.nih.gov/articles/PMC9936832/) | CC BY | 2022-03-31 |

## 準備と実行

リポジトリルートから実行します。

```powershell
npm run eval:prepare
npm run eval:optimize -- --dry-run
# 以下は実 API を呼び、費用が発生する実行です。
npm run eval:optimize -- --case r1-mindfulness-smoking
npm run eval:optimize
npm run eval:report
```

`eval:prepare` はローカルファイルだけを読みます。protocol.md は title・objectives・eligibility の指定 4 項目だけで組み立て、検索方法・検索式・結果節を入力しません。fixtures は版管理対象、results は無視対象です。

実行時だけルート `.env` を dotenv で読みます。`GEMINI_API_KEY` が必須、`NCBI_API_KEY` は任意です。キーをコマンドラインへ書かないでください。モデルは GeminiProvider の既定値を使用し、実際のモデル ID と各呼び出し設定を保存します。条件は `types.ts` に定義した `PROFILES` から `--profile <id>` で選びます。未指定は `default`（maxHits=2,000。アプリ既定 `DEFAULT_OPTIMIZATION_MAX_HITS` と同値、maxIterations=5）、追加条件は `tight-1000`（maxHits=1,000、maxIterations=5）です。1 プロセスでケースを逐次実行してください。NCBI の共有レート制御はキー無しで 3 req/s です。

dry-run は環境ファイルも API も使わず、全 fixture・サービスの import・provider と checkpoint の配線を確認します。LLM 出力を使う処理の実行確認ではありません。実行結果を上書きせず、完了マーカーも作りません。Jest はモックとローカル fixture のみを使います。

2026-09-12 の初期生成への目安件数の追加以降、両プロファイルの `maxHits` は C1 の調整ループに加え、C0（初期式生成）にも上限ではなく目安として渡ります。それ以前の結果では C1 にのみ効いているため、過去の結果との比較ではこの条件差に注意してください。**ただし C0 を `--c0` で凍結 fixture から読む場合は、C0 生成時の目安件数は常に `DEFAULT_OPTIMIZATION_MAX_HITS`（2,000）で固定され、実行時の `--profile`/`--max-hits` には依存しません**（後述）。

`tight-1000` は default の結果を見てから追加した事後探索（post-hoc）の条件です。事前に定めた `default` とは解釈の強さが異なり、確認的な結果として同等には扱えません。`--max-hits <n>` を渡すと、その場で `custom-<n>` という事後探索プロファイルを発行できます（`--profile` と同時指定は不可。maxIterations は default と同じ 5）。

```powershell
npm run eval:optimize -- --profile tight-1000
npm run eval:optimize -- --max-hits 500
```

## 凍結 C0 とシード分割

凍結前に各ブロック（結合行を除く）と式全体を厳密件数モードで実測し、構文エラー（実在しない MeSH 見出しによる phrase not found 等）を含む例外があれば、失敗箇所と原因をまとめて報告して凍結しない。0 件は凍結を妨げず、恒久エラーによる再生成には `--draft` で別番号を指定する。一時的な通信障害が混ざる場合は同じ番号で再試行できる。

C0（初期式生成）は毎回 LLM で作り直すため、実測 hits が実行間で数倍ぶれることがある。**再生成された C0 どうしの差を自動調整ポリシーの効果として解釈してはいけない**。この揺れを切り離すため、C0 を一度生成してハッシュ付きで凍結し、複数回の `eval:optimize` で使い回せるようにしてある。

```powershell
# criteria-only: 適格基準だけから C0 を作る（従来の C0 と同じ入力）
npm run eval:freeze-c0 -- --case r1-mindfulness-smoking --variant criteria-only
# seeded: 凍結シード（既定分割）のタイトル・抄録・MeSH も渡して C0 を作る
npm run eval:freeze-c0 -- --case r1-mindfulness-smoking --variant seeded
# dry-run も出力先の既存ファイルと衝突すれば止まる（draft1 はコミット済みなので別番号で確認する）
npm run eval:freeze-c0 -- --dry-run --case r1-mindfulness-smoking --variant seeded --draft 2
```

- 出力は `fixtures/<case>/c0/<variant>-draft<n>.json`（既定シード分割のときは接尾辞なし。既定以外の分割だけ `-<splitId>` を付ける。例: `seeded-draft1-s42.json`）。`--draft <n>`（既定 1）で同じ条件の複数ドラフトを別ファイルに残せる
- 既存ファイルは上書きしない（`wx`）。`--dry-run` でも出力先に既存ファイルがあれば停止する。作り直したいときは手動で削除してから再実行する
- 内容には `caseId` / `variant` / `draftIndex` / `seedSplit`（seeded は既定分割でも `s20260912` を記録する。ファイル名の接尾辞省略とは別の話） / `targetHits`（常に 2,000）/ `model` / `gitCommit` / `gitDirty` / 生成した `protocol` / `blocks` / `formula` / `formulaMd` / `seedContext` を保持し、これらから計算した `sha256` を同梱する
- seeded で凍結シードの一部を efetch で取得できなければ（NCBI 側の一時的な欠落等）、空の `seedContext` にフォールバックせず失敗させる。「seeded を名乗るが実質シード無しの C0」を静かに凍結しない
- criteria-only の凍結・取り込みではシードファイルを読み込まず、`--seeds` の同時指定は意味が無いため拒否する
- `--seeds <int>` は分割の乱数そのもの。数値は `^(0|[1-9]\d*)$` に一致する 10 進の非負整数で、`Number.isSafeInteger` を満たすものだけを受け付ける（先頭ゼロ・符号・空白・16 進・指数・小数表記は不可）。ファイル内の `seed` が要求値と食い違っていれば（手動編集・コピー間違い等）実行前に拒否する
- LLM のプロンプト・レスポンス全文は評価計画 §6 のとおり `results/freeze-c0/<caseId>/<出力ファイル名>/llm/` に保存する（run.ts の実行と同じ `loggedFactory` を再利用。`results/` は gitignore 対象）。ハッシュ対象の内容にはログパスを含めない
- `eval:optimize -- --c0 <name>`（`fixtures/<case>/c0/<name>.json` の拡張子抜きファイル名）を渡すと、その run は `extractProtocol` / `generateDraftFormula` を呼ばず、凍結内容をそのまま C0 として使う。ケース ID 不一致・ハッシュ不一致（改ざん・破損）・シード分割の不一致は実行前に拒否する

```powershell
npm run eval:optimize -- --case r1-mindfulness-smoking --c0 seeded-draft1
```

シード分割（既知シード 3 群の選び方）も複数用意できる。既定分割は `fixtures/<id>/seeds.json`（乱数 20260912、id `s20260912`）で、これは変えない。

```powershell
npm run eval:prepare -- --seed 42          # fixtures/<id>/seeds-42.json を追加で凍結（上書きしない）
npm run eval:optimize -- --seeds 42        # そのケースの分割で実行（held-out は実行時にその分割から再計算する）
npm run eval:freeze-c0 -- --case r1-mindfulness-smoking --variant seeded --seeds 42
```

結果ディレクトリは `results/<profileId>/<caseId>/<c0Key>/<splitKey>/run.json`（`c0Key` は `--c0` の名前、無指定なら `live`。`splitKey` は分割 id、既定 `s20260912`）で、その下に従来どおり試行単位の `<runId>/` を残す。同じキーで完了済み（`status: 'completed'` かつ `maxHits` も一致）なら、`gitCommit` が厳密一致する場合（両方 null を含む）だけ再実行時にスキップする。別コミットならそのケースをエラーにして他ケースへ進み、既存の完了結果は書き換えない。`eval:candidates`（却下候補の事後計測）も同じ `--case` / `--profile` / `--max-hits` / `--c0` / `--seeds` / `--label` を受け取り、`run.ts` と同じキーで `run.json` を探す。

`--label <name>` は任意で 1 回だけ指定でき、英数字・`.`・`_`・`-` の 1〜40 文字（`^[A-Za-z0-9._-]{1,40}$`）に限る。ラベルを付けると保存先は `results/<profileId>/<caseId>/<c0Key>/<splitKey>+<label>/run.json` となる。ラベル無しは従来の `<splitKey>/run.json` のまま。ラベルは子ディレクトリにせず分割名に連結するため、ラベル無し結果と併存しても report が両方を読む。`RunResult.label` にも記録し、dry-run は `label=` を表示する。**`replay-` で始まるラベル（大文字小文字を区別しない）は指定できない**（後述の `--replay` の保存先接尾辞と同じ形になり、自由生成と replay run が同じキーへ保存されてしまうため）。

現行版と改善版は、同じ凍結 C0・同じシード分割・同じ上限条件で、別コミットにそれぞれラベルを付けて実行する。以下は同じチェックアウトで、各コード版に切り替えた後に実行する例（凍結 fixture は同一内容を保持する）。

```powershell
# 現行版のコミットで実行
npm run eval:optimize -- --case r1-mindfulness-smoking --c0 seeded-draft1 --seeds 20260912 --label baseline
# 改善版のコミットへ切り替えた後に実行
npm run eval:optimize -- --case r1-mindfulness-smoking --c0 seeded-draft1 --seeds 20260912 --label candidate
npm run eval:compare -- results/default/r1-mindfulness-smoking/seeded-draft1/s20260912+baseline/run.json results/default/r1-mindfulness-smoking/seeded-draft1/s20260912+candidate/run.json
```

**比較できるのは、凍結 C0（`--c0`）と `eval:compare` に対応したハーネスを含むコミットどうしに限る。** それより前のコミットの自動調整ポリシー（削除影響の検査などが入る前のもの）は、同じ凍結 C0 では測れない。上の例には `--label` 対応も必要。別コミットの完了結果が同じキーにあるとき、`--label` 無しの再実行はエラーになる。同じラベルを別コミットで使い回した場合もエラーであり、上書き・スキップはしない。

`eval:compare` は、両方が凍結 C0（sha256 付き）であり、その sha256・ケース・シード分割・`maxHits`・`maxIterations` が一致する場合だけ比較する。不一致なら拒否する。表には `label`・`model`・`gitDirty`・`postHoc`（欠落は「欠測」）を表示する。モデルが違う場合は拒否せず、表の直後に「⚠ モデルが異なるため、差にはモデルの違いが混ざる」、どちらかの `gitDirty` が true なら「⚠ 作業ツリーが汚れた状態の run を含む」を表示する。

`CASES` の各ケースには `role`（`development` | `confirmation`）を付けてある。現行 3 件はすべて `development`（ハーネスの弱点発見用）。`confirmation` ケースの追加は別途、事前登録した選定基準で行う（このチャンクでは追加しない）。

## 名前付きシード集合

特定の PMID を除くなど、手動で選んだ集合は `fixtures/<case>/seeds-<name>.json` に置きます。既存の `seeds.json` は変更しません。名前は `^[a-z][a-z0-9-]{0,31}$`（英小文字で始まる英小文字・数字・ハイフンの 1〜32 文字）に限り、負の整数を含む乱数分割 id と区別するため `^s-?\d+$`（例: `s20260912`、`s-42`）は使えません。

ファイルは次の形式です。`groupId` と `pmid` は対象ケースの `case.json` の `gold` から、異なる 3 群について各 1 PMID を選びます。以下の仮の値を置き換え、出版年が不明なら `year` は `null` とします。除外したい PMID を `selections` に含めないようにします。

```json
{
  "name": "without-one",
  "selections": [
    { "groupId": "群 A の id", "pmid": "群 A の PMID", "year": null },
    { "groupId": "群 B の id", "pmid": "群 B の PMID", "year": null },
    { "groupId": "群 C の id", "pmid": "群 C の PMID", "year": null }
  ]
}
```

`name` は要求した名前と一致させ、乱数分割用の `seed` フィールドは入れません。取り違え・群構造の不一致は実行前に拒否します。`eval:prepare` に名前付き集合の生成機能はありません。整数指定のファイル名・形式・既定分割は従来どおりです。

```powershell
npm run eval:freeze-c0 -- --case r2-pdr-prognostic --variant seeded --seeds without-one --draft 2
npm run eval:optimize -- --case r2-pdr-prognostic --seeds without-one --c0 seeded-draft2-without-one --dry-run
npm run eval:candidates -- --case r2-pdr-prognostic --seeds without-one --c0 seeded-draft2-without-one --dry-run
```

この例の分割 id は `without-one` そのものです。C0 の `seedSplit`、`run.json` の `seedSplit`、結果パス `results/default/r2-pdr-prognostic/seeded-draft2-without-one/without-one/run.json` に同じ値が入ります。

## 手元の検索式を凍結 C0 に取り込む

`eval:import-c0` は `search_formula.md` 形式（`## PubMed/MEDLINE` セクション内にコードブロックと `#N` 行）を既存パーサで読み込みます。式の生成は行わず、`protocol` と `blocks` は通常の凍結と同じ `extractProtocol` の LLM 呼び出しで作ります。取り込んだ非結合ブロック数と抽出した `blocks.blocks` の数が一致しなければ停止します。

非結合ブロックの ID は出現順に `1, 2, ..., N` である必要があり、不一致なら dry-run を含め LLM 呼び出し・API キー確認前に停止します。結合行は途中や末尾に置けます。
本実行で表示する `#N ⇔ 抽出ラベル ⇔ 式の先頭` の対応表を目視で確認してください。ラベルと式の意味の対応は自動では検証していないため、最適化へ進む前に取り違えがないことを確認します。

```powershell
npm run eval:import-c0 -- --case r2-pdr-prognostic --variant criteria-only --formula ./search_formula.md --draft 2 --dry-run
# 本実行には Gemini / NCBI への通信が必要
npm run eval:import-c0 -- --case r2-pdr-prognostic --variant criteria-only --formula ./search_formula.md --draft 2
npm run eval:import-c0 -- --case r2-pdr-prognostic --variant seeded --formula ./search_formula.md --seeds without-one --draft 2
```

`--draft` は既定 1、seeded の `--seeds` は上記の 10 進の非負整数・名前付き集合の両方に対応します。seeded は通常の凍結と共通の efetch → シード文脈構築を使い、部分欠落でも停止します。凍結前の非結合ブロックごと＋式全体の ESearch（`retmax: 0`、構文エラー時は停止）も共通です。

出力名・ハッシュ・上書き禁止（`wx`）・LLM ログ保存先は `eval:freeze-c0` と同じです。生成済みファイルがある場合は別の `--draft` 番号を指定してください。由来として `source: "import"` と `sourceFilename`（元ファイルのベース名）をハッシュ対象に含めます。これらは取り込み時だけ追加する任意フィールドで、既存 C0 に補完しません。従来の凍結ファイルのハッシュは変わらず、取り込んだ C0 も `eval:optimize -- --c0 <拡張子なしの名前>` で読めます。

`--dry-run` は通信・書き込みをせず、式のパースと参照展開、seeded のシード検証、出力先を表示します。LLM 抽出とのブロック数照合・NCBI の実測は本実行まで未検証です。

## 初期式エラーの頻度評価（issue #132）

初期式の生成時に MeSH 辞書で同義語を正式な見出しへ解決し、引用符付きのタグを組み立てます。存在しない見出しは式から外し、照会失敗時は候補を残します。置き換えは試行ファイルの `replacedMeshHeadings` に保存し、`--report` の「置き換えた見出し」列で完了試行の合計件数を表示します。試行ファイルの `removedMeshHeadings` に除外した見出しを保存し、`--report` の「外した見出し」列で完了試行の合計語数を表示します。

`eval:draft-frequency` は生成失敗も分母に含めて、初期検索式の失敗頻度を測る独立バッチです。実測できない C0 を拒否する凍結結果だけでは、失敗した生成が分母から落ちます。各条件の `<variant>-draft1` をハッシュ検証して読み、protocol・blocks・seedContext を固定して `generateDraftFormula` だけを呼び直します。criteria-only のシード文脈は空、seeded は凍結内容を使用し、目安件数は常に 2,000 です。プロトコル抽出の揺れは測りません。

```powershell
npm run eval:draft-frequency -- --dry-run --trials 5
npm run eval:draft-frequency -- --trials 5 --label baseline
npm run eval:draft-frequency -- --trials 5 --label baseline --case r2-pdr-prognostic --variant seeded
npm run eval:draft-frequency -- --report --label baseline
npm run eval:draft-frequency -- --relookup --label baseline --case r2-pdr-prognostic --variant criteria-only
```

`--trials` は生成実行・dry-run では正の整数で必須です。`--case` を省略すると全3ケース、`--variant criteria-only|seeded` を省略すると両方を選びます。`--label` は既存コマンドと同じ英数字・`.`・`_`・`-` の1〜40文字で、`replay-` 接頭辞は禁止です。独立ディレクトリとして使うため `.` と `..` も拒否します。省略名は `default` です。`--report` は通信せず集計だけを行い、`--trials` / `--dry-run` との併用は拒否します。ケース・variant 指定による集計の絞り込みも可能です。

初回本実行で `results/draft-frequency/<label>/plan.json` に試行数、ケース×variant、C0 の名前と sha256、作成日時、コミットを固定します。再開時は同じ試行数、plan の部分集合の条件、同じ C0 ハッシュだけを許可します。実行後に結果を見て回数を変える場合は別ラベルが必要です。

生成後は各非結合ブロック（フィルタを含む）と展開した式全体を、日付制限した厳密な ESearch（retmax=0）で診断します。生成途中の `generationBlockHits` は保存だけで頻度には使いません。

- 生成例外は `generation_failed`。LLM の429・500以上と fetch 自体の失敗は `generation_transient`。
- 診断は1件以上が `ok`、0件が `zero`、恒久 EutilsError で「構文エラー:」から始まるものが `syntax_error`、非恒久 EutilsError または通信例外が `network_error`、その他が `other_error`。
- 試行の結論は `generation_transient` → `generation_failed` → `network_error` → `syntax_error` → `other_error` → `zero` → `ok` の優先順です。
- phrase not found の語が対象式で MeSH タグ付きなら、共有レート制御・バックオフを通して MeSH 辞書を照会します。タグ付き／タグ無しの返答、NoExp、サブヘディングに対応します。辞書0件が `unresolved`、1件が `resolved`、2件以上が `ambiguous`、例外が `lookup_failed`、対象式で MeSH 付きでなければ `not_mesh` です。phrase not found だけで MeSH 不存在とは断定しません。同一試行内の同じ返答語・照会語は重複照会しません。MeSH 照会応答に `ERROR` または1件以上の `errorlist.fieldsnotfound` があれば恒久的な `lookup_failed` とし、それらがなく `errorlist.phrasesnotfound` が1件以上なら `count` の欠落も含め0件（`unresolved`）として扱います。それ以外の `errorlist`（空を含む）は無視して `count` を検証し、欠落・不正なら `lookup_failed` とします。

条件・試行は逐次実行し、1試行ずつ `<case>/<variant>/trial-<k>.json` を一時ファイルと rename で保存します。`generation_transient` / `network_error` は `complete: false` で再試行待ち、それ以外は完了です。再開では完了分をスキップし、未完了分の旧内容を `trial-<k>.history.jsonl` に追記してから再実行します。ログは `trial-<k>/llm/` と `trial-<k>/progress.jsonl` に残し、再試行の LLM ログも保持します。ファイル名の接頭辞は `a<n>-` で、n は `trial-<k>.history.jsonl` の行数 + 1 と、`trial-<k>/llm/` の既存ファイルの `a<n>-` 接頭辞にある最大の n + 1 の大きい方です（履歴・該当ログがなければ各候補は 1）。接頭辞の n は 1 以上の10進整数だけを読み、それ以外の名前は無視します。キーは保存前に redact します。

MeSH の照合は、正規化した返答語とタグ付き語の全体一致を最優先します。一致しなければ、引用符で囲まれていないカンマを含む MeSH 語の最後のカンマ以降を、空白・サブヘディング `/...` を除いて大文字小文字を無視して照合します。例えば `Diabetic Retinopathy, Proliferative[Mesh]` に PubMed が `Proliferative` だけを返した場合も、見出し全体の `"Diabetic Retinopathy, Proliferative"[mh]` を辞書照会します。タグ・サブヘディングを除き、演算子の除去は従来どおり大文字の `AND` / `OR` / `NOT` だけです。断片一致で見つけた場合だけ `meshLookups[].unquotedComma: true` とし、全体一致と `not_mesh` は `false` にします。引用符付きの見出しには断片照合を行いません。この実例の辞書応答は0件なので `unresolved` になります。

`--relookup` は、修正前に保存した照合結果を、LLM で式を作り直さずに更新するモードです。`--label` の plan が必須で、`--case` / `--variant` で plan の条件を絞れます。`--trials` / `--dry-run` / `--report` とは併用できません。plan に含まれる `complete: true` の試行だけ、保存済み `diagnostics[].expression` と `phrasesNotFound` から、通常診断と同じ重複除去規則で MeSH 辞書を照会し、`meshLookups` を置き換えます。未完了・ファイルの無い試行は触りません。各試行に `relookup: { at, gitCommit, previousMeshLookups }` を付け、一時ファイルと rename で保存します。`at` は ISO 時刻、`previousMeshLookups` は初回の再照会前の値を繰り返し実行しても保持します。実行番号用の `trial-<k>.history.jsonl` は作成・追記しません。通信は `.env` の `NCBI_API_KEY`、`createEvalFetch`、共有レート制御・バックオフを使用し、MeSH 辞書には検索日制限を付けません。進捗・API 通信はキーをマスクして `results/draft-frequency/<label>/relookup-progress.jsonl` に追記し、各対象試行の照会語数・分類内訳を0語でも1行表示します。

`--report` は plan と現在の試行ファイルから条件別・全体の同じ表を標準出力、`summary.md`、`summary.csv` に出します。計画数、完了、未完了、未実行を分け、各結論の分母は生成失敗を含む完了数です。ブロックと式全体の構文エラー率は、それぞれ保存された診断対象数を分母にします（完了試行の診断だけを数え、未完了試行と history は含みません）。MeSH も完了試行だけから各分類の語数を出します。`not_mesh語` の直後の `カンマ未引用の語` は `unquotedComma: true` の語数です。`relookup` の有無にかかわらず現在の `meshLookups` を数え、再照会前の値は集計しません。試行なしでも「0 件」の行を出します。

`--dry-run` は環境ファイル・通信・書き込みなしで入力ハッシュと既存 plan との整合を検証し、保存先と通信量の目安を表示します。概念ブロック数を N、固定プロトコルから決定するフィルタ数を F とすると、1試行は LLM が 3N 回、NCBI が生成中 N 回＋診断 N+F+1 回＝2N+F+1 回です。MeSH 辞書照会と再送は追加され、途中で生成に失敗した場合は少なくなります。

### issue #128 の再現用 fixture（R2）

- `fixtures/r2-pdr-prognostic/c0/criteria-only-draft2.json`: PR #104 当時の R2 の C0（16,409 件、913749 未捕捉）を `eval:import-c0 --variant criteria-only --draft 2` で取り込んだもの。出所は当時の `results/default/r2-pdr-prognostic/run.json`（runId `r2-pdr-prognostic-2026-09-11T23-20-18-741Z-19721433`、ファイル sha256 `8da775d2…6f0b40`）の `optimization.trials[initial].formula`。元の C0 は適格基準だけから生成されたため criteria-only とした
- `fixtures/r2-pdr-prognostic/seeds-no-pirart.json`: 既定分割から pirart 1977（913749）を除き、klein 1984（6709313）に差し替えた集合。klein 1984 は C0 が捕捉し、PR #104 の削除候補（`Diabetic Retinopathy[Mesh]` 削除）でも失われない研究から選んだ
- `fixtures/r2-pdr-prognostic/replay/pr104-r2-info.json`: `pr104-r2.json` の 1 件目の応答（MeSH 情報要求。式は変えない）だけを一字一句複製した replay。自由生成では 1 手目で 913749 を回収してしまい、未捕捉のまま終わる局面の `seedDiagnoses` を確認できないため、応答切れで 2 回目の `optimize_query` の直前に停止させてその局面を作る

```powershell
# 危険削除シナリオ（913749 を除く）
npm run eval:optimize -- --case r2-pdr-prognostic --c0 criteria-only-draft2 --seeds no-pirart --label issue128-danger
# 原因診断シナリオ（913749 を含む既定分割）
npm run eval:optimize -- --case r2-pdr-prognostic --c0 criteria-only-draft2 --label issue128-diagnosis
# 原因診断シナリオで、913749 が未捕捉のまま終わる局面の seedDiagnoses を確認する
npm run eval:optimize -- --case r2-pdr-prognostic --c0 criteria-only-draft2 --replay pr104-r2-info --label issue128-diagnosis
```

2026-09-13 の実 API 検証（master `149df53`）の結果は issue #128 のコメントに記録した。LLM が対象の削除候補を自由生成で出すとは限らないため、危険削除の基準は固定提案の replay（#128 手順 4、次節）で判定する。

## 固定提案による replay（issue #128 手順 4）

自由生成では `optimize_query` が毎回同じ提案を出すとは限らず、狙った削除候補（例: 危険削除シナリオでの `Diabetic Retinopathy[Mesh]` 削除）が出ない回は判定にならない。`--replay` は `optimize_query` の LLM 応答だけを fixture の固定テキストに差し替え、それ以外（実測・採否判定・NCBI 通信・confirmation の `expand_recall`/`pick_boundary` 等）は通常どおり実行する。自由生成の性能評価とは別物として扱う（後述のとおり `summary-aggregate.csv` から除外し、`compare` は自由生成の run と混ぜて比較させない）。

### fixture の形式

`fixtures/<case>/replay/<name>.json`（`<name>` は C0 と同じ命名規則: 英小文字で始まる英小文字・数字・ハイフンの 1〜32 文字）。

```json
{
  "name": "<ファイル名と一致させる>",
  "caseId": "<対象ケース ID>",
  "c0": { "name": "<適用先の凍結 C0 の名前>", "sha256": "<その C0 の sha256>" },
  "source": { "runId": "<出所の run ID>", "logs": [{ "file": "<元 LLM ログのファイル名>", "sha256": "<そのファイルの sha256>" }], "description": "<日本語の説明>" },
  "responses": ["<optimize_query の response.text をそのまま>", "..."]
}
```

- `c0` は実行時の `--c0` と名前・sha256 の両方が一致しなければ拒否する（**dry-run でも**）。狙った C0 以外に固定提案を流さないための保護。
- `responses` は 1 件以上必須で、各要素は `optimizeQuery` スキルと同じ前提（JSON としてパースでき、`target_block_id` と `proposed_expression` を持つ）を満たすことを読み込み時に検証する。不正なら実行前に拒否する。
- `source` は出所の記録（元 run の runId、元 LLM ログのファイル名と sha256、説明）。読み込み時の検証はしないが、後から「この応答がどこから来たか」を追えるようにするための必須フィールド。
- 応答は創作・要約・整形をせず、元 LLM ログの `response.text` を一字一句そのまま複製すること。`fixtures/r2-pdr-prognostic/replay/pr104-r2.json` が実例（PR #104 の r2-pdr-prognostic run から `optimize_query` の応答 3 件をそのまま複製）。

### 使い方

`--replay` は `--c0` と併用必須（固定提案は特定の凍結式に対する応答のため、`--c0` なしの指定は拒否する）。

```powershell
npm run eval:optimize -- --case r2-pdr-prognostic --c0 criteria-only-draft2 --seeds no-pirart --replay pr104-r2 --label issue128-replay --dry-run
# 本実行には Gemini / NCBI への通信が必要（optimize_query 以外の purpose と、実測・採否判定に使う）
npm run eval:optimize -- --case r2-pdr-prognostic --c0 criteria-only-draft2 --seeds no-pirart --replay pr104-r2 --label issue128-replay
```

`--dry-run` でも fixture の読み込み・検証・C0 ハッシュ照合までは行い、表示行に `replay=<name>` を出す。結果の保存先は自由生成と衝突しないよう分割キーに `+replay-<name>` を連結する（`--label` があればその後ろに続ける。例: `s20260912+issue128-replay+replay-pr104-r2`）。`eval:candidates`（却下候補の事後計測）も `--replay` を受け取り、同じキーで `run.json` を探す。

### 応答を使い切ったときの `stopped`

用意した応答をすべて使い切った後にサービスが次の `optimize_query` を要求すると、LLM を実際に呼ぶ直前で安全に停止する（`run.json` は `error` にならない）。最後の応答による判定まで終わってから止まるため、`trials` には用意した応答 1 件につき試行が 1 件残る（`mesh_requests` を含む応答は `kind: 'information'` の試行になり候補評価そのものを保留する。それ以外は `kind: 'proposal'` として実測・採否判定まで進む。queryOptimizationService.ts の `proposal.meshRequests.length > 0` 分岐を参照）。`pr104-r2` の 1 件目（MeSH 情報要求）は前者、2〜3 件目は後者にあたる。この場合 `optimization.stopReason` は `user_stop`、`optimization.status` は `stopped` になる（他の理由で `user_stop` になったときと区別が付かないので、`run.json` の `replay.exhausted` が `true` かどうかで「応答切れによる停止」を判定すること）。`replay.usedCount` が `replay.responseCount` と一致していれば使い切っている。

### 自由生成の評価とは別扱い

- `npm run eval:report` の `summary.csv` は行ごとに `replay` 列（fixture 名。自由生成は `-`）を出す。`summary-aggregate.csv`（頑健性の集計）からは replay run を常に除外し、除外件数を `summary.md` に注記する（固定提案は自由生成のばらつきの一部ではないため）。
- `npm run eval:compare` は、比較する 2 run の片方だけが replay、または両方 replay でも fixture の内容（sha256）が異なる場合は比較を拒否する（差が自動調整の効果か固定提案の有無・内容の違いかを区別できないため）。

## 外側の候補の段階別ログ（issue #126）

`eval:freeze-margin` は凍結 C0 から拡張語を一度生成し、拡張式と margin（拡張式 NOT 現式）を固定します。`eval:outside-stages` はその固定拡張語で製品の `searchOutsideCandidates` を実行し、held-out 研究が現式で捕捉済みか、取りこぼしならどの段階まで到達したかを記録します。取得戦略の既定は先頭からの取得のままです。ハーネスの既定は比較のため旧既定（NCBI 既定の並び・取得 50 件／書誌 20 件）のまま、製品の既定は書誌 200 件・取得は per-term（issue #154。拡張語ごとの margin を件数昇順で均等配分して取得。計 200 件）です（#154 より前は関連度順・一括取得 200 件でした）。

凍結の引数は `--case <id>` と `--c0 <name>` が必須、`--draft <正の整数>` は既定 1、`--dry-run` は任意です。`fixtures/<case>/c0/<name>.json` をハッシュ検証して読み、拡張語が 0 件なら凍結せず終了コード 1 にします。現式・margin の件数はケースの検索日で制限した ESearch（retmax=0、strictCounts）で測ります。

出力は `fixtures/<case>/margin/<c0Name>-margin<draft>.json`。C0 の名前・ハッシュ、拡張語、拡張式・margin、件数、検索日、モデル、作成日時、gitCommit/gitDirty、内容のハッシュを保存します。名前は英小文字で始まる英小文字・数字・ハイフンの 1〜64 文字です。`wx` で上書きを禁止し、既存ファイルがあれば dry-run でも停止します。LLM のプロンプト・応答全文は `results/freeze-margin/<case>/<name>/llm/` に保存します。

`eval:merge-margins` は同じ C0 から複数回生成した拡張語を合わせ、取りこぼしの回収率と margin 件数の変化を比較するためのコマンドです。`--case <id>`、`--margins <name1,name2,...>`（2 件以上、重複不可）、`--name <新しい margin 名>` が必須で、`--dry-run` は任意です。名前の規則は凍結 margin と同じです。元 margin と参照先 C0 のハッシュを検証し、C0 名・C0 ハッシュ・検索日が全員で一致し、ケースの検索日とも一致することを確認します。

拡張語は `blockId` ごとに `--margins` の指定順に連結し、前後の空白を除いた `term` の文字列で重複を除きます（大文字小文字は区別、最初の語の属性を保持）。ブロックも初出順です。製品の式組み立て関数で拡張式と margin を作り、ケースの検索日で制限した ESearch 2 回（retmax=0、strictCounts。一時的な障害には E-utilities 既定のバックオフ付き再送が効く）で現式・margin の件数を実測します。LLM は呼びません。

出力は `fixtures/<case>/margin/<name>.json` で、通常の margin 形式に指定順の `sources: { name, sha256 }[]` を追加し、`model` は `merged` です。`sources` を含む内容をハッシュ化し、`eval:outside-stages -- --case <id> --margin <name>` でそのまま測定できます。`wx` で上書きを禁止します。dry-run も既存出力があれば停止し、正常時はハッシュ照合・ブロックごとの語数・合計語数・出力先を表示します。dry-run は `.env` を読まず、通信・書き込みを行いません。

段階測定の引数:

| 引数 | 指定・既定値 |
|---|---|
| `--case <id>` | 必須 |
| `--margin <name>` | 必須。拡張子なし、英小文字で始まる英小文字・数字・ハイフンの 1〜64 文字 |
| `--seeds <split>` | 既定分割 20260912。整数・名前付き集合は既存コマンドと同じ |
| `--retmax <n>` | 既定 50、1〜10000 |
| `--candidate-limit <n>` | 書誌取得上限。既定 20、正の整数 |
| `--sort relevance` | 省略時は NCBI 既定順。margin の取得だけに適用 |
| `--retrieval head\|year-stratified` | 既定 head。先頭取得と出版年代による層別取得を比較 |
| `--rank-depth <n>` | 既定 10000、1〜10000。0 で追加取得を省略 |
| `--label <name>` | 英数字・`.`・`_`・`-` の 1〜40 文字。`replay-` 始まりは禁止 |
| `--dry-run` | 引数・artifact・C0 ハッシュ・シード分割・保存先を確認 |

両コマンドの dry-run は `.env` を読まず、通信・書き込みを行いません。margin が無ければ「margin fixture が見つかりません: <path>」で終了コード 1 です。参照先 C0 のハッシュや、C0 に記録されたシード分割が実行条件と違う場合も停止します。製品が組んだ margin が凍結クエリと一致しなければ failed とし、別の式の段階結果は保存しません。

段階測定の保存先は `results/outside-stages/<case>/<marginName>/<splitId>/r<retmax>-l<limit>-<relevance|default>[+<label>]/run.json`。層別取得は並び順の後、label の前に `-yearstrat` を付け、head の既存キーは維持します。`config.retrieval` に取得戦略を保存します。同じ階層の `<runId>/llm/` に LLM ログ、`<runId>/progress.jsonl` に進捗・実 API 通信・共有リミッタ・バックオフを保存します。完了結果は gitCommit が同じときだけスキップし、別コミットなら `--label` を促して停止します。失敗は再試行でき、試行ログは残ります。`rankDepth` は保存先キーに含まれないため、同じコミットで値を変えて再測定する場合も別の `--label` を付けてください。API キーは保存前に既存の redact で除去します。

`year-stratified` は出版年代を古い順に 〜1979、1980–1989、1990–1999、2000–2009、2010–2019、2020〜 の固定 6 層に分けます。検索語は `(<margin>) AND (<日付範囲>)`。日付範囲は `"1000/01/01"[dp] : "1979/12/31"[dp]`、中間の各年代は初年の 01/01〜末年の 12/31、最後は `"2020/01/01"[dp] : "3000"[dp]` です。出版日は検索語で絞り、検索日の制限に使う `datetype=crdt` は維持します。

1 巡目は各層に `floor(retmax / 6)` 件を配り、余りを新しい層から 1 件ずつ加えます（50 件なら古い順に 8、8、8、8、9、9）。0 枠の層も件数取得を行います。取得できず余った枠は、`count` が取得済み件数を超える層へ、新しい層から 1 件ずつ均等に再配分します。残り件数を超えて配らず、2 巡目を `retstart=取得済み件数` で一度だけ実行します。配り切れない枠や追加取得で埋まらない枠は捨てます。各層内の取得順を保ち、新しい層から順のラウンドロビンで並べて重複を除き、既知除外・書誌取得・AI 選別へ渡します。取得上限と書誌上限は増やしません。`stages.strata` に各層の `label`、検索語に入れた `dateRange`、初回の `count`、追加取得を含む `retrievedPmids` を保存します。`marginHits` は層の件数の合計ではなく、margin 全体を別に測った件数です。

層別取得かつ `rankDepth > 0` の場合、候補選定終了後に同じ sort で各層を rankDepth 件ずつ取得し、研究ごとに `stratum`（報告 PMID が現れた層）と `stratumDeepRank`（層内の 1 始まり順位）を保存・標準出力に表示します。複数の層に報告があれば古い層から最初に見つかった層を採用し、その層で最小の順位を記録します。どの層にも無い場合、head、または rankDepth=0 では両方 null です。margin 全体の `deepRank` も従来どおり記録し、追加取得は候補選定には使いません。

`stages` は取得順の `retrievedPmids`、既知除外後の `novelPmids`、上限適用後の `requestedPmids`、書誌が返って AI 入力になった `fetchedPmids`、最終候補順の `pickedPmids` を持ちます。研究の複数 PMID のどれか一つが通過すれば、その研究がその段階に到達したと判定します。

| 判定 | 意味 |
|---|---|
| `captured_by_current` | 検索日内の研究 PMID のどれかが現式で捕捉済み。別の PMID が margin にあっても最優先 |
| `not_in_margin` | 現式で未捕捉で、margin にも入らない（拡張式でも捕捉されない） |
| `beyond_retmax` | margin 内だが取得一覧に無い |
| `excluded_as_known` | 取得されたが既知 PMID として除外された |
| `beyond_candidate_limit` | 既知除外を通過したが書誌取得上限の外 |
| `efetch_missing` | 書誌を要求したが返らず、AI 入力に無い |
| `not_picked` | AI 入力にはあるが最終候補に選ばれなかった |
| `presented` | 最終候補に含まれる |

gold（held-out を含む）は候補検索・LLM の入力に渡しません。既知集合は選択した分割のシード PMID だけです。候補選定終了後の事後集計で初めて gold 全 PMID の検索日内存在を確認し、`computeHeldOut` で分母を固定して研究単位に照合します。正常な群分割では held-out とシードは重ならないため、held-out の `excluded_as_known` は通常 0 件です。`retrievedRank` は取得一覧での 1 始まりの最小順位、無ければ null。`deepRank` は同じ margin・sort を rankDepth 件まで別途取得した一覧での順位です。この追加取得は事後集計専用であり、候補選定には戻しません。研究名・判定・両順位の表と判定別研究数を標準出力にも表示します（0 件も明示）。現式で未捕捉の held-out 研究数（取りこぼしの分母）を `missedHeldOutCount` に保存し、標準出力にも表示します（未集計時は null）。

R3 の実行例（凍結の本実行は API 通信を伴います）:

```powershell
npm run eval:freeze-margin -- --case r3-vascular-bleeding --c0 criteria-only-draft1 --dry-run
npm run eval:freeze-margin -- --case r3-vascular-bleeding --c0 criteria-only-draft1
npm run eval:freeze-margin -- --case r3-vascular-bleeding --c0 seeded-draft1
npm run eval:outside-stages -- --case r3-vascular-bleeding --margin criteria-only-draft1-margin1
npm run eval:outside-stages -- --case r3-vascular-bleeding --margin seeded-draft1-margin1
npm run eval:outside-stages -- --case r3-vascular-bleeding --margin criteria-only-draft1-margin1 --retmax 500 --candidate-limit 100 --sort relevance
```

通信量の目安（再送なし）: 凍結は LLM 1 回＋ESearch 2 回。段階測定は ESearch 数回＋EFetch 1 回＋LLM 1 回です。内訳は margin 取得と現式件数で ESearch 2 回、事後の gold 日付確認で 100 PMID ごとに 1 回、held-out 全研究の PMID をまとめた現式・margin 照合でそれぞれ重複を除いた 100 PMID ごとに 1 回（100 PMID ごとに計 2 回）、rankDepth > 0 なら追加 1 回です。書誌取得対象が空なら EFetch・LLM を省略し、書誌が全件欠落した場合も LLM 通信はありません。対象は 1 ケースずつ逐次実行します。

層別取得では上記の margin 取得 1 回が、margin 全体の件数 1 回＋1 巡目 6 回＋2 巡目最大 6 回になります（現式件数の 1 回は別）。rankDepth > 0 では margin 全体の順位取得 1 回に加え、事後集計で各層 1 回、最大 6 回を追加します。EFetch・LLM と gold 照合の通信量は head と同じ条件で数えます。

## margin の組み方の比較（issue #154）

`eval:outside-stages`（issue #126）の結論は「取得段階（先頭取得 vs 層別取得）ではなく margin の大きさそのものが律速」でした。取りこぼしが margin に入らない／margin が大きすぎて関連度順の順位が低い、という問題に対し、**拡張語の組み方を変えて margin を小さくする案**を比較するのが `eval:margin-design` です。製品コード（`src/`）は変更せず、比較は評価ハーネス内で完結します。

比較する 5 案（凍結 margin 1 つに対して同時に実行します）:

1. **full**: 凍結 margin の拡張語をすべて使う（現状。基準線）
2. **cutoff-\<N\>**（`--thresholds` で複数指定可、既定 `1000,2500,5000`）: 拡張語を 1 語だけ足した margin の件数を先に数え、件数が N 以下の語だけで組み直す
3. **per-block**: ブロックごとに「そのブロックの拡張語だけで広げた margin」を別々に作り、取得枠を分け合う
4. **per-term-equal**・5. **per-term-smallest-first**（issue #154 続き）: PR #155 で 1〜3 の案を比べた結果、確認候補に新しく届いた取りこぼしは 0 件だった一方、語ごとの捕捉表から**件数の少ない狭い語が単独で取りこぼしを拾っている**ことが分かった（例: `r3-vascular-bleeding` の `"aortic surgery"[tiab]` 単独の margin は 25 件で held-out 研究 1 件を含むが、全語を合わせた margin では数百位以下に埋もれる）。そこで、段階 1 で数えた「1 語だけを足した margin」を**そのまま取得単位**として使う 2 案を追加した。full・cutoff・per-block（ブロック単位で広げる）とは異なり、**語単位**で margin を分割する

**取得件数の枠はどの案でも合計をそろえます**: 取得件数は製品既定 `OUTSIDE_DEFAULT_RETMAX`（200）、AI に渡す書誌の上限は `OUTSIDE_DEFAULT_SKILL_CANDIDATE_LIMIT`（200）、並びは `OUTSIDE_DEFAULT_SORT`（relevance）。これらは `src/app/services/expandService.ts` から import した値をそのまま使い、数値は直書きしません。AI（`pickBoundaryCases`）の呼び出しは案ごとに 1 回だけです。

段階は 3 つです。保証しているのは**「gold（held-out の PMID）を選定（拡張語の選別・取得・書誌上限・AI 選定）の入力に一切渡さない」**ことで、「段階 3 まで gold 絡みの通信が一切起きない」ことではありません。事後集計の共通処理（gold の日付照合・現式での捕捉確認。下記の段階 3 の前半）は**案のループより前に 1 回だけ**実行するため、時系列としては段階 2（各案の選定）より先に gold 絡みの通信が発生します。ただしこの共通処理は gold PMID を使って現式の捕捉集合を求めるだけで、その結果を選定（どの拡張語を残すか・どの PMID を取得するか・AI に何を見せるか）へは一切戻しません。

- **段階 1（語ごとの件数。gold を使わない）**: 凍結 margin の `additions` の各語について、その語だけを足した margin クエリを組み、`esearch(retmax:0)` で件数を数えます。1 語ごとに `results/margin-design/<case>/<margin>/term-counts.jsonl` へ追記し（キーは margin クエリの sha256、最終行勝ちで圧縮）、数え済みの語は再実行時に通信しません。失敗（例外）した語の行は書き込まず、件数として残しません。
- **段階 2（案ごとの候補選定。gold を使わない）**: `full` と `cutoff-*` は製品の `searchOutsideCandidates` をそのまま呼びます（`additions` に語集合を渡し、拡張語生成 LLM を飛ばします）。`full` は凍結 margin クエリと一致することを確認します。`cutoff-<N>` は残った語集合が既に計算した案（full、または閾値の昇順で先に処理した cutoff）と同一なら選定を再実行せず `sameAs` を記録します（空集合どうしも同一集合として扱うため、最初に 0 語になった cutoff だけが `emptyMargin: true` を持ち、それ以降の空集合はそれへ `sameAs` します）。**`per-block`・`per-term-equal`・`per-term-smallest-first` は製品に対応する経路が無いため、ハーネス内で実装しています**（違いは取得段階だけ）。3 案とも「取得単位（`{ unitId, marginQuery, allocation }`）ごとに `esearch` → 単位の並び順でラウンドロビンして重複を除く → 既知除外・書誌上限・efetch・`pickBoundaryCases`（1 回。書誌 0 件なら呼ばない）」という共通の取得関数（`runRetrievalUnits`）を使い、取得単位の組み方だけが違います:
  - **per-block**: 取得枠 200 をブロック数で均等配分（余りは先頭ブロックから 1 件ずつ）→ ブロックごとに 1 単位
  - **per-term-equal**: 凍結 margin の全語のうち件数 1 以上の語を件数の昇順（同数は凍結 margin での出現順）に並べ、取得枠 200 を語数で均等配分する（`allocatePerBlockRetmax` と同じ余りの配り方）。ある語の件数が割当より少なければその語はある分だけ取れる（esearch の実測がその語の件数を超えて返らないため）が、**余った枠は他の語へ再配分しません**（単純さを優先）。件数 0 の語は取得単位に含めません（esearch しません）
  - **per-term-smallest-first**: 同じ並びで、件数の少ない語から「その語の件数ぶん（残り枠まで）」を順に割り当てます。枠が尽きたら以降の語の割当は 0 で、割当 0 の語は取得単位に含めません（esearch しません）。取得単位が 1 つ（件数 1 以上の語が 1 語）なら per-term-equal と同じ結果になるため、`sameAs: 'per-term-equal'` として選定を再実行しません（full・cutoff・per-block との `sameAs` 判定は行いません。組み方が異なるため）
  - **per-block の構造的な限界**: ブロック別 margin の和集合は、常に full の margin の部分集合です。「片方のブロックの拡張語だけでは拡張式に入らず、両方のブロックの拡張語が同時に効いて初めて拡張式に入る」文献（例: ブロック 1 は拡張語 A だけ、ブロック 2 は拡張語 B だけで当たり、A・B どちらか一方では当たらない文献）は、per-block では各ブロックを単独で広げるためどのブロック単独の margin にも入らず、構造的に `not_in_margin` になります。full との差（`missedHeldOutCount` や `presented` の違い）を per-block の欠点として読むときは、この構造的な取りこぼしが混ざっていることを踏まえてください。
  - **per-term の構造的な限界（per-block より強い制約）**: per-term は語 1 つずつを単独で広げるため、per-block の制約（複数ブロックの拡張語が同時に効いて初めて当たる文献を拾えない）に加え、**同じブロック内の複数語が同時に効いて初めて当たる文献**も拾えません。「1 語だけを足した margin」の外にある文献は、その語単独ではどうやっても margin に入らないため構造的に `not_in_margin` になります。per-term は「狭い語が全語合算の margin に埋もれて順位が低くなる」問題には効きますが、「複数語の組み合わせで初めて当たる」取りこぼしには効きません。
- **段階 3（事後集計）**: 案のループの前に一度だけ `buildPostHocContext` を呼び、gold PMID の検索日内存在確認と、held-out 研究が現式で捕捉済みかどうか（`inCurrent`）を求めます（この 1 回だけは案に依存しない共通の gold 通信で、どの案の `apiCalls` にも計上しません）。その後、案ごとに `classifyStudy`（outsideStages と共通）で 8 段階に判定します。`inMargin` は `full`/`cutoff-*` がその margin クエリの捕捉、`per-block`/`per-term-*` は**実際に esearch した取得単位**（割当 1 以上で実行した単位）それぞれの margin クエリの捕捉の和集合です（これも案自身の通信として `apiCalls` に計上します）。割当 0 で esearch しなかった単位の margin は inMargin に含めません（per-term-smallest-first で枠が尽きて取らなかった語の margin にだけ入る held-out 研究は `not_in_margin` になります）。`deepRank`（`--rank-depth` > 0 のとき）は `per-block`/`per-term-*` だけ研究ごとに最良（最小）の順位と、その順位が付いた単位を識別できる値（`deepRankBlockId`。per-block はブロック ID、per-term は `<ブロックID>:<語>` の形）を記録します。`emptyMargin`/`sameAs` の案はこの事後集計でも通信しません（margin が数学的に空 = `(拡張式) NOT (拡張式)` なので取りこぼしはすべて `not_in_margin` と分かっており、`sameAs` は参照先の案を見れば済むため）。加えて、案に依存しない**語ごとの捕捉表**を一度だけ作ります: 現式で未捕捉の held-out 研究について、段階 1 の各語 margin クエリでの捕捉を `results/margin-design/<case>/<margin>/<splitId>/term-capture.json` に `{ term, blockId, count, capturedStudyIds }[]` として保存します（診断用。選定へは戻しません。この通信もどの案の `apiCalls` にも計上しません）。

**`apiCalls` の読み方**: 段階 1（語ごとの件数取得）と事後集計の共通処理（`buildPostHocContext`・語ごとの捕捉表）の通信は、どの案の `run.json` の `apiCalls`/`apiElapsedMs`/`progress.jsonl` にも計上されません（案に依存しない一度きりの前処理のため）。`cutoff-<N>` の実際の通信コストを見るときは、その案自身の `apiCalls`（margin 取得・efetch・LLM・事後の捕捉確認）に、段階 1 で新たに数えた語数ぶんの件数取得（初回実行時のみ。2 回目以降は `term-counts.jsonl` に残っていれば通信しません）を足して考えてください。

引数:

| 引数 | 指定・既定値 |
|---|---|
| `--case <id>` | 必須 |
| `--margin <name>` | 必須 |
| `--seeds <split>` | 既定分割 20260912。他コマンドと同じ解釈 |
| `--thresholds <n1,n2,...>` | 正整数をカンマ区切り。既定 `1000,2500,5000`。重複・非整数・0 以下はエラー、昇順に正規化 |
| `--rank-depth <n>` | 既定 10000、0〜10000 |
| `--label <name>` | 英数字・`.`・`_`・`-` の 1〜40 文字。`replay-` 始まりは禁止 |
| `--variants <name1,name2,...>` | 実行・スキップ判定の対象を絞る。既定は全案（`full` / `cutoff-<N>`（`--thresholds` で指定した分だけ） / `per-block` / `per-term-equal` / `per-term-smallest-first`）。未知の案名・重複はエラー |
| `--dry-run` | 引数・artifact・C0 ハッシュ・シード分割を確認し、案の一覧・出力先に加えて、語ごとの捕捉表（`term-capture.json`）の出力先と作成済みかどうかを表示する |

保存先は `results/margin-design/<case>/<margin>/<splitId>/<variant>[+<label>]/run.json`（`variant` は `full` / `cutoff-<N>` / `per-block` / `per-term-equal` / `per-term-smallest-first`）。同じ階層の `<runId>/progress.jsonl` に進捗・実 API 通信、`<runId>/llm/` に LLM ログを保存します。既存結果の扱いは `eval:outside-stages` と同じ `decideOutsideExisting` を再利用し、同じコミットの完了はスキップ、別コミットの完了は `--label` を促して停止、失敗は再試行します。**スキップの判定は案ごと**なので、1 案だけ失敗していれば次回実行はその案だけを再実行し、他の完了済み案には通信しません。1 案が失敗しても残りの案は続行し、最後に失敗があれば非ゼロ終了します。標準出力には案ごとに 1 行（案名・語数・margin 件数・判定別研究数・AI が選んだ件数・sameAs・emptyMargin）を出します（0 件でも出します）。API キーは既存の `redact` で保存前に除去します。

**`--variants` で対象を絞る**: 既存の完了済み run（他コミット）に触れずに新しい案だけを足したいときに使います（例: 既に full/cutoff/per-block が別コミットで完了済みの結果に対して、per-term の 2 案だけを追加で実行する）。指定した案名だけを実行し、`decideOutsideExisting` によるスキップ判定も指定した案名だけに対して行います（指定外の案の run.json は一切参照・上書きしません）。`sameAs` の参照先（例: `cutoff-<N>` が `full` と同一集合で `sameAs: 'full'` になる場合）が `--variants` の指定に含まれないときは、参照先の run.json が同じ case・margin・seedSplit・label に存在し、かつ `status: 'completed'` であることを確認します（無い・読めない・`status: 'failed'` ならエラーにします）。**`status: 'completed'` だけを見て、参照先の run.json の `gitCommit` は照合しません**（別コミットの完了結果を参照するのは、既存の完了済み run に新しい案だけを `--variants` で足す正当な使い方であり、ここで別コミットを弾くとその使い方自体ができなくなるため）。確認できなければ「参照先を解決できない run.json ができてしまう」ことと「measured value の無い失敗した案を sameAs 側が完了扱いのまま参照し続ける」ことを防ぐためエラーにします（先に参照先の案を実行するか、`--variants` に含めてください）。既存の run.json を上書き・削除することはありません。

**語ごとの捕捉表（`<splitId>/term-capture.json`）も、無ければ作り直します**: 保存は run.json と同じく tmp へ書いてから rename するため、通信中に落ちた不完全なファイルを「完了」とは扱いません。全案が完了済み（スキップ）でも捕捉表が無ければ、共通前処理（段階 1 の語ごとの件数取得。数え済みの語は通信しません）と事後集計の共通処理（gold の日付照合・現式での捕捉確認）だけを実行して捕捉表を作り直します。**このとき案の選定（LLM・efetch・margin の取得）は一切行いません**（`GEMINI_API_KEY` も要求しません。案の選定でしか使わないため）。捕捉表の作成が失敗すれば run.json は完了のままファイルだけ残らず、非ゼロ終了して次回実行時にまた作り直されます。全案が完了済みで捕捉表もあれば、従来どおり `config()` も通信も一切行いません。

集計は `npm run eval:margin-design-report`（実体は `marginDesignReport.ts`。`report.ts` とは対象スキーマが別のため別ファイルにしました）で行い、`results/margin-design/summary.md` / `summary.csv` にケース・margin・シード分割・案ごとの比較表を書き出します。行の並び順は case / margin / seedSplit / variant（`full` → `cutoff-<N>` は N の数値昇順 → `per-block` → `per-term-equal` → `per-term-smallest-first`。文字列比較だと `cutoff-500` と `cutoff-1000` が逆転するため数値で並べます）/ label です。列は `seedSplit`（`--seeds` で選んだシード分割。既定は `s20260912`。別の分割は held-out 集合が変わるため別行として区別します）・`label`（`--label` の値。無指定は `-`）・sameAs・語数・margin 件数（`per-block` は `件数+件数` の表示。per-term は語数が多くなりうるため `<語数>語/合計<件数>` の要約表示。どちらも重複を含む単純合計で、和集合の件数ではない）・取りこぼし研究数・presented 研究数・取りこぼし研究ごとの「研究名:判定@取得\<順位|-\>/深い\<順位|-\>」（取得順位と、rankDepth 件まで別途取得した深い順位を区別。per-block・per-term はどの単位で付いた順位かを `(#<deepRankBlockId>)`（per-block はブロック ID、per-term は `<ブロックID>:<語>`）で示す）・AI に渡した書誌数・AI が選んだ件数・LLM 入力トークン・費用・所要時間です。**sameAs のある run は選定・事後集計を再実行していないため**、margin 件数・取りこぼし研究数・presented 研究数・AI に渡した書誌数・AI が選んだ件数・LLM トークン・費用の列は `0` や `-` ではなく `=<参照先の案名>` と表示します（比較表だけを見て「提示 0 件」と誤読しないため。参照先は同じ case・margin・seedSplit・label の中の案を指します）。`status: failed` の run は該当列を「失敗」として表示し、黙って落としません。

コマンド例:

```powershell
npm run eval:margin-design -- --case r3-vascular-bleeding --margin seeded-draft1-margin1 --dry-run
npm run eval:margin-design -- --case r3-vascular-bleeding --margin seeded-draft1-margin1
npm run eval:margin-design -- --case r3-vascular-bleeding --margin seeded-draft1-margin1 --thresholds 500,1000,2000 --rank-depth 200
# full/cutoff/per-block が別コミットで完了済みのとき、per-term の 2 案だけを追加で実行する
npm run eval:margin-design -- --case r3-vascular-bleeding --margin seeded-draft1-margin1 --variants per-term-equal,per-term-smallest-first
npm run eval:margin-design-report
```

解釈の限界: 語ごとの件数は margin クエリ全体を OR で組んだときの件数と単純には足し算にならない（語の重複ヒットぶん、cutoff で残した語だけの margin 件数が N の合計を超えることがあります）。段階 1 の件数は「その語 1 つだけを足した margin」の件数であり、cutoff 後の実際の margin 件数は段階 2 の実測（`marginHits`）を見てください。AI（`pickBoundaryCases`）の選択は同じ入力でも実行ごとにぶれうるため、`presented` の件数や内容を案の優劣の唯一の根拠にしないでください。

**通信量の目安（per-term-equal・per-term-smallest-first、再送なし）**: 段階 1（語ごとの件数）は全案共通で、語数ぶんの `esearch(retmax:0)`（初回実行時のみ。以後は `term-counts.jsonl` にキャッシュ）。段階 2 は実行する語数（per-term-equal は件数 1 以上の全語、per-term-smallest-first は枠を使い切るまでの語だけ）ぶんの `esearch` + EFetch 1 回 + LLM 1 回（書誌が 0 件なら EFetch・LLM は省略）。段階 3（事後集計）は実行した語数ぶんの gold 照合 `esearch`（100 held-out PMID ごと）に加え、`--rank-depth` > 0 なら実行した語数ぶんの順位取得 `esearch` が追加されます。per-block（ブロック数ぶん）よりも取得単位が多くなりやすい（語数 ≥ ブロック数）ため、通信回数も比例して増えます。

## gold の監査と凍結

`audit.json` に含入・除外 PMID の重複、複数 study 対応、PMID の無い study、対応不明 PMID を記録します。群は PMID 共有の推移的な連結成分で、各研究名とその研究に属する PMID を保持します。分割は群単位、採点は研究単位です。各研究の報告を 1 件でも捕捉すれば、その研究を捕捉したと数えます。

`manual_review: true` のケースでは、hits と捕捉 PMID を保存しますが指標と改善判定は null にして採点を保留します。共有 PMID による群の扱いを人が確認したら、`reviewNote` に根拠を書き `manual_review: false` にしてから実行してください。共有群に属する別研究も採点では個別に数えます。採点規則を変更する際は結果を見て分母を選び直さないでください。

乱数は seed=20260912、LCG と Fisher–Yates に固定しています。`seeds.json` があれば内容をそのまま再利用し、群との不一致はエラーにします。代表 PMID は出版年順・同年なら PMID 数値順です。ローカル本文には複数報告を束ねた引用があるので、単一 PMID の引用から年を確実に抽出できる場合だけ年を使います。群内に年不明があれば群全体を PMID 順にします。本文から抽出した年は audit に残します。

| ケース | PMID あり study | gold PMID | 群 | held-out 群 | held-out 研究 | PMID 無し | 対応不明 PMID |
|---|---:|---:|---:|---:|---:|---:|---:|
| R1 | 18 | 32 | 17 | 14 | 15 | 3 | 0 |
| R2 | 57 | 87 | 57 | 54 | 54 | 2 | 0 |
| R3 | 19 | 20 | 19 | 16 | 16 | 3 | 0 |

R1 の davis 2014a / davis 2014b は PMID 24963659 を共有します。両者は別研究で、共有 PMID は両試験にまたがる副次報告です。同じ側に分割するため全体は 17 群 / 18 研究、held-out は 14 群 / 15 研究です。

作成日範囲の検証は prepare では未実施（outsideDate=null）です。本実行では C0 生成前に gold 全体へ日付付き ESearch を実施し、分母を固定します。各研究の PMID を範囲内に絞り、範囲内の PMID を持たない研究と群を除外し、範囲外の PMID と群を run.json に残します。凍結シードが範囲外なら差し替えずそのケースを失敗にします。

## 計測と出力

PubMed ESearch だけに `datetype=crdt`、`mindate=1800/01/01`、ケース検索日を maxdate として付与します。MeSH と SPARQL には付けません。総件数は retmax=0 で計測し、捕捉 PMID は検索式と gold の積集合を最大 100 PMID ずつ、retmax を明示して全件取得します。全検索結果を列挙しないので C0 が PubMed の 10,000 件取得上限を超えても gold 捕捉を取りこぼしません。取得件数と ID 一覧の整合を確認し、不完全取得を 0 件として扱いません。

C0 はシード文脈を空にして適格基準だけから作り、C1 で凍結シードと esummary(JSON) のタイトルを渡します。シードのタイトルや gold の held-out は C0 の LLM に渡しません。C1 の trial 採否理由はサービスの結果をそのまま記録します。

ケースの各段階で `results/<profileId>/<caseId>/<c0Key>/<splitKey>/run.json` を更新し、同じキー（profile・case・C0・シード分割・label のすべて）かつ `maxHits` と `gitCommit` も一致する完了ケースは再実行時にスキップします。同じキーで `maxHits` が一致してもコミットが異なる完了結果は、エラーとして保持します。ラベル指定時は以下の保存先・履歴の `<splitKey>` を `<splitKey>+<label>` と読み替えてください。失敗ケースは次の実行で最初からやり直し、他ケースを止めません。最適化の途中からの再開ではありません。再実行履歴は `results/<profileId>/<caseId>/<c0Key>/<splitKey>/<runId>/` に残り、その下の `llm/` に呼び出し単位（リトライ含む）の目的・モデル・プロンプト・応答全文・トークン・所要時間、`progress.jsonl` に進捗・API 通信・最終状態を保存します。run.json の llmLogs はこの runId ディレクトリからの相対パスです。

API コール数は実 fetch 回数、API 所要時間は fetch の応答までの合計です。ケースの elapsedMs は待機・処理時間込みです。サービス内の apiCalls は別の予算単位なので optimization の中へそのまま残しています。URL の api_key/key および環境変数のキー値は保存前にマスクします。

### API 通信の観測と集計

この観測追加は 429 の原因を測れるようにするためのもので、原因はまだ特定していません。共有バケットのレート・容量や再送方針は変更していません。原因説明には、実行 SHA・送信履歴・経路・再送・同時実行条件をそろえた再測定が必要です。

`eval:optimize` の `progress.jsonl` は従来どおり `{ at, event }` の JSONL です。外側の `at` は記録時刻で、API イベントでは fetch 完了後になります。追加項目は次のとおりです。

| イベント | 追加項目と意味 |
|---|---|
| API (`event.api`) | `startedAt`: fetch 送信直前の ISO 8601 時刻、`method`: GET / POST 等。`status` / `elapsedMs` / `url` / `error` は従来どおり |
| API の試行 | `attempt`: 初回 1、再送 2 以降。`requestId`: 論理的な検索 1 回を識別する UUID。同じ検索式を別途発行すると別 ID・試行 1 に戻る |
| リミッタ (`event.limiter`) | `at`: acquire 完了時刻、`waitedMs`: 呼び出しから完了まで（共有キューの待機込み）、`bucket`: `withoutApiKey` / `withApiKey`。既存の共有バケットを包んで測定し、待機ゼロも 1 行残す。後続の fetch には紐付けない |
| バックオフ (`event.backoff`) | `ms`: 再送前に指定された待機時間。待機開始前に 1 行記録し、同じ時間だけ待つ。リミッタ待機とは別集計 |
| 開始条件 (`event.process`) | 各ケースの実行履歴の先頭に 1 行。`pid`、`hasApiKey`（NCBI キーの有無のみ）、`caseCount`（選択対象数、スキップ予定も含む）、`caseExecution: sequential`（ケースは逐次）、`requestConcurrency: caller-dependent`（ケース内の要求並行性は呼び出し側依存）、`externalConcurrency: unknown`（他プロセスは検知しない）、`gitCommit`、`gitDirty`、`runId` |

試行番号を確定できるのはハーネスの `evalSearch`（製品 ESearch に委譲する GET/POST とハーネスの POST、gold 分割取得を含む）と、再送しない `seedTitles` です。製品サービスから直接発行される ESearch / EFetch / MeSH と LLM は呼び出し単位を観測できないため `attempt` / `requestId` を `null`（不明）で残します。HTTP 結果や URL の一致から再送を推定しません。一方、製品コードを変更せず、共有の `eutils.sleep` を通るすべての再送（ハーネスの `evalSearch` と製品サービス経由の E-utilities に加え、同じ依存を受け取る MeSH RDF の SPARQL 取得 `id.nlm.nih.gov` も含む）の回数と指定待機時間を `backoff` 行として記録します。行にはホストを持たないため、E-utilities の再送だけを切り出すことはできません。個々の `requestId` / 試行とは紐付かず、LLM の再送は対象外です。トークンバケットの待機は `eutils.sleep` を経由しないため、バックオフには数えません。

`run.json` の `apiCalls` は従来どおり実 fetch 回数、`apiElapsedMs` は fetch の所要時間合計で、リミッタ待機・バックオフは加算しません。全進捗行は保存前に `redact` を通し、API キー値は残しません。

```powershell
# 1 実行のログ（パスは手元の実行履歴に置き換える）
npm run eval:api-audit -- experiments/query-optimization-bench/results/<profile>/<case>/<c0>/<split>/<runId>/progress.jsonl
# ディレクトリ内の progress.jsonl を再帰収集し、複数実行を時刻順に統合
npm run eval:api-audit -- experiments/query-optimization-bench/results
```

集計対象はホストが `eutils.ncbi.nlm.nih.gov` の通信のみです（別ホストの SPARQL / LLM は除外）。日本語でステータス × 経路（ESearch GET / POST、ESummary、EFetch 等）の件数、任意の 1 秒窓 `[t, t+1000ms)` の最大送信数、各 429 と直前 5 件の送信時刻・前の送信からの間隔・経路・試行番号、リミッタ待機とバックオフそれぞれの件数・合計・最大、記録されたプロセス条件を表示します。同じ時刻の別リクエストも数え、外側の完了時刻で並べ替えません。

指定ファイルが無い、ディレクトリ内にログが無い、JSON 行が壊れている（途中の空行も含む）、観測項目が不正な場合はエラー・終了コード 1 にします。ただし、ファイルが改行で終わらず、その最終行の JSON パースに失敗した場合だけは書きかけとして読み飛ばし、「書きかけの末尾行を読み飛ばしました: <ファイル>:<行番号>」と警告して集計を続けます。途中の破損行や、改行で終わる破損した最終行は従来どおりエラーです。エラー・警告に壊れた行の本文は出さずファイルと行番号を示します。末尾の改行は許容し、空ファイルは 0 件と明示します。旧ログの送信時刻・方式・試行番号は逆算せず欠測として表示し、時刻欠測の要求はレートと直前履歴から除外します。その場合、最大値と履歴は不完全です。待機ログなし・バックオフ記録なしも表示し、待機ゼロと区別します。

再帰集計は選択した全ファイルを統合するため、コピーしたログを重複して置くと二重計上します。別ホストの時計のずれは補正せず、ログにない別プロセスや同一 IP の通信は把握できません。外部で同時実行した条件は別途記録してください。実 API に接続する検証は、この集計コマンドでは行いません。

`eval:candidates`（`candidates.ts`）と `eval:freeze-c0`（`freezeC0.ts`）は実 NCBI 通信を行いますが、`progress.jsonl` を書かず、`eval:api-audit` の集計には現れません。これらの通信も NCBI のレート枠を消費するため、429 を解釈するときは両 CLI の同時実行条件も別途記録してください。

再現率の分母は全研究数または held-out 群に属する研究数、分子は捕捉研究数です。喪失・追加の一覧も研究名で出力します。既知組入研究当たりのレコード数は hits / 捕捉研究数です。指標の分母 0 は null。捕捉 0 で hits>0 の既知組入報告割合は 0、既知組入研究当たりのレコード数は null です。改善は C0 の held-out 捕捉を一つも失わず、held-out 捕捉研究が増えるか hits が減る場合に限定します。捕捉喪失と hits 減少は tradeoff として記録します。

B1 は任意の `fixtures/<id>/b1.json` に `{ "query": "展開済みの PubMed 検索式" }` として与えます。変換根拠は `b1.md` に残してください。存在すれば同じ分母と日付で実行し、無ければ summary の B1 は「欠測」です。完了後に B1 を追加した場合は report に式と「未計測」が表示されます。自動で実 API を再実行しません。

集計は条件列（profile）を先頭に付け、全条件を `results/summary.md` と `results/summary.csv` にまとめます。列には `role` / `c0`（`live` または `frozen:<name>`） / `seedSplit` / `maxHits` / `gitCommit` / `label`（gitCommit の隣）も含みます。`resultsDir` 配下は「その系列で最初に見つかった run.json」を再帰的に集めるだけなので、旧レイアウト `results/<caseId>/run.json`・現行 `results/<profileId>/<caseId>/run.json`・新レイアウト `results/<profileId>/<caseId>/<c0Key>/<splitKey>/run.json` のいずれも読めます（profileId が無ければ `default` として扱います）。既存の結果の移動・削除は行いません。

### 有害採用・確認負荷・LLM コストの計測

- **報告単位**: `Metrics.capturedReports` に捕捉した gold PMID を重複なし・数値昇順で保存します。比較の `lostReports` / `gainedReports` も数値昇順です。どちらかの metrics に記録がなければ両方とも `null`（欠測）で、0 件とは区別します。既存 run には記録がないため報告単位は欠測です。`improved` / `outcome` と有害採用の判定は研究単位のままです。
- **却下・保留候補の直前比**: `rejectedCandidates` は C0 比に加え、`priorId`（その提案より前で最後に採用された提案の候補 ID、無ければ `C0`）と `comparedToPrior` を保存します。採否監査と同じ比較元を使い、既存の候補計測・再利用 metrics から比較するので追加通信はありません。比較元または候補の metrics が無ければ `null` です。模擬レビュアーの各ラウンドにも同じ項目を記録します。

- **有害採用（`adoptionAudit`）**: C0→C1 の間に採用されたすべての候補（`optimization.trials` の `kind: 'proposal'` かつ `accepted: true`）について、**採用直前の基準式**（その候補より前で最後に採用された候補、無ければ C0）と比べて held-out 捕捉を失っていないかを監査する。1 件でも held-out を失った採用を「有害な採用」（`harmfulAdopted`）と数える。C0 の測定・却下候補の既存計測（`rejectedCandidates`）・C1 の測定は再利用し、同じ gold クエリを重複して投げない。`manualReviewPending` のときは採点そのものを保留する（`harmfulAdopted: null`）。比較元または候補自身の metrics が無く比較できなかった採用件数を `unscoredAdopted` に記録し、1 件以上あれば `harmfulAdopted: null`（未採点）とする。候補自身の測定失敗や比較元の欠測は原因を `error` に記録し（手動監査待ちだけの場合を除く）、`lostHeldOut: []` を「0 件確定」とは読まない
- **確認負荷（`confirmation`）**: 最良式（`best`）があり、自動調整の `status !== 'error'` のとき（`stopped` も含む）、`searchOutsideCandidates`（`#/expand` の margin 探索と同じ処理）で「人が確認すべき候補」の件数だけを数える。`confirmationAudit.ts` は `retrieval` を渡さず製品の既定で測定するため、**issue #154 で既定が per-term（拡張語ごとの margin を件数昇順で均等配分して取得。書誌 200 件）に変わって以降の run は per-term で測定している**（#154 より前の run は関連度順・一括取得 200 件）。頑健性集計や過去 run との比較で `confirmationTotal` を読むときはこの既定変更を考慮すること。**既定（`--oracle-rounds 0`）では候補を自動調整へフィードバックしない**。模擬レビュアーを有効にした場合は、下記の規則で include をシードに加えて再調整する。`existingPmids` には常にシード PMID だけを渡し、gold（held-out を含む）は渡さない。gold への対応付け（`heldOutStudiesAmongCandidates` / `nonGoldCandidates`）は、検索・LLM 呼び出しがすべて終わったあと、この集計のためだけに事後に行う。`total` は outside 候補と、held（レビュー保留）だった候補の `impact.inspected`（シード PMID を除く）を合わせて重複除去した件数。outside check 自体の失敗は `status: 'error'` を記録するだけで run を failed にはしない
- **LLM 使用量とコスト（`llmUsage`）**: `loggedFactory` の呼び出し 1 回（リトライの各試行を含む）ごとに tokensIn/tokensOut を積算し、`src/lib/llm/pricing.ts` の単価表でコストを概算する。失敗した呼び出しも `calls` に数える（トークンは加算しない）。価格表に無いモデルの呼び出しが 1 回でもあれば `costUsd` は恒久的に `null`（`unpricedCalls` で件数を確認できる）。失敗呼び出し（トークン無し）は 0 円加算として扱い、それだけでは `costUsd` を null にしない。成功しても tokensIn/tokensOut が両方 null なら `untrackedCalls` を増やし、`costUsd` は恒久的に null とする。cost 列は「欠測（価格表外 N 件）」「欠測（トークン不明 N 件）」で原因を区別し、両方あれば併記する。llmUsage の無い古い記録は従来どおり「欠測」
- summary.md の後半に **頑健性の集計**（`role` / `profile` / `case` / C0（`live` または `variant`） / シード分割 / `label` / `gitCommit` ごとにグループ化した run 数・C0 hits / C1 hits / C1 heldOutRecall の min・median・max・outcome 件数・`harmfulAdopted` 合計・`confirmationTotal` の中央値）を出す（`results/summary-aggregate.csv` にも同じ内容）。`c0` が `live` の行は run ごとに C0 が再生成されるため、行内の散らばりを自動調整ポリシーの効果と解釈しない注記を付ける。`seedSplit` の後ろに `label`（無ければ `-`）・`gitCommit`（先頭 12 文字、無ければ「欠測」）列を置き、この値でコード版を分ける。同じ凍結 C0 の variant 内で `c0.id` が複数なら「複数ドラフト（N 種）を含む。散らばりには C0 の違いが混ざる」と注記する

## 解釈の限界

これは現在の PubMed に作成日上限を適用した後ろ向き評価で、当時の検索の再現ではありません。完成後の Methods、現在の索引、LLM の学習混入、PMID のある既知研究への限定が残ります。ブロック自動承認の影響の向きは不明です。3 ケース・固定分割 1 回から新規レビューの性能、専門家検索への非劣性、選考時間を主張できません。既知組入報告割合と既知組入研究当たりのレコード数だけで検索効率の優劣を結論しないでください。


## 模擬レビュアーによる再調整（`--oracle-rounds`）

```powershell
npm run eval:optimize -- --case r1-mindfulness-smoking --oracle-rounds 2 --label oracle --dry-run
# 実 API を呼ぶ場合は --dry-run を外す
```

`--oracle-rounds` は 0〜2 の整数で、既定 0 は従来の C0 → C1 → 却下候補 → 有害採用 → 確認負荷のままです。
0 も `oracleRounds` に保存し、`oracle` は未設定にします。`--replay` とは 0 の明示指定も含め併用できません。
完了結果の要求ラウンド数（古い記録の欠落は 0）が異なる場合はエラーとなるため、`--label` を変えてください。
`--dry-run` は `oracleRounds=` を表示します。

有効時は基本 run の確認負荷集計後、直前の `outsidePmids` と `lostInspectedPmids` の和集合を提示集合とし、
検索日内の gold に属する、現在のシード以外の PMID だけを include と答えます。それ以外は exclude と数え、maybe は使いません。
**gold の境界**: gold は模擬判定の返答と事後採点にだけ使います。探索の既知集合と最適化の入力に渡すのは
初期シードと、それまでに提示され include された PMID だけです。未提示の held-out を渡しません。
**この模擬は保守的に偏ります**。gold に無い適格研究も exclude と答えるため、実際の人より include が少なくなりえます。
人の include の見落としは模擬しません。

更新シード全体の書誌を `seedTitles` で取得し、直前の最良式を初期式に、同じ `maxHits` / `maxIterations` /
`approvedBlocks` / `criteria` で新たに最適化します。runId は `<基本 runId>-oracle<k>`、チェックポイントも毎回新規です。
各ラウンドでは最終式、前段との比較、却下候補、有害採用、更新シードでの確認負荷を測定します。
停止理由は `confirmation_unavailable`（前段の確認負荷が ready でない）、`no_new_includes`（追加 include なし）、
`no_best_formula`（追加 include はあるが前段の最良式なし）、`round_limit`（要求回数完了）です。

`oracle.rounds` に提示・include PMID、include の研究 ID、exclude 件数、更新シード、runId、最適化・測定・監査を保存します。
`oracle.final` は最後の段階の最終式（再調整 0 回なら C1）、`exposedHeldOutStudies` は基本 run と全ラウンドの確認候補に
提示された held-out 研究 ID の和集合です。`unexposedHeldOut` は一度も提示されなかった held-out 研究についての
`total` / `captured` / `recall` です。分母 0、最終測定失敗、手動監査待ちでは recall は null です。
既存の held-out 分母は include 後も固定し、未提示研究の指標を別に残します。

ラウンドごとに run を保存し、試行ディレクトリにマスク済みの `oracle-round-<k>.json` を書きます。
途中の例外、最適化の error、最終式・却下候補・有害採用監査の測定失敗は run 全体を failed にします。
途中ラウンドから再開せず、既存方式どおり基本 run からやり直します。確認負荷の error は次ラウンドの停止条件です。

## 旧版 run の採点（`eval:score-legacy`）

```powershell
npm run eval:score-legacy -- experiments/query-optimization-bench/results --dry-run
# run.json のパスやディレクトリを複数指定できる
npm run eval:score-legacy -- path/to/run.json path/to/results
```

ディレクトリは再帰的に `run.json` を集め、親ディレクトリ名がその runId である試行コピーを除外します。
`legacy === true` かつ `status === 'completed'` の記録だけが対象です。対象外は理由付きでスキップし、対象が無ければ「対象 0 件」を表示します。
既存の `computeAdoptionAudit` に保存済みの分母、C0 / C1、試行履歴・却下候補計測を渡し、有害採用だけを採点します。
C0 / C1 の再採点や分母の作り直しは行いません。

原本の `run.json` は変更せず、同じディレクトリの `scored.json` に
`{ adoptionAudit, scoredAt, gitCommit, gitDirty, source }`（source は元の runId）を一時ファイル + rename で保存します。
同じコミットでの採点済み記録はスキップし、別コミットの記録は上書きせずエラーとして次のファイルへ進みます。
採点コミットを取得できない場合も保存しません。

通常実行は dotenv で `.env` を読み、必要な追加計測に `NCBI_API_KEY` と検索日制限付き `createEvalFetch` を使います。
LLM は使いません。ログ・保存内容は `redact` でキーをマスクします。`--dry-run` は `.env` を読まず、通信・保存をせず対象と保存先だけを表示します。

## 確認用ケースの選定（`eval:select-cases`）

`screen` は Cochrane-bench の cc-by gold 全件、parsed JSON、検索日監査
`data/audit/medline_search_dates/session_2026-09-14/final_cc-by.jsonl` を読み取り専用で使います。
入力ルートは `eval:prepare` と同じ `COCHRANE_BENCH_DIR` または既定のローカルパスです。通信しません。

```powershell
npm run eval:select-cases -- screen
```

`fixtures/_selection/screening.json` と `screening.md` に、全レビューの基準の真偽、研究数、重複・共有・未対応 PMID、
PMID 無し研究名、最終番号付き検索ステップ、検索日、更新検索の根拠抜粋、不適格理由を残します。
研究群と研究数は `prepare.ts` の `auditGold` をそのまま使います。
更新検索の語と日付制限は機械検出し、収録範囲の `1946 to ...` は除きます。
他の基準を通過し更新検索の疑いがあるレビューは、判断がなければ「判断待ち」です。

根拠を読んだ人が `fixtures/_selection/update-search-decisions.json` を次の形で用意し、`screen` を再実行します。
`updateSearch: true` は不適格、`false` は適格です。判断ファイルを CLI が自動作成することはありません。

```json
{ "<pmcid>": { "updateSearch": false, "note": "更新検索ではないと判断した根拠" } }
```

```powershell
npm run eval:select-cases -- screen
npm run eval:select-cases -- pick --seed 20260915 --count 3
```

`pick` は判断待ちが 1 件でもあると拒否します。適格を PMCID 順に並べ、`selectSeeds` と共通の
LCG / Fisher–Yates（`seededShuffle`）で選びます。3 件未満なら基準を緩めず全件を選びます。
`confirmation-cases.json` に選定乱数・要求数・全適格 PMCID・選定内容・元 screening の SHA-256 を保存します。
`screening.*` は再生成で上書きしますが、選定結果は `wx` で上書きを禁止します。作り直す場合は手動で削除します。
選定後は `suggestedId`・PMCID・検索日を `types.ts` の `CASES` に `role: 'confirmation'` として転記し、
gold の監査とシード凍結を済ませます。検索日は従来どおり `CASES.searchDate` に手で記入します。

## 再評価の行列実行（`eval:rerun` / `eval:rerun-report`）

`candidateLosses` 表は完了した current run の却下・保留提案を 1 候補 1 行で出します（採用提案と legacy / legacyLive は対象外）。
`priorId` / `comparedToPrior` による直前の採用済み式との比較を主とし、C0 比も併記します。
比較元が全提案のうち最後の採用候補なら、採否監査と同じく C1 の測定を優先し、C1 が無い場合は候補の計測・再利用 metrics を使います。
直前と候補の件数、失った held-out 研究名、gold 報告数（`lostReportsPrior`）、削除影響の件数・標本抽出法を記録します。
`priorSource` は新しい run では `rejectedCandidates`、`comparedToPrior` がない既存 run では `adoptionAudit` です。
既存 run は監査の試行列から直前の採用候補をたどり、研究単位の直前比だけを補います。監査行に `error` があれば比較不能です。
手動監査待ちの run は直前比を欠測とし、既存 run の監査行が `error` なし・`lostHeldOut: []` でも損失ゼロとは扱いません。
報告単位は今後の run から記録し、既存 run の `lostReportsPrior` は欠測です。損失 0 件の研究名は空文字、比較不能は欠測と表示します。
保存済み run の書き換えや報告単位の再計測は行いません。

設定は `rerun/config.json`。雛形は開発用 3 件、2 分割、条件ごと 3 枠、draft11 開始です。
確認用ケースを登録した後、この設定の `cases` にも ID を追加します。
`legacyWorktree` は旧版の絶対パスを記入するか、`--legacy-dir <絶対パス>` で上書きします。
旧版段階は指定がなければ失敗として記録します。dry-run は未設定・未凍結も表示できます。

旧版は評価用パッチ済み CLI が `--fixtures` / `--results` / `--profile rerun-2000` /
`--c0` / `--seeds` / `--label` を受け付ける前提です。旧版の cwd で子プロセスを起動し、
fixtures と results はこの worktree の絶対パスを渡します。版の切り替えは行いません。
各 CLI を `npx tsx <script> ...` 相当の子プロセスで直列実行します。Windows はシェル経由の文字列展開を避け、
npm 同梱の `npx-cli.js` を Node で起動します。親の環境変数をそのまま渡し、`.env` は子 CLI が読みます。
`freeze` / `run` を含む通常実行（`all` も対象）は、開始時に親の `GEMINI_API_KEY` を確認し、未設定なら子を起動せず停止します。
環境変数に設定するか、`$env:NODE_OPTIONS='--require=dotenv/config'` で worktree ルートの `.env` を親にも事前読み込みします。
別の場所の `.env` は `$env:DOTENV_CONFIG_PATH='<絶対パス>'` で指定します。`score` のみと `--dry-run` はキーを確認しません。

[再評価計画 §9](../../docs/query-optimization-rerun-plan.md) の順で進めます。

1. **準備**: 設定と旧版パッチを用意し、`npm run eval:rerun -- all --dry-run --legacy-dir <絶対パス>` で行列を確認します。
   `--dry-run` は子を起動せず、実行 ID・引数配列・保存先・スキップまたは未準備の理由を表示します。
2. **ケースの凍結**: 上の選定手順、CASES 登録、`npm run eval:prepare`、gold の監査を行い、
   `npm run eval:rerun -- prepare` で 2 つ目以降のシード分割を準備します。選定記録と fixture を版管理します。
3. **C0 の凍結**: `npm run eval:rerun -- freeze`。criteria-only はケースごとに枠を持ち、両分割で共有します。
   seeded はケース・分割ごとに枠を持ちます。ログに「実測できない C0 は凍結しない。再生成するには --draft で別番号を指定する」がある失敗だけを生成物の失敗として数え、別の空き番号で再試行します。成功・生成物の失敗の直後に
   `rerun/c0-slots.json`（コミット対象）を一時ファイル + rename で保存します。各枠の上限は `maxDraftAttempts`。
   それ以外の失敗は attempts に記録せず、番号を進めずその枠を今回打ち切り、次回に同じ番号から再試行します。ledger・ログ・終了集計には失敗として残します。過去の試行記録は変更しません。
   実測エラーがすべて恒久エラーの場合だけ試行を消費します。一時的な通信障害が 1 つでも混ざれば、同じ番号で再試行できます。
   再試行待ち番号は同じ JSON の `pendingDraft` に保存し、他の枠での使用を防ぎます。
   凍結後は `rerun/c0-slots.json` も凍結 C0 と一緒にコミットします。
   上限到達時は停止理由を確認して対処します。割当済み C0 が存在する枠は再凍結しません。
4. **パイロット**: `--filter` は実行 ID の部分文字列、`--limit` は実際に実行する試行数の上限です。
   例えば `npm run eval:rerun -- run --filter current:r3-vascular-bleeding:criteria-only-draft11 --limit 1`。
   旧対比較は `legacy:r3-vascular-bleeding:criteria-only-draft11`、旧通しは `legacyLive:r3-vascular-bleeding:live-1`
   を指定します（実際の凍結名を使用）。`score` と `eval:rerun-report` まで通し、実費を確認します。
5. **本実行**: `npm run eval:rerun -- run --legacy-dir <絶対パス>`。ケースごとに current → legacy → legacyLive の順です。
   current は `oracleRounds` を渡します。基本 run が failed の場合、oracle のラウンドを始めません。
   期待する `run.json` が completed で、実行先チェックアウトの HEAD（取得不能は不可）、`maxHits`（current は default、旧版は 2,000）、
   current の `oracleRounds`（欠落は 0）が要求と一致する場合だけスキップします。条件不一致は子を起動せず失敗にし、
   label の変更を求める理由を ledger とログに残します。dry-run でもスキップ・条件不一致・実行を表示します。
   失敗は次の実行へ進み、失敗があれば終了コード 1。
   `all` は prepare → freeze → run → score を順に実行します。filter / limit は全段階に共通で、limit は all 全体の上限です。
6. **報告**: `npm run eval:rerun -- score` で旧版の有害採用を採点し、`npm run eval:rerun-report` で集計します。
   採点には追加の NCBI 計測がありえますが、rerun-report はローカルファイルだけを読みます。
   監査の `trials[].error` または `unscoredAdopted > 0` は失敗として表示し、`scored.json` を保存せず終了コード 1 にします。
   この印がある既存採点は再採点し、正常な既存採点は同じコミットならスキップ、別コミットなら上書きせずエラーにします。
   `--config <path>` は両 CLI に指定できます。

各試行の `ledger.jsonl` は実行 ID ごとの最終行勝ちです。標準出力・標準エラーは
`results/rerun/logs/<安全な ID>-<sha256 先頭8桁>.log` へマスクして追記します。
dry-run 以外の起動時に一度、ledger の末尾に改行がなければ最後の改行より後ろを除き、一時ファイル + rename で修復します。
修復したことだけを 1 行表示し、取り除いた中身は表示しません。
終了時は実行 0 件でも「完了 / スキップ / 失敗」の件数と失敗 ID を表示します。
途中の凍結失敗が再試行で回復した場合も、そのコマンドの失敗試行として終了集計に残ります。

集計は `results/rerun/summary.md` と表ごとの CSV に出します。設定・C0 枠から期待する全 run を列挙し、
未実行は「欠測」、失敗は「失敗」として保持します。旧版の `scored.json` は source が runId と一致する場合だけ使います。
層 A は criteria-only の版ごとの C0 / C1 分布（role 小計付き）、層 B は凍結 C0 の対比較と実名の喪失・獲得、
層 C は取りこぼし・提示・回収・確認負担・未提示再現率（role 小計付き）です。C0 枠の品質と費用も別表にします。
費用は既存の `llmUsage` を優先し、無い run は `run.json` と同じ階層の `<runId>/` から `llmLogs` を読み、
現行と同じ `createLlmUsageTracker`・単価表で復元します。ログの欠落・破損は 0 円にせず `costMissing` 等の欠測に数えます。
`costFromLogs` は使用量を復元した run 数（価格表外・トークン不明による費用欠測も含む）で、算出方法を `summary.md` に注記します。

S1 は新有害採用 0 を機械判定し、旧有害採用のあった C0 の同種候補の保留・却下は手動照合表に出します。
S2 は喪失した組の `原因` を空欄にして「要手動分類」とし、調整ロジック起因 0 の確認を人に残します。
S3 は中央値が旧以上のケースが**過半数**、S4 は development / confirmation の各 1 ケース以上の回収です。
S5 は achieved かつ C1 再現率 1 未満の run における「確認済み」の割合を報告し、合否の数値閾値を追加しません。
画面の区分を作らないハーネスのため、確認負荷が ready かつ total=0 を「確認済み」の近似として注記します。
欠測が判定を妨げる場合は「欠測で判定不能」とします。

`.gitignore` は `experiments/query-optimization-bench/results/` を無視しています。
`fixtures/_selection/` と `rerun/config.json` と `rerun/c0-slots.json` は**コミット対象**です（判断ファイルと凍結した選定結果も含む）。
枠記録は `rerun/c0-slots.json` を優先し、無い場合だけ旧 `results/rerun/c0-slots.json` を読み、次の保存時に新パスへ移行します。ledger と logs/ は従来どおり `results/rerun/` に保存するので、再開・報告のため実行環境で保持してください。
