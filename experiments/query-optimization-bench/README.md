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

凍結前に各ブロック（結合行を除く）と式全体を厳密件数モードで実測し、構文エラー（実在しない MeSH 見出しによる phrase not found 等）を含む例外があれば、失敗箇所と原因をまとめて報告して凍結しない。0 件は凍結を妨げず、再生成するには `--draft` で別番号を指定する。

C0（初期式生成）は毎回 LLM で作り直すため、実測 hits が実行間で数倍ぶれることがある。**再生成された C0 どうしの差を自動調整ポリシーの効果として解釈してはいけない**。この揺れを切り離すため、C0 を一度生成してハッシュ付きで凍結し、複数回の `eval:optimize` で使い回せるようにしてある。

```powershell
# criteria-only: 適格基準だけから C0 を作る（従来の C0 と同じ入力）
npm run eval:freeze-c0 -- --case r1-mindfulness-smoking --variant criteria-only
# seeded: 凍結シード（既定分割）のタイトル・抄録・MeSH も渡して C0 を作る
npm run eval:freeze-c0 -- --case r1-mindfulness-smoking --variant seeded
npm run eval:freeze-c0 -- --dry-run --case r1-mindfulness-smoking --variant seeded
```

- 出力は `fixtures/<case>/c0/<variant>-draft<n>.json`（既定シード分割のときは接尾辞なし。既定以外の分割だけ `-<splitId>` を付ける。例: `seeded-draft1-s42.json`）。`--draft <n>`（既定 1）で同じ条件の複数ドラフトを別ファイルに残せる
- 既存ファイルは上書きしない（`wx`）。作り直したいときは手動で削除してから再実行する
- 内容には `caseId` / `variant` / `draftIndex` / `seedSplit`（seeded は既定分割でも `s20260912` を記録する。ファイル名の接尾辞省略とは別の話） / `targetHits`（常に 2,000）/ `model` / `gitCommit` / `gitDirty` / 生成した `protocol` / `blocks` / `formula` / `formulaMd` / `seedContext` を保持し、これらから計算した `sha256` を同梱する
- seeded で凍結シードの一部を efetch で取得できなければ（NCBI 側の一時的な欠落等）、空の `seedContext` にフォールバックせず失敗させる。「seeded を名乗るが実質シード無しの C0」を静かに凍結しない
- criteria-only の凍結・取り込みではシードファイルを読み込まず、`--seeds` の同時指定は意味が無いため拒否する
- `--seeds <int>` は分割の乱数そのもの。ファイル内の `seed` が要求値と食い違っていれば（手動編集・コピー間違い等）実行前に拒否する
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

`--label <name>` は任意で 1 回だけ指定でき、英数字・`.`・`_`・`-` の 1〜40 文字（`^[A-Za-z0-9._-]{1,40}$`）に限る。ラベルを付けると保存先は `results/<profileId>/<caseId>/<c0Key>/<splitKey>+<label>/run.json` となる。ラベル無しは従来の `<splitKey>/run.json` のまま。ラベルは子ディレクトリにせず分割名に連結するため、ラベル無し結果と併存しても report が両方を読む。`RunResult.label` にも記録し、dry-run は `label=` を表示する。

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

```powershell
npm run eval:import-c0 -- --case r2-pdr-prognostic --variant criteria-only --formula ./search_formula.md --draft 2 --dry-run
# 本実行には Gemini / NCBI への通信が必要
npm run eval:import-c0 -- --case r2-pdr-prognostic --variant criteria-only --formula ./search_formula.md --draft 2
npm run eval:import-c0 -- --case r2-pdr-prognostic --variant seeded --formula ./search_formula.md --seeds without-one --draft 2
```

`--draft` は既定 1、seeded の `--seeds` は整数・名前付き集合の両方に対応します。seeded は通常の凍結と共通の efetch → シード文脈構築を使い、部分欠落でも停止します。凍結前の非結合ブロックごと＋式全体の ESearch（`retmax: 0`、構文エラー時は停止）も共通です。

出力名・ハッシュ・上書き禁止（`wx`）・LLM ログ保存先は `eval:freeze-c0` と同じです。生成済みファイルがある場合は別の `--draft` 番号を指定してください。由来として `source: "import"` と `sourceFilename`（元ファイルのベース名）をハッシュ対象に含めます。これらは取り込み時だけ追加する任意フィールドで、既存 C0 に補完しません。従来の凍結ファイルのハッシュは変わらず、取り込んだ C0 も `eval:optimize -- --c0 <拡張子なしの名前>` で読めます。

`--dry-run` は通信・書き込みをせず、式のパースと参照展開、seeded のシード検証、出力先を表示します。LLM 抽出とのブロック数照合・NCBI の実測は本実行まで未検証です。

**issue #106 の受け入れ基準（R2 の危険な削除を自動採用しないこと／未捕捉シード 913749 の阻害ブロックを特定できること）の実 API 検証は未実施です。** ここでは再現用入力を指定する手段を用意するところまでとし、基準の判定は API キーとネットワークを使える環境で別途行います。

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

再現率の分母は全研究数または held-out 群に属する研究数、分子は捕捉研究数です。喪失・追加の一覧も研究名で出力します。既知組入研究当たりのレコード数は hits / 捕捉研究数です。指標の分母 0 は null。捕捉 0 で hits>0 の既知組入報告割合は 0、既知組入研究当たりのレコード数は null です。改善は C0 の held-out 捕捉を一つも失わず、held-out 捕捉研究が増えるか hits が減る場合に限定します。捕捉喪失と hits 減少は tradeoff として記録します。

B1 は任意の `fixtures/<id>/b1.json` に `{ "query": "展開済みの PubMed 検索式" }` として与えます。変換根拠は `b1.md` に残してください。存在すれば同じ分母と日付で実行し、無ければ summary の B1 は「欠測」です。完了後に B1 を追加した場合は report に式と「未計測」が表示されます。自動で実 API を再実行しません。

集計は条件列（profile）を先頭に付け、全条件を `results/summary.md` と `results/summary.csv` にまとめます。列には `role` / `c0`（`live` または `frozen:<name>`） / `seedSplit` / `maxHits` / `gitCommit` / `label`（gitCommit の隣）も含みます。`resultsDir` 配下は「その系列で最初に見つかった run.json」を再帰的に集めるだけなので、旧レイアウト `results/<caseId>/run.json`・現行 `results/<profileId>/<caseId>/run.json`・新レイアウト `results/<profileId>/<caseId>/<c0Key>/<splitKey>/run.json` のいずれも読めます（profileId が無ければ `default` として扱います）。既存の結果の移動・削除は行いません。

### 有害採用・確認負荷・LLM コストの計測

- **有害採用（`adoptionAudit`）**: C0→C1 の間に採用されたすべての候補（`optimization.trials` の `kind: 'proposal'` かつ `accepted: true`）について、**採用直前の基準式**（その候補より前で最後に採用された候補、無ければ C0）と比べて held-out 捕捉を失っていないかを監査する。1 件でも held-out を失った採用を「有害な採用」（`harmfulAdopted`）と数える。C0 の測定・却下候補の既存計測（`rejectedCandidates`）・C1 の測定は再利用し、同じ gold クエリを重複して投げない。`manualReviewPending` のときは採点そのものを保留する（`harmfulAdopted: null`）。比較元または候補自身の metrics が無く比較できなかった採用件数を `unscoredAdopted` に記録し、1 件以上あれば `harmfulAdopted: null`（未採点）とする。候補自身の測定失敗や比較元の欠測は原因を `error` に記録し（手動監査待ちだけの場合を除く）、`lostHeldOut: []` を「0 件確定」とは読まない
- **確認負荷（`confirmation`）**: 最良式（`best`）があり、自動調整の `status !== 'error'` のとき（`stopped` も含む）、`searchOutsideCandidates`（`#/expand` の margin 探索と同じ処理）で「人が確認すべき候補」の件数だけを数える。**候補は自動調整へ一切フィードバックしない**（採否も readjustment もしない）。`existingPmids` には常にシード PMID だけを渡し、gold（held-out を含む）は渡さない。gold への対応付け（`heldOutStudiesAmongCandidates` / `nonGoldCandidates`）は、検索・LLM 呼び出しがすべて終わったあと、この集計のためだけに事後に行う。`total` は outside 候補と、held（レビュー保留）だった候補の `impact.inspected`（シード PMID を除く）を合わせて重複除去した件数。outside check 自体の失敗は `status: 'error'` を記録するだけで run を failed にはしない
- **LLM 使用量とコスト（`llmUsage`）**: `loggedFactory` の呼び出し 1 回（リトライの各試行を含む）ごとに tokensIn/tokensOut を積算し、`src/lib/llm/pricing.ts` の単価表でコストを概算する。失敗した呼び出しも `calls` に数える（トークンは加算しない）。価格表に無いモデルの呼び出しが 1 回でもあれば `costUsd` は恒久的に `null`（`unpricedCalls` で件数を確認できる）。失敗呼び出し（トークン無し）は 0 円加算として扱い、それだけでは `costUsd` を null にしない。成功しても tokensIn/tokensOut が両方 null なら `untrackedCalls` を増やし、`costUsd` は恒久的に null とする。cost 列は「欠測（価格表外 N 件）」「欠測（トークン不明 N 件）」で原因を区別し、両方あれば併記する。llmUsage の無い古い記録は従来どおり「欠測」
- summary.md の後半に **頑健性の集計**（`role` / `profile` / `case` / C0（`live` または `variant`） / シード分割 / `label` / `gitCommit` ごとにグループ化した run 数・C0 hits / C1 hits / C1 heldOutRecall の min・median・max・outcome 件数・`harmfulAdopted` 合計・`confirmationTotal` の中央値）を出す（`results/summary-aggregate.csv` にも同じ内容）。`c0` が `live` の行は run ごとに C0 が再生成されるため、行内の散らばりを自動調整ポリシーの効果と解釈しない注記を付ける。`seedSplit` の後ろに `label`（無ければ `-`）・`gitCommit`（先頭 12 文字、無ければ「欠測」）列を置き、この値でコード版を分ける。同じ凍結 C0 の variant 内で `c0.id` が複数なら「複数ドラフト（N 種）を含む。散らばりには C0 の違いが混ざる」と注記する

## 解釈の限界

これは現在の PubMed に作成日上限を適用した後ろ向き評価で、当時の検索の再現ではありません。完成後の Methods、現在の索引、LLM の学習混入、PMID のある既知研究への限定が残ります。ブロック自動承認の影響の向きは不明です。3 ケース・固定分割 1 回から新規レビューの性能、専門家検索への非劣性、選考時間を主張できません。既知組入報告割合と既知組入研究当たりのレコード数だけで検索効率の優劣を結論しないでください。
