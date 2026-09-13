# 検索式自動調整（#97）の実 API 評価計画

`experiments/query-optimization-bench/` の設計根拠。指標の定義・題材の選定理由・限界をここに置く。
実装の手順は [experiments/query-optimization-bench/README.md](../experiments/query-optimization-bench/README.md) を参照。

## 0. 目的と問い（限定版）

「検索式の自動調整」バックエンドを Cochrane レビュー 3 件に対して実 API（Gemini + NCBI E-utilities）で
走らせ、**ハーネスの弱点を見つけて改善につなげる**ための形成的評価を行う。性能証明ではない。

- **Q1**（限定）: **完成レビューから抽出した適格基準**を入力したとき、AI ドラフト検索式は
  既知の組入研究をどれだけ捕捉するか。※「事前プロトコルから」ではない（§7）
- **Q2**: 自動調整は C0 から何を改善し、何を壊すか。改善の定義は事前固定（§4-3）
- **Q3**（限定）: 同じ held-out 集合に対して、Cochrane の元検索式を再構成したものと比べて
  捕捉数と件数がどう違うか。**優劣の判定ではなく差の中身を見る**

## 1. 題材 3 件（cc-by・事前確定）

[Cochrane-bench](https://github.com/youkiti/Cochrane-bench) の cc-by gold 62 件に**事前基準**
（組入研究 PMID ≥15 / included∩excluded の重複なし / study 間の PMID 共有なし / PMID 無し組入 ≤3 /
MEDLINE 検索式あり・最終行が AND で閉じる / 更新検索でない / needs_review でない）で機械的にふるいをかけ、
通った 3 件に、行動介入という難しさを持つ PMC9009295（共有 PMID 1 件のみ・群統合で対処可能）を足して確定した。
**結果が悪いことを理由に事後に差し替えない。**

| | PMCID / CD | テーマ / デザイン | 組入 study（PMID あり） | 分割群 | held-out（研究数） | 元 MEDLINE 式 | 検索日 |
|---|---|---|---|---|---|---|---|
| R1 | PMC9009295 | マインドフルネス禁煙（行動介入 RCT） | 21 (18) | 17 | 15 | Ovid 18 行 | 2021-04-15 |
| R2 | PMC9943918 | 増殖糖尿病網膜症の予後因子（コホート） | 59 (57) | 57 | 54 | Ovid 74 行 | 2022-05-27 |
| R3 | PMC9936832 | 大血管・血管内手術の出血減少薬（薬剤 RCT） | 22 (19) | 19 | 16 | Ovid 132 行（`raw_text` から再分割） | 2022-03-31 |

R1 だけ分割群（17）と研究数（18）が食い違う。これは共有報告による統合の結果で、**分割は群単位・採点は研究単位**という
§3-2 の規則から出てくる差である（held-out は「3 群をシードに使った残り」なので、群では 14、研究では 15）。

監査で確認済みの素性:

- R1: included∩excluded の重複なし。PMID `24963659` が davis 2014a / 2014b の両方に対応 → §3-2 の群統合で処理
- R2: 重複なし・共有なし。PMID 無しは 2 件。分母 57 と最大で、1 研究あたり 1.9 ポイントと粒度が細かい
- R3: 重複なし・共有なし。検索式は parsed では 1 行に連結されているが `raw_text` に 132 ステップ全文があり
  `132. 104 and 131` で閉じている（機械的に再分割可能）
- 却下: PMC10164701（19 件中 7 件が PMID 無し・included∩excluded 重複 2 件が同一 study 対にまたがる）、
  PMC5865125（2012/2013/2017 の 3 段の更新検索）、PMC11384553（2012 年以降の更新検索・集合参照）、
  PMC11110109（cc-by-nc、かつ PubMed 式に最終 AND が無い）

3 件とも Ovid 構文なので、B1 は 3 件すべてで手動変換が要る（§5）。

## 2. 評価対象のコードパス

- `runQueryOptimization` — [src/app/services/queryOptimizationService.ts](../src/app/services/queryOptimizationService.ts)
  （依存はすべて注入。`chrome.*` / Sheets / DOM 非依存）
- `generateDraftFormula` — [src/app/services/draftService.ts](../src/app/services/draftService.ts)（保存副作用なし）
- `extractProtocol` — [src/features/formula/skills/extractProtocol.ts](../src/features/formula/skills/extractProtocol.ts)
- `GeminiProvider` — fetch のみ。`eutils.ts` がレート制御・バックオフ・strictCounts を持つ

Node 実行のための小修正:

1. MeSH 文脈取得を `bootstrap.ts` のインラインクロージャから `src/app/services/meshContextService.ts` へ切り出し
   （拡張本体とハーネスが同じコードを通るようにする）
2. `tsx` を devDependency に追加（`@/` エイリアス解決）
3. シードのタイトルは esummary(JSON) で取得（`efetchArticles` は `DOMParser` 依存）

## 3. 実験デザイン

### 3-1. 1 ラン（= 1 レビュー）の流れ

```
Cochrane-bench parsed JSON
  └─ protocol.md（title + objectives + eligibility 4 項目）
       ※ search_methods_text・検索式・結果節は入れない
  ↓ extractProtocol（LLM）
  ↓ ブロックは自動承認（人の承認工程はスキップ。影響の向きは不明とだけ記す）
  ↓ generateDraftFormula → C0
  ↓ runQueryOptimization（seeds = 3 群, maxHits 既定プロファイルは 2,000, maxIterations 5）→ C1
```

**実行規模: 3 レビュー × シード分割 1 通り × 1 反復 = 3 ラン。** 目的がハーネスの弱点発見なので、
分散推定より 1 ケースを深く見る（trial 履歴・採否理由・失った研究を全部残す）。
LLM の出力変動もシード選択への頑健性も、この設計では測っていない。

**C0 の再生成による揺れと、その切り離し（凍結 C0）**: C0 は毎回 LLM で作り直すため、実測 hits が
実行間で数倍ぶれることを確認した。**再生成された C0 どうしの差を自動調整ポリシーの効果として
解釈してはならない**。この揺れを条件間比較から切り離すため、`eval:freeze-c0` で C0 を一度生成して
ハッシュ付きで凍結し、以後の `eval:optimize -- --c0 <name>` はハッシュ検証つきでその内容を
再利用する（実装は [experiments/query-optimization-bench/README.md](../experiments/query-optimization-bench/README.md) の
「凍結 C0 とシード分割」節）。凍結には 2 種類の variant がある:

- **criteria-only**: 適格基準だけから C0 を作る（従来の C0 と同じ入力）
- **seeded**: 適格基準に加え、凍結シード（3 群）のタイトル・抄録・MeSH も渡して C0 を作る

凍結前に各ブロック（結合行を除く）と式全体を厳密件数モードで実測し、構文エラー（実在しない MeSH 見出しによる phrase not found 等）を含む例外があれば、失敗箇所と原因をまとめて報告して凍結しない。0 件は凍結を妨げず、再生成するには `--draft` で別番号を指定する。

C0 の目安件数（`targetHits`）は凍結時点で `DEFAULT_OPTIMIZATION_MAX_HITS`（2,000）に固定し、
実行時の `--profile`/`--max-hits` に依存させない。これにより同じ凍結 C0 を複数プロファイルの
比較に使い回せる。**凍結していない（`live` な）C0 どうしを条件間で比較しない**。

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

### 3-2. gold 監査と分割（先に凍結）

1. **研究群の構築**: study 間で PMID を共有する study を 1 群にまとめる。群は分割で同じ側に置く
2. **採点時に群を機械的に 1 研究と数えない**。真に別研究か対応付けの誤りかは目視判定し記録する。
   **分割の単位は群、採点の単位は研究**とする（ある研究は、自分に属する報告が 1 件でも捕捉されれば捕捉とみなす）

   R1 の判定（2026-09-12）: **Davis 2014a と Davis 2014b は別研究**である。
   2014a は N=196・対照は Wisconsin Tobacco Quit Line の電話カウンセリング・実施 2010-13 年、
   2014b は N=135・対照は American Lung Association の Freedom From Smoking・実施 2011-12 年で、
   標本も対照も異なる 2 本の RCT。両者が共有する PMID 24963659 は
   「Hair cortisol as a biomarker of stress in mindfulness training for smokers」という
   **両試験にまたがる副次報告**である。したがって 2 研究は分割では同じ側に置き、採点では 2 と数える
3. **分母は検索式と独立に先に確定**する。C0・C1・B1 が見つけた研究だけを分母にしない
4. **シード = 3 群**（代表 PMID は「その群で最も古い出版年、同年なら PMID 昇順」と事前規則化）。
   乱数固定で `fixtures/<id>/seeds.json` に凍結し、以後再生成しない
5. **held-out = 残りの全群**
6. 除外理由（PMID 無し / 日付範囲外 / 対応未確定）は理由別の別表にして本文の分母から外す

### 3-3. 検索環境（日付）

`datetype=crdt`（レコード作成日）の上限を検索日に置き、**ハーネスの fetch ラッパが `db=pubmed` の
esearch にだけ付与**する（式には書かない＝自動調整の禁止事項と衝突させない）。
`edat` は、出版から 12 か月超で追加されたレコードで EDAT が出版日になることがあり、検索日後に追加された
古い論文が制限を通過するため使わない。

**これは「当時の検索の再現」ではない**（現在の MeSH・修正済み抄録・現在の索引を使う）。
報告では「現在の PubMed に作成日上限を適用した後ろ向き評価」と呼ぶ。gold とシードにも同じ範囲を適用する。

### 3-4. 条件

| 条件 | 内容 | 扱い |
|---|---|---|
| C0 | AI ドラフト（`live`: その場生成 / `frozen`: `eval:freeze-c0` で凍結した fixture） | C1 の出発点として同一ランのものを対応付けて比較。**条件間比較は frozen（sha256 一致）でしか成立しない** |
| C1 | C0 → 自動調整 | 「既知シード 3 件を与える自動調整工程全体」の追加効果 |
| B1 | Cochrane 元 MEDLINE 式を再構成して PubMed 実行 | 「専門家作成検索の**再構成参照**」。上限や正解ではない |
| B0 | 論文報告のスクリーニング件数 | **比較表から外し背景情報として併記のみ**（全 DB 合算・重複除去後で土俵が違う） |

## 4. 指標

共通コーパス $U$ = 作成日上限付き PubMed。$G_U$ = $U$ 内で検証済み関連 PMID を 1 件以上持つ組入研究群。
$H$ = $G_U$ からシード群を除いたもの。$R$ = 検索結果。

### 4-1. 主要

| 指標 | 定義 |
|---|---|
| **held-out 相対再現率** | $H$ のうち関連報告を 1 件以上捕捉した群数 ÷ $|H|$ |
| **hits** | $|R|$ |
| **失った研究 / 得た研究** | C0 → C1 で捕捉から落ちた / 増えた群の実名リスト |

### 4-2. 補助（名前を変えて誤読を防ぐ）

- **既知組入報告割合**（`knownIncludedReportShare`）= 捕捉した gold PMID 数 ÷ $|R|$ — 旧称 precision
- **既知組入研究当たりのレコード数**（`recordsPerKnownIncludedStudy`）= $|R|$ ÷ 捕捉した既知研究数 — 旧称 NNR
- 全 study 相対再現率（シード込み・参考）、status / stopReason / 反復数 / API コール数 / 所要時間

**この 2 つで検索効率の優劣を結論しない。** gold に無い適格文献を多く拾った式が分母だけ増えて
不当に低く出るため、下限同士の順位は真の適合率の順位を保証しない。絶対 precision の主張はしない。

### 4-2-1. 有害採用・確認負荷・LLM コスト

形成的評価として、平均再現率だけでなく「失った/回復した研究の実名」「有害な採用候補数」
「ユーザー確認項目数」「API 呼び出し数 / コスト」も残す。実名の喪失/回復リストは 4-1 の
Comparison（`lostStudies`/`gainedStudies`/`lostHeldOut`/`gainedHeldOut`）で既に満たしている。
残り 3 つをこのハーネスでは次のように実装する。

- **有害採用（`adoptionAudit`）**: C0→C1 の間に採用されたすべての候補（`kind: 'proposal'` かつ `accepted`）を、
  **採用直前の基準式**（その候補より前で最後に採用された候補、無ければ C0）と比較し、held-out を 1 件でも
  失った採用を有害採用として数える。既存の C0/C1/却下候補の測定は再利用し、gold 検索を重複させない。
  `manual_review` のケースは採点そのものを保留する（`harmfulAdopted: null`）。比較元または候補自身の metrics が無く比較できなかった採用件数を `unscoredAdopted` に記録し、1 件以上あれば手動監査待ちでなくても `harmfulAdopted: null`（未採点）とする。測定失敗や比較元欠測の原因は trial の `error` に残す（手動監査待ちだけの場合を除く）
- **確認負荷（`confirmation`）**: `#/expand` の margin 探索（`searchOutsideCandidates`）を C1 の最終式に対して
  最良式（`best`）があり、最適化の `status !== 'error'` の場合（`stopped` も含む）に実行し、**人が確認すべき候補の件数だけを数える**。最良式が無いか `error` なら skipped とする。この集計は候補を自動調整へフィードバックしない
  （採否判定も readjustment もしない）。`existingPmids`（=「既に知っている」として除外する集合）には
  常にシード PMID だけを渡し、gold（held-out を含む）は渡さない。gold への対応付けは、検索・LLM 呼び出しが
  すべて終わった後、この集計のためだけに事後に行う。これは「outside check の判断材料」と
  「最終的な held-out 採点」を混同しない、という設計上の境界線である
- **LLM コスト（`llmUsage`）**: すべての LLM 呼び出し（リトライの各試行を含む）の tokensIn/tokensOut を
  積算し、`src/lib/llm/pricing.ts` の単価表で概算する。価格表に無いモデルを 1 回でも呼べば `costUsd` は
  恒久的に null（`unpricedCalls` で件数を示す）。失敗呼び出しは calls に数えるが、トークンが取れない
  （0 円扱いになる）だけでは costUsd を null にしない。成功呼び出しで tokensIn/tokensOut が両方 null なら
  `untrackedCalls` を増やし、costUsd は恒久的に null とする。report の cost 列は「欠測（価格表外 N 件）」/
  「欠測（トークン不明 N 件）」で原因を区別し、両方なら併記する。llmUsage の無い古い記録は「欠測」のまま

実装は [experiments/query-optimization-bench/adoptionAudit.ts](../experiments/query-optimization-bench/adoptionAudit.ts) /
[confirmationAudit.ts](../experiments/query-optimization-bench/confirmationAudit.ts) /
[llmUsage.ts](../experiments/query-optimization-bench/llmUsage.ts)、詳細は
[experiments/query-optimization-bench/README.md](../experiments/query-optimization-bench/README.md) の
「有害採用・確認負荷・LLM コストの計測」節を参照。

頑健性の集計は role・profile・case・C0 variant・シード分割に加え、`label`（無ければ `-`）と
`gitCommit`（先頭 12 文字、無ければ「欠測」）でグループ化し、`seedSplit` の後ろに両列を置く。
個々の run の表にも gitCommit の隣に label 列を置く。live の再生成に関する既存注記は保持する。
凍結 C0 のグループで `c0.id` が複数混ざる場合は「複数ドラフト（N 種）を含む。散らばりには C0 の違いが混ざる」と注記する。

### 4-3. 「改善」の事前定義（Q2 の判定規則）

> **C0 で捕捉していた held-out 群を 1 つも失わず、かつ 捕捉群が増えるか hits が減る**場合を改善とする。

捕捉を失って hits も減った場合は改善と一括せず `tradeoff` として両方の数字を出す。
`maxHits` は事前登録した `default` プロファイルの 2,000（アプリ既定 `DEFAULT_OPTIMIZATION_MAX_HITS`）で
固定し、gold の成績を見て動かさない。`--max-hits <n>` による事後探索（`custom-<n>`）は
事前登録の対象外で、`tight-1000` と同様に確認的な結果としては扱わない。
`achieved`（サービスの条件達成）はシード捕捉と件数上限の達成であって held-out への一般化ではない。

### 4-4. 採点実装の注意

- ESearch の既定 `retmax` は 20。捕捉 PMID は `retmax` を明示して全件取得する
- 「正当な 0 件」「捕捉 0 件」「API 失敗」を区別し、失敗を集計から落とさない

## 5. B1 の再構成（3 件とも Ovid → PubMed）

- `raw_text` から行を再分割し、`or/62-72` のような範囲参照・行番号参照を括弧付きで完全展開してから変換
- 変換規則: `exp X/` → `"X"[Mesh]`、`X/` → `"X"[Mesh:noexp]`、`.tw.` → `[tiab]`、`.kw.`/`.kf.` → `[ot]`、
  `adj{n}` → 近接演算子、`$`/`*` → `*`、`.pt.` → `[pt]`、`.sh.` → `[sh]`
- **検証はヒット数の桁一致では行わない**（集合が違っても件数は似る）。フィールド指定・展開・近接・
  Boolean 結合を 1 行ずつ突き合わせ、変換表と判断根拠を `fixtures/<id>/b1.md` に残す
- **変換を held-out 成績に合わせて調整しない**（成績を見る前に確定・凍結する）
- 検証できなければその レビューの B1 は欠測として扱い、C0/C1 のみ報告する

## 6. 実行時の規約

`batch-network-jobs` の規約に従う: 1 ランごとに即永続化・未処理分だけ再開・LLM のプロンプト/レスポンス全文を
ローカル保存・**URL はマスクしてログ**（`api_key` と Gemini の `?key=` が載る）・NCBI はキー無し 3 req/s で
1 プロセス直列・0 件や失敗でも 1 行ログ。

見積もり: 1 ラン 150〜250 NCBI コール、3 ラン ≒ 600 コール、最適化の時間予算 10 分/ラン。

## 7. リーク・汚染（残るもの）

- **入力は完成レビューの Methods** であり、選考後の改訂を含む。R1 は「組入研究が報告していたので
  positive/negative affect を追加した」と*プロトコルからの変更*に書いており、その記述が入力に入る。
  → Q1 を「完成レビューから抽出した適格基準による再探索」と限定して報告する
- 公開済みレビュー・検索式が **LLM の学習に含まれている可能性**は排除できない
- シード 3 件は「適格な既知研究を 3 件持っている状況」の評価であり、それをどう入手するかは評価していない

## 8. 報告で書ける主張の強さ

> 事前選定した 3 レビューについて、指定した既知研究・入力・モデル・検索環境の下で自動調整前後を比較した。
> held-out の既知組入研究に対する相対再現率と検索件数に、ケースごとに以下の変化を認めた。
> 結果は後ろ向きの探索的ケース評価であり、新規レビューでの性能や専門家検索への非劣性を示すものではない。

必須の報告事項: 分母確定の過程と gold 修正内容 / 全ランの捕捉数・分母・hits・C0→C1 の増減と失敗 /
入力・プロンプト・モデル ID と設定・検索式・検索日時・日付条件・停止規則 /
学習混入と完成後 Methods の利用と現在の索引による後ろ向き評価と PMID 付き研究への限定 /
hits は検索結果件数であって人の選考時間やレビューの結論の正しさを測っていないこと。

**「人の承認を省いたので実運用より不利」とは書かない**（影響の向きは分からない）。
