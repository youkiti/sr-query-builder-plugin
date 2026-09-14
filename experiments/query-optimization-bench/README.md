# 検索式自動調整のケース評価

完成した Cochrane レビューの適格基準から C0 を生成し、既知シード 3 群を与えた自動調整後の C1 と比較する Node ハーネスです。目的はハーネスの弱点を見つける形成的評価です。評価の根拠は [評価計画](../../docs/query-optimization-bench-plan.md) を参照してください。

## 前提と出典

Node 18 以上、既存の開発依存（tsx / dotenv）が必要です。Chrome・Sheets・DOMParser は使用しません。
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

実行時だけルート `.env` を dotenv で読みます。`GEMINI_API_KEY` が必須、`NCBI_API_KEY` は任意です。キーをコマンドラインへ書かないでください。モデルは GeminiProvider の既定値を使用し、実際のモデル ID と各呼び出し設定を保存します。条件は `types.ts` に事前登録した `PROFILES` から `--profile <id>` で選びます。未指定は `default`（maxHits=10,000、maxIterations=5）、追加条件は `tight-1000`（maxHits=1,000、maxIterations=5）です。任意の数値は渡せず、未知の ID はエラーになります。1 プロセスでケースを逐次実行してください。NCBI の共有レート制御はキー無しで 3 req/s です。

dry-run は環境ファイルも API も使わず、全 fixture・サービスの import・provider と checkpoint の配線を確認します。LLM 出力を使う処理の実行確認ではありません。実行結果を上書きせず、完了マーカーも作りません。Jest はモックとローカル fixture のみを使います。

`tight-1000` は default の結果を見てから追加した事後探索（post-hoc）の条件です。事前に定めた `default` とは解釈の強さが異なり、確認的な結果として同等には扱えません。

```powershell
npm run eval:optimize -- --profile tight-1000
```

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

ケースの各段階で `results/<profileId>/<caseId>/run.json` を更新し、同じ条件の完了ケースは再実行時にスキップします。別条件の完了結果はスキップ判定に使いません。失敗ケースは次の実行で最初からやり直し、他ケースを止めません。最適化の途中からの再開ではありません。再実行履歴は `results/<profileId>/<caseId>/<runId>/` に残り、その下の `llm/` に呼び出し単位（リトライ含む）の目的・モデル・プロンプト・応答全文・トークン・所要時間、`progress.jsonl` に進捗・API 通信・最終状態を保存します。run.json の llmLogs はこの runId ディレクトリからの相対パスです。

API コール数は実 fetch 回数、API 所要時間は fetch の応答までの合計です。ケースの elapsedMs は待機・処理時間込みです。サービス内の apiCalls は別の予算単位なので optimization の中へそのまま残しています。URL の api_key/key および環境変数のキー値は保存前にマスクします。

再現率の分母は全研究数または held-out 群に属する研究数、分子は捕捉研究数です。喪失・追加の一覧も研究名で出力します。既知組入研究当たりのレコード数は hits / 捕捉研究数です。指標の分母 0 は null。捕捉 0 で hits>0 の既知組入報告割合は 0、既知組入研究当たりのレコード数は null です。改善は C0 の held-out 捕捉を一つも失わず、held-out 捕捉研究が増えるか hits が減る場合に限定します。捕捉喪失と hits 減少は tradeoff として記録します。

B1 は任意の `fixtures/<id>/b1.json` に `{ "query": "展開済みの PubMed 検索式" }` として与えます。変換根拠は `b1.md` に残してください。存在すれば同じ分母と日付で実行し、無ければ summary の B1 は「欠測」です。完了後に B1 を追加した場合は report に式と「未計測」が表示されます。自動で実 API を再実行しません。

集計は条件列（profile）を先頭に付け、全条件を `results/summary.md` と `results/summary.csv` にまとめます。旧レイアウト `results/<caseId>/run.json` も読み、profileId が無ければ `default` として扱います。既存の結果の移動・削除は行いません。

## 解釈の限界

これは現在の PubMed に作成日上限を適用した後ろ向き評価で、当時の検索の再現ではありません。完成後の Methods、現在の索引、LLM の学習混入、PMID のある既知研究への限定が残ります。ブロック自動承認の影響の向きは不明です。3 ケース・固定分割 1 回から新規レビューの性能、専門家検索への非劣性、選考時間を主張できません。既知組入報告割合と既知組入研究当たりのレコード数だけで検索効率の優劣を結論しないでください。

## 旧版ロジックの凍結 C0 比較

`run.ts` に `--fixtures <絶対パス>`、`--results <絶対パス>`、`--c0 <名前>`、`--seeds <非負整数|集合名>`、`--label <名前>` を追加しました。fixtures/results の既定はこのハーネス内です。比較時は `--fixtures` に master の fixtures、`--results` に旧版専用の保存先、`--profile rerun-2000`（最大2,000件・5反復）を指定します。`--case` は指定 fixtures に case.json がある追加ケースも受け付け、検索日はそのファイルから読みます。

`--c0` は `<case>/c0/<名前>.json` のハッシュ・ケース・記録済み分割を検証し、protocol/blocks/formula をそのまま使用します。省略時は従来の生成です。`--seeds` の既定は20260912（seeds.json）、他の整数や名前は seeds-<値>.json を読み、held-out は選択分割から再計算します。`--label` は英数字・ドット・アンダースコア・ハイフンの1〜40文字で、replay- 始まりは禁止です。

保存先は従来の記述に代わり `<results>/<profile>/<case>/<c0名またはlive>/<分割ID>[+<label>]/run.json`、試行は同じ階層の `<runId>/` です。コミット・dirty状態・分割・C0由来・label・legacy=true を記録します。同一コミット・同一上限の完了はスキップし、別コミットの完了は保護、失敗は再実行します。`--dry-run` は通信・書き込みなしで入力を検証し、ケースごとに1行表示します。追加シードの準備は master 側で行います（移植した欠落時メッセージの --seed は旧版 prepare.ts には未対応）。既存の report.ts は新しい深さの保存先を探索しないため、集計側の対応は別途必要です。
