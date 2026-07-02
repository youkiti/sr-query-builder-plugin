# 修正計画（2026-07 レビュー起点）

- **作成日**: 2026-07-02
- **ステータス**: フェーズ 1 完了（2026-07-02）。フェーズ 2〜4 未着手
- **起点**: 「SR 検索式作成アプリとして効率的に役立つか」の全体レビュー（フロー/UX・検証/変換ロジックの Python 版忠実性・LLM/要件充足度の 3 観点）
- **関連**: [requirements.md](requirements.md) / [architecture.md](architecture.md)

## レビュー結論の要約

コアの「作成 → 検証 → 育成（margin 拡張）」ループは SR 方法論を正しくエンコードした水準の高い実装で、監査トレイル（LLMApiLog / FormulaVersions 系譜 / ValidationLog）も設計どおり完全実装。一方で以下の 3 領域に実用上の穴が残る。

1. **出口の品質**: DB 変換が Python 参照実装から後退（近接演算子未変換・Emtree 恒等写像・CT.gov 全部 Other Terms・Dialog `#N→SN` の素朴な振替）
2. **失敗時の体験**: NCBI の in-band エラーが「0 件」と区別不能／検証のみ再試行がなく LLM コスト二重払い／長時間実行のキャンセル不可／hydrate 失敗の握りつぶし
3. **安全装置の未配線**: 過大ヒット→フィルタ承認フロー（`proposeExcessFilters`）が dead code／blocks の「下書きとして保存」が no-op（リロードで未承認編集が消える）／未検証式でも export 可能

## 方針

- 「効いた実感が早い順 × 依存関係順」で 4 フェーズに分割。各フェーズは独立ブランチで完結でき、フェーズごとにアルファ配布（`npm run release:alpha`）可能
- 検証プロトコルは毎回 `npm run typecheck → npm test → (UI 変更時) npm run test:e2e → npm run dev`
- ハードブロックより警告を優先（guards の近似方針は維持）。監査性（すべて記録する）は全フェーズで壊さない

---

## フェーズ 1: エラーの可視化（規模: 小 / 最優先） ✅ 完了（2026-07-02, ブランチ `fix/ncbi-error-and-draft-save`）

### 1-1. NCBI in-band エラー検出 — 「構文エラー」と「0 件」の区別 ✅

- [src/lib/ncbi/eutils.ts](../src/lib/ncbi/eutils.ts) の `esearch`（89-92 行付近）で `esearchresult.ERROR` / `errorlist`（`phrasesnotfound` / `fieldsnotfound`）/ `warninglist` をパースし、エラー時は `EutilsError` を throw する
- 構文エラーはリトライしても無意味なので、`retryWithBackoff` の対象外にする「恒久エラー」フラグを `EutilsError` に追加する
- [src/features/validation/checkSearchLines.ts](../src/features/validation/checkSearchLines.ts) は既にブロック単位のエラー捕捉があるため、そこへ流れて「⚠ 構文エラー: phrase not found "xxx"」とバッジ表示されることを確認する
- テスト: in-band エラー JSON のモックを追加。ヒット数バッジ系の E2E spec も確認
- **受入条件**: 不正なタグを含む式が「0 件」ではなくエラー表示になる
- **実装メモ**: `EutilsError.permanent` フラグ + `shouldRetry` で恒久エラーをリトライ除外。`errorlist.fieldsnotfound` / `phrasesnotfound` / `esearchresult.ERROR` は permanent、HTTP 200 のトップレベル `error`（rate limit）はリトライ対象の一時エラーとして検出

### 1-2. 「下書きとして保存」を実装する（no-op ボタンの解消） ✅

- 現状: [src/app/bootstrap.ts](../src/app/bootstrap.ts) 357 行付近のコメントどおり `blocks.onSaveDraft` は意図的に何もしない。ボタン（[src/app/views/blocksView.ts](../src/app/views/blocksView.ts) 612 行付近）は存在するため、ユーザーは保存されたと誤認し、リロードで未承認のブロック編集が消える
- 対応: `onSaveDraft` で `blocksDraft` を `chrome.storage.local`（`currentProject` と同じ層）へ保存。hydrate（bootstrap.ts 285 行付近）で復元し、承認済みブロックより新しい下書きがあれば「未承認の下書きがあります」と表示する
- 代替案（工数最小）はボタン撤去 + 注記だが、リロード消失は信頼を最も損なう挙動のため**保存実装を推奨**
- **受入条件**: ブロック編集 → 下書き保存 → リロードで編集内容が残る
- **実装メモ**: `blocksDraftBackupService`（chrome.storage キー `blocksDraftBackup`、projectId 付き 1 件のみ）。承認（`runApprove`）とプロトコル再解析（`onSubmit`）で破棄。復元・保存中は blocksView に「未承認の下書きがあります」バナー（`AppState.blocksDraftSavedAt`）

### 1-3. hydrate 失敗の表示 ✅

- [src/app/bootstrap.ts](../src/app/bootstrap.ts) 321-323 行付近の catch がエラーを握りつぶし、Sheets の一時障害が「空プロジェクト」に見える
- 対応: エラーバナー（再試行ボタン付き）を home / protocol に表示する
- **受入条件**: Sheets API を落とした E2E stub で「読み込みに失敗しました」が出る
- **実装メモ**: `AppState.hydrateError` + `buildHydrateErrorBanner`（home / protocol 共用、再試行 = `hydrateCurrentProject` 再実行）。あわせて E2E の `appStub` に Sheets のデフォルトモック（`{ values: [] }`）を追加し、hydrate が実ネットワークへ出ないようにした（`journey-history-switch` は hydrate 成功前提に更新）

## フェーズ 2: 安全装置の配線（規模: 中）

### 2-1. 過大ヒット → フィルタ承認フローの接続（dead code の解消）

- 現状: [src/features/formula/skills/filterDesigner.ts](../src/features/formula/skills/filterDesigner.ts) の `proposeExcessFilters` / `HIT_THRESHOLD`（10,000 件）は実装・テスト済みだが呼び出し元がなく、要件 §4.4 の承認ゲートが機能していない
- 対応: draft パイプライン（bootstrap.ts 894 行付近の `runDraftPipeline`）の最終検証後、総ヒット数 > `HIT_THRESHOLD` なら `proposeExcessFilters` を呼び、候補フィルタを draftView に承認 UI として表示。承認されたら式に追記 → 検証のみ再実行（2-2 と共用）。**承認なしでは絶対に追加しない**（要件の厳格ルール維持）
- `LLMApiLog` は既存の `purpose=design_filter` で記録
- **受入条件**: E2E で 10,001 件 stub → 候補提示 → 承認で式更新、拒否で式不変

### 2-2. 「検証のみ再実行」パス（生成やり直しの LLM コスト二重払い解消）

- 現状: 生成成功・検証失敗のとき `currentFormulaMarkdown` は保持されているのに、再クリックすると生成からやり直しになる
- 対応: `runDraftPipeline` の検証フェーズだけを切り出した関数を bootstrap に用意し、draftView のエラー表示に「検証のみ再実行」ボタンを追加（2-1 の再検証と共用）
- **受入条件**: 検証フェーズで fetch を落とす E2E → 再実行ボタンで LLM を呼ばずに検証が回る

### 2-3. export ガードの警告化

- ハードブロックはしない（[src/app/guards.ts](../src/app/guards.ts) 冒頭コメントの近似方針は維持）。exportView 上部に「この式は未検証です / 捕捉率 N% です」の警告バナーを出すだけに留める。`validationResult` とバージョン ID の突合で判定
- **受入条件**: 未検証式で export を開くと警告表示、検証済みなら非表示

## フェーズ 3: DB 変換の底上げ（規模: 中〜大 / 出力物の品質）

### 3-1. 近接演算子の移植（Python に実装済み、移植のみ）

- 移植元: [search_converter.py](../search-formula-developper/scripts/conversion/search_converter.py) 13-47 行（CENTRAL `NEAR/N` / `NEXT`）と 158-191 行（Dialog `N/n` / `W/1`）
- `[tiab:~N]` 等を [src/features/conversion/toCentral.ts](../src/features/conversion/toCentral.ts)（現状は処理なしで素通し）/ [src/features/conversion/toDialog.ts](../src/features/conversion/toDialog.ts)（現状は警告のみ、47-50 行付近）で実変換に置き換える

### 3-2. Emtree 未マッピング警告

- 現状: toDialog は MeSH 記述子をそのまま `EMB.EXACT.EXPLODE("<MeSH>")` に入れる恒等写像で、Emtree に存在しない語でも警告が出ない（Python 版は警告あり）
- 対応: 「MeSH 記述子を Emtree 語として仮置きしています。Emtree で確認してください」の警告行を出力に付加する。自動マッピングはスコープ外

### 3-3. Dialog `#N→SN` の明示的リナンバリング

- 現状: toDialog（80 行付近）は `#N` を `SN` に 1:1 置換しており、行番号が 1..N の連番でないと誤った集合参照になる
- 対応: Python の `line_mapping` 方式（出現順に S1, S2… を採番し、境界安全な regex で参照を書き換え）に置換する

### 3-4. 実データのゴールデンテスト

- 現状: 変換テストは自作の小さな文字列のみで、サブモジュールの実式コーパスを使っていない（近接演算子や Emtree の穴はまさに実データで露見する）
- 対応: サブモジュールの実式（`search_formula.md` 例）を変換テストのフィクスチャに採用し、Python 版の出力と突き合わせるゴールデンテストを追加。3-1〜3-3 の回帰防止と残る乖離の棚卸しを兼ねる

### 3-5. （このフェーズでは見送り）CT.gov のフィールド分類移植

- Python `clinicaltrials/converter.py` 相当（各語を Condition / Intervention / Other Terms に分類）は規模が大きいので P1 タスクとして別計画
- 先行対応として、現状の「全タグを剥がして一律 Other Terms」出力（[src/features/conversion/toClinicalTrials.ts](../src/features/conversion/toClinicalTrials.ts)）に限界の注記を明記する
- あわせて CT/ICTRP のタグ除去 regex（`toClinicalTrials.ts` 51 行付近 / `toIctrp.ts` 44 行付近）が空白・`-` を含む文字クラスで過剰マッチしうる点を修正する

## フェーズ 4: 実行体験（規模: 中〜大）

### 4-1. クライアント側レートリミッタ

- 現状: バックオフ（失敗後の反応）のみで事前スロットリングがなく、[src/features/validation/freewordDelta.ts](../src/features/validation/freewordDelta.ts) 96 行付近等の `Promise.all` バーストは 429 → リトライ頼み
- 対応: eutils の deps 層にトークンバケット（API キーなし 3 req/s / あり 10 req/s。Python `check_block_overlap.py` の `_respect_rate_limit` 相当）を追加。呼び出し側の変更は不要

### 4-2. 長時間実行のキャンセル

- 現状: 「生成して検証する」「境界事例を取得」開始後は待つかリロード（= 状態消失）しかない
- 対応: `AbortController` を LLM / NCBI の fetch に通し、`draftRun` / `expandRun` にキャンセルボタンを追加。中断時は `status='cancelled'` を新設し、生成済み `blockHits` は保持（bootstrap.ts 1005 行付近のエラー化ヘルパと同様の部分保持）
- 監査性維持のため、中断された LLM 呼び出しも `LLMApiLog` に `error=cancelled` で記録する

---

## 見送り（別計画とするもの）

- **P1 ロジック移植**（`check_block_overlap` / `check_mesh_overlap`）: 価値は高いが独立した機能追加。3-4 のゴールデンテスト基盤ができてから着手する方が安全
- **CT.gov フィールド分類**（3-5 参照）
- **done 画面の転記支援**: クリップボードコピー程度なら小さいので、テスター要望次第でフェーズ 1 に繰上げ可

## 進め方

| フェーズ | ブランチ例 | UI 変更 | E2E 必須 |
|---|---|---|---|
| 1 | `fix/ncbi-error-and-draft-save` | あり | ✓ |
| 2 | `feat/excess-filter-and-revalidate` | あり | ✓ |
| 3 | `fix/db-conversion-fidelity` | なし（出力のみ） | 変換系 spec のみ |
| 4 | `feat/rate-limit-and-cancel` | あり | ✓ |

- フェーズ間の依存: 2-1 の再検証は 2-2 の関数を使う（同フェーズ内）。3 と 4 は完全独立で並行可能
- 1 → 2 の順は必須ではないが、1-1 のエラー型は 2-2 のエラー表示分岐でも使うため先行が楽
- 完了したフェーズはこのドキュメントの該当節に ✅ と完了日を追記する
