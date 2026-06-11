# UI 深堀りテスト計画（Tier 2 拡張 v0.2）

- **作成日**: 2026-04-20
- **親ドキュメント**: [ui-review-strategy.md](ui-review-strategy.md) §3 Tier 2 / [ui-states.md](ui-states.md) / [ui-flow.md](ui-flow.md)
- **対象**: Playwright + `@axe-core/playwright` による実 Chromium スモーク
- **現状** (2026-04-20 更新): Phase A〜G を初版実装済み。unit 828 / E2E 89 すべて green。
  - Phase A: [tests/e2e/fixtures/appStub.ts](../tests/e2e/fixtures/appStub.ts) + [src/app/app.ts](../src/app/app.ts) の `window.__E2E_PRELOADED_STATE__` hook、[app-smoke-of-smoke.spec.ts](../tests/e2e/app-smoke-of-smoke.spec.ts) 11 ケース
  - Phase B: `app-{home,protocol,blocks,seeds,draft,validate,expand,edit,export,done,history}.spec.ts` 計 37 ケース（含む a11y 11）
  - Phase C: [app-guards.spec.ts](../tests/e2e/app-guards.spec.ts) 6 ケース、[app-sidebar-visual.spec.ts](../tests/e2e/app-sidebar-visual.spec.ts) 4 ケース
  - Phase D: `journey-docx-upload.spec.ts` (J3 UI-only) + `journey-history-switch.spec.ts` (J2) — J1/J4 は LLM stub 整備待ち
  - Phase E: `journey-errors.spec.ts`（OAuth レイヤのみ）— Sheets 403 / NCBI 429 / LLM 500 は Phase A#4 fetch stub 拡充後
  - Phase F: `app-regression.spec.ts` で 11 ルート × `#app-content` 非空 + 3 status 非空 + long-title bounding box
  - Phase G: `options.spec.ts` 5 ケース（MVP 現実装向け）
  - **副作用**: axe が実バグを検出したため以下を修正: `blocksView.ts` / `editView.ts` / `seedsView.ts` に `aria-label`、`bootstrap.ts` のサイドバーに `aria-current="page"`、`options.css` に `.options__muted a { text-decoration: underline }`。
- **目的**: CLAUDE.md §目的 の user flow（protocol 入力 → blocks 承認 → seeds → draft → validate → expand → edit → export → done）を **画面単位 + ジャーニー単位 + 異常系** の 3 層で網羅し、CSS specificity / レイアウト / 画面間 state 引き回し事故を構造的に落とす

## 1. 方針

実 Chromium で app.html / popup.html / options.html を読み込み、「既にそこへ辿り着いたユーザー」視点で各画面を検証する。実 LLM / Sheets / NCBI API は叩かず、bootstrap → store → views 経路は本物を使う（ジャーナリング型 integration テスト）。

- 実 Chromium + 実 CSS + 実 DOM を通る: `display:none` / `visibility:hidden` / bounding box を含む computed style 検証が可能
- LLM / Google / NCBI はすべて `page.route()` と chrome stub でモック。OAuth も `getAuthToken` スタブで済ませる
- 画面遷移ロジック（[router.ts](../src/app/router.ts) / [guards.ts](../src/app/guards.ts)）は実コード。属性レベルではなく**クリック → 遷移 → トースト**の挙動で検証する

### 1.1 preloaded state の注入方式（重要: storage 経由では不可）

[bootstrap.ts:165-171](../src/app/bootstrap.ts#L165-L171) の `hydrateCurrentProject` が `chrome.storage.local` から読むのは **`currentProject` のみ**。`protocolDraft` / `blocksDraft` / `currentProtocolVersion` / `currentFormulaVersionId` / `currentFormulaMarkdown` は in-memory のみで永続化されない（[store.ts:50-77](../src/app/store.ts#L50-L77)）。つまり `chrome.storage.local` に JSON を積むだけでは、app.html を開いても store は `INITIAL_STATE` のままで、guard に弾かれて `#/blocks` 以降の画面へ到達できない。

そこで以下 2 方式のどちらかを採る（どちらを採用するかは Phase A 着手前に決める）。

**方式 X: E2E hook を本体に 1 箇所だけ開ける（推奨）**
- [app.ts](../src/app/app.ts) に「`window.__E2E_PRELOADED_STATE__` があれば `createStore(initial)` のシードに使う」ブランチを 1 本足す
- Playwright 側は `page.addInitScript` で `__E2E_PRELOADED_STATE__` を仕込み、`currentProject` だけは chrome.storage 側にも並べて置く（hydrate との整合のため）
- production バンドルには残るがデバッグ用に許容する or `process.env.E2E === '1'` の webpack 分岐で切る
- メリット: 各 route に直接入れる。テストが 1 〜 2 秒で済む

**方式 Y: サービス経由で状態を作る**
- `injectAppStub` は storage + API fetch stub に留める
- 各 spec は `#/protocol` フォーム submit → `submitProtocol` 実行 → `blocksDraft` 生成 → `#/blocks` 承認 → `approveBlocks` → `currentProtocolVersion` 採番 … のように現実の遷移をなぞって state を作る
- メリット: 本体 API にテスト seam を開けない。E2E が「本物のシナリオ」になる
- デメリット: 各 route 単体スモークの所要時間が増える。LLM / Sheets / NCBI の stub が Phase A で全て揃っていないと 1 ケースも書けない

**採用案**: Phase B の single-route smoke は **方式 X**、Phase D のジャーニー貫通は **方式 Y** を使う。X は開発/テスト用の 1 フラグで本番動作に影響せず、Y は実際の state 引き回しバグを落とせる。両立する。

## 2. ユーザージャーニー棚卸し

CLAUDE.md §目的 と [ui-flow.md §2](ui-flow.md) から逆算した 6 本。

| ID | ジャーニー | 再現難度 | バグ密度 |
|---|---|---|---|
| J1 | 新規プロジェクト作成 → protocol 入力（手入力）→ blocks 承認 → seeds 登録 → draft 生成 → validate → export → done | 高 | 高 |
| J2 | 既存プロジェクトを popup から選択 → home → history でバージョン切替 → validate 再読込 | 中 | 中 |
| J3 | protocol.md / .docx アップロード（docx パース失敗含む）| 低 | 中 |
| J4 | expand 画面で `i` / `e` / `m` キーで 5 件判定 → 自動再検証 | 中 | 高（keyboard は jsdom で弱い）|
| J5 | OAuth 失効 / Sheets 403 / NCBI 429 / LLM 500 からの復帰 | 高 | 高 |
| J6 | Options で BYOK 保存 → app から利用 | 低 | 低 |

## 3. フェーズ分解

### Phase A: フィクスチャ拡張（基盤整備, 0.7 日）

現 [tests/e2e/fixtures/chromeStub.ts](../tests/e2e/fixtures/chromeStub.ts) は popup 専用（`identity` + `storage` 一部）。app.html 用に以下を追加する。

1. **本体の E2E hook（§1.1 方式 X）**: [app.ts](../src/app/app.ts) に `window.__E2E_PRELOADED_STATE__` を `createStore` のシードに使う分岐を 1 本追加する（0.1 日）。本体差分は 3〜5 行。
2. **`injectAppStub(page, appScenario)`**: 以下をまとめて注入する fixture 関数
   - `page.addInitScript` で `window.__E2E_PRELOADED_STATE__` を先に置く（`protocolDraft` / `blocksDraft` / `currentProtocolVersion` / `currentFormulaVersionId` / `currentFormulaMarkdown` / `cumulativeCostUsd`）
   - `chrome.storage.local` の `currentProject` を同じ projectId でセット（hydrate との整合。`project` を state 側で `null` にして storage だけに積むのは可だが、先にレースが無いよう両方に置く）
   - seeds / formulaVersions / validationLogs 等 **store 定義に無い** データは、本体の service が管理する in-memory / 将来の Sheets キャッシュ側に合わせて拡張時に追記（現時点の state 契約だけで賄える範囲にとどめる）
3. **`chrome.runtime.sendMessage` スタブ**: background へのメッセージは no-op にするか、シナリオ側で assertion 用に録音
4. **`fetch` インターセプタ**: `page.route()` で以下を固定レスポンスに差し替え
   - `eutils.ncbi.nlm.nih.gov/*`（esearch / efetch）
   - `sheets.googleapis.com/*`（batchGet / values.append / batchUpdate）
   - `www.googleapis.com/drive/v3/*`（files.create / files.get）
5. **fixture JSON** (`tests/e2e/fixtures/scenarios/*.json`): 各ジャーニーで使う state スナップショットを分離し、spec 本体を短く保つ

> **Phase A 完了基準**: `injectAppStub` だけで `#/protocol` 〜 `#/done` の 11 ルートに guard 違反なく到達できる unit test を 1 本（smoke of smoke）書き、green であること。これが通らないと Phase B 以降は全滅する。

### Phase B: 各ルート単体のスモーク（Tier 2 本丸, 1 日）

各ルートにつき「表示されるべきもの」「隠れるべきもの」「空 / N 件の分岐」の 3 観点でスモーク。spec 化は [ui-states.md §3](ui-states.md) の「状態 C」表を **出発点** にするが、同ドキュメントは一部 target spec（実装より先行）なので、spec 起こし時に必ず該当 view 実装と照合する。既知ドリフトは ui-states.md の **⚠️ drift** 注記に集約する。

> 例: ui-states.md 初版には `#/protocol` が「3 ソース選択」と書かれていたが、実装は `manual` / `file` の 2 モードラジオ + file 側で拡張子振分け（[protocolView.ts:8-13](../src/app/views/protocolView.ts#L8-L13)）。Phase B 着手前に ui-states.md を修正済み。

| spec ファイル | 画面 | ケース数 | 重点 |
|---|---|---|---|
| `app-home.spec.ts` | `#/home` | 2 | プロジェクトメタ表示、最終更新日時フォーマット |
| `app-protocol.spec.ts` | `#/protocol` | 4 | `manual` / `file` の 2 モードラジオ切替、`file` モードの拡張子振分け（`.md`/`.markdown` → markdown、`.docx` → docx）、未入力時の submit ガード、プロジェクト未選択時の警告文言 |
| `app-blocks.spec.ts` | `#/blocks` | 3 | 0 ブロック空状態、N ブロック承認 UI、編集モード |
| `app-seeds.spec.ts` | `#/seeds` | 3 | 0 件 / N 件、PMID バリデーション |
| `app-draft.spec.ts` | `#/draft` | 2 | 生成中スケルトン、完了後のコードブロック表示 |
| `app-validate.spec.ts` | `#/validate` | 3 | 捕捉率バッジ、行ヒット数、missed PMIDs 一覧 |
| `app-expand.spec.ts` | `#/expand` | 3 | 5 件候補表示、0 件の空状態、キーボード i/e/m（J4 兼用）|
| `app-edit.spec.ts` | `#/edit` | 2 | diff ペイン、空 diff でスクロール無し |
| `app-export.spec.ts` | `#/export` | 3 | 4 DB 変換結果、コピー／DL、未変換時の完了ボタン非表示 |
| `app-done.spec.ts` | `#/done` | 1 | nbib DL 案内リンク |
| `app-history.spec.ts` | `#/history` | 2 | 0 件と N 件 |

各 spec の最後に `@axe-core/playwright` の違反ゼロ assertion を 1 個足す（Tier 3, 合計 +11）。**合計 ≈ 28 + 11 a11y**。

### Phase C: ガード／サイドバー横断（0.3 日）

1. **`app-guards.spec.ts`**: [guards.ts:36-71](../src/app/guards.ts#L36-L71) の前提条件を「**enabled 状態 + deny 時の reason 文言**」の組合せで確認する（jest は属性のみ）。常時利用可の `home` / `protocol` を除いた 9 ルートについて、state の各段階での期待値マトリクスは以下（`○` = enabled、括弧内 = deny reason）。

   | state\\route | blocks | seeds | draft | validate | expand | edit | export | done | history |
   |---|---|---|---|---|---|---|---|---|---|
   | 無状態（project=null）| PROJECT | PROJECT | PROJECT | PROJECT | PROJECT | PROJECT | PROJECT | PROJECT | PROJECT |
   | project のみ | PROTOCOL | ○ | BLOCKS | FORMULA | FORMULA | FORMULA | FORMULA | FORMULA | ○ |
   | project + protocolDraft | ○ | ○ | BLOCKS | FORMULA | FORMULA | FORMULA | FORMULA | FORMULA | ○ |
   | project + protocol + 承認済 blocks（currentProtocolVersion 有）| ○ | ○ | ○ | FORMULA | FORMULA | FORMULA | FORMULA | FORMULA | ○ |
   | project + protocol + blocks + currentFormulaVersionId | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ |

   - 文言定数: `PROJECT` = `プロジェクトを選択してください`、`PROTOCOL` = `先にプロトコルを入力してください`、`BLOCKS` = `先にブロック承認を完了させてください`、`FORMULA` = `先に検索式を生成または読み込んでください`（[guards.ts:22-25](../src/app/guards.ts#L22-L25)）。
   - **`draft` は protocol を見ない**: [guards.ts:49-54](../src/app/guards.ts#L49-L54) の `needsBlocks` は `protocolDraft` の有無を条件に含まず、`hasProject && hasApprovedBlocks` で enabled / deny を決める。したがって `project` さえあれば `protocol` の有無によらず `BLOCKS` で落ちる（`PROTOCOL` でも `PROJECT` でもない）。上表の「project のみ」行の `draft = BLOCKS` はこれに従う。
   - `seeds` / `history` は **protocol 不要**。project があるだけで enabled になる点を外すと仕様誤認のまま固定化する。

2. **`app-sidebar-visual.spec.ts`**: 現在地ハイライト、`aria-current` 属性、**`#app-context`** (`aria-live="polite"`, [app.html:16](../src/app/app.html#L16)) がルート遷移で更新されること。`#app-status` には aria-live が付いていないため、ポライトネス通知の対象ではない。

### Phase D: ジャーニー貫通 E2E（0.7 日）

1. **`journey-new-project.spec.ts`** (J1): popup → 新規作成ボタンクリック → `chrome.tabs.create` が呼ばれたことを検証 → app.html 直接 goto で続きを再現（`chrome.tabs.create` 経路は拡張パッケージロードが必要なため疑似）
2. **`journey-history-switch.spec.ts`** (J2): 2 件の `formulaVersions` を持つ状態で `#/history` → クリック → `#/validate` に state 反映を確認
3. **`journey-docx-upload.spec.ts`** (J3): file input に `.docx` Buffer を set → パース成功 / 壊れた docx で UI が固まらない
4. **`journey-expand-keyboard.spec.ts`** (J4): `page.keyboard.press('i')` を 5 連打 → **Sheets API 書き込みの録音**で assertion する。[expandService.ts:146-172](../src/app/services/expandService.ts#L146-L172) の `recordDecision` は `appendSeedPaper(spreadsheetId, seed, deps.google)` で Sheets に直接書き込み、`AppState` には `seedPapers` を持たない（[store.ts:50-77](../src/app/store.ts#L50-L77)）。assertion は以下いずれかの方式：
   - **方式 a**: `page.route('**/sheets.googleapis.com/**/values:append*', ...)` で 5 回の append リクエストを handler で録音し、body に `source=interactive` の行が 5 本入っていることを確認
   - **方式 b**: Phase A の E2E hook を経由して `deps.google.fetch` をテスト用 spy に差し替え、呼び出し回数と引数を assertion する
   - **注意**: `store.getState().seedPapers` を見る書き方は実装と乖離するので避ける

### Phase E: エラー復帰の網（0.5 日）

**`journey-errors.spec.ts`** (J5) で `page.route()` を使って API を 401/403/429/500 に差し替える。

| 発生源 | 期待挙動 |
|---|---|
| Google OAuth 失効（`getAuthToken` が `undefined` を返す）| モーダル「再認証が必要です」+ ボタンで `removeCachedAuthToken` 呼出 |
| Sheets 403 | モーダル + 共有設定への外部リンク（新規タブで開くか確認: `chrome.tabs.create` 録音）|
| NCBI 429 | バナー「レート制限中…」が表示、再試行で再発火 |
| LLM 500 | 該当 skill カードに赤バッジ + 再試行ボタン活性 |

### Phase F: 回帰ネット（継続拡張, コスト随時）

過去バグと「同系統」を 1 行で落とす習慣。初期分として：

1. 今回の `[hidden]` specificity 回帰（既存: [popup.spec.ts:78-95](../tests/e2e/popup.spec.ts#L78-L95)）
2. **`#app-content` が空文字になる事故防止**: 全ルートで `#app-content` の `textContent.trim().length > 0`
3. **ステータス領域が空にならない**（[ui-states.md §0](ui-states.md) 共通レイヤ規約）: `#app-status` / `#popup-status` / `#options-status` が全状態で非空
4. **長いプロジェクト名で `#open-options` に被らない**（[ui-states.md E-Popup-3](ui-states.md)）: title 100 文字でも `#open-options` の bounding box が独立

### Phase G: Options 画面（0.2 日）

> **前提**: [ui-states.md §2](ui-states.md) の drift 注記参照。現実装（[src/options/bootstrap.ts](../src/options/bootstrap.ts)）は「生値復元 / 2 値ステータス / 成功時のみ `保存しました。`」に留まる。マスク表示 / 保存中 disable / 失敗 UI / `trim()` / 空文字抑止は target spec で未実装。Phase G は **まず現実装をそのまま固定**し、target 機能は実装追加と同時に別ケースを足す。

#### 現実装向けケース（MVP で書く）
- **Opt-1 初期（ストレージ空）**: `#options-status` が `"Gemini: 未設定 / NCBI: 未設定（3 req/s 枠）"`、両 input は空
- **Opt-2 初期（両キー保存済）**: `#options-status` が `"Gemini: 保存済み / NCBI: 保存済み"`、両 input に **生値がそのまま**入る（マスクを期待しない）
- **Opt-3 保存クリック**: 空のまま `#save-keys` を押しても `#options-status` が `"保存しました。"` に変わる（現実装ではここでクラッシュしない）
- **a11y**: axe 違反ゼロ（`color-contrast` は Tier 3 と同じく disable）

#### target 実装後に追加するケース（現時点では書かない）
- Opt-T1: 保存中ボタン disabled
- Opt-T2: `chrome.storage.local.set` reject 時の赤系ステータス + ボタン再活性
- Opt-T3: 前後空白を含む入力が `trim()` 済みで保存され、空文字は保存されない
- Opt-T4: 両 input が `type="password"` + `autocomplete="off"`
- Opt-T5: 起動直後の `"読み込み中…"` 表示とその後の更新

## 4. 実装順と期待効果

| 順序 | Phase | 粒度 | 累積コスト | 1 段階で防げるバグ系統 |
|---|---|---|---|---|
| 1 | A（フィクスチャ + E2E hook）| 基盤 | 0.7 日 | —（後段で効く）|
| 2 | B（各ルート単体）| 広く浅く | 1.7 日 | CSS/レイアウト・空/N 分岐・a11y |
| 3 | C（ガード）| 横断 | 2.0 日 | 遷移ロジック・サイドバー状態 |
| 4 | G（Options）| 独立 | 2.2 日 | 設定画面の単発バグ |
| 5 | D（ジャーニー）| 縦串 | 2.9 日 | 画面間 state 引き回し事故 |
| 6 | E（エラー）| 異常系 | 3.4 日 | 復帰導線の欠落 |
| 7 | F（回帰ネット）| 継続 | 随時 | 過去バグの再発 |

## 5. 注意事項

- **Phase A で E2E hook（§1.1 方式 X）を本体に入れないと、Phase B の各 route smoke は guard で弾かれて到達不能**。これが最優先。`chrome.storage.local` に `protocolDraft` 等を積んでも [bootstrap.ts:165-171](../src/app/bootstrap.ts#L165-L171) が読まないので、storage 注入だけのアプローチは機能しない。
- **Phase A で Google / NCBI の fetch stub を固めておかないと、Phase D 以降の `#/draft` / `#/validate` / `#/expand` / `#/export` のジャーニーが動かない**。基盤投資は後回しにしない。
- `chrome.tabs.create` や `chrome.identity.removeCachedAuthToken` は **副作用の録音**（呼ばれたか + 引数）で assertion する。実際にタブは開かない。
- docx パースは [mammoth.js](https://github.com/mwilliamson/mammoth.js) 相当の導入が前提。未実装なら Phase D-3 は保留して Phase B の `app-protocol.spec.ts` で manual モードと file モード（md のみ）のみ検証する。
- CI 導入時は **Phase B までを PR ブロッカー、C〜E は nightly** を推奨（実行時間の都合）。[requirements.md §11.1](requirements.md) の MVP 判定と合わせて確定する。
- `@axe-core/playwright` の `color-contrast` は tokens.css の初期値が MVP 範囲外のため disable 継続（別 issue で扱う）。他ルールで violation が出たら実バグの可能性が高い。
- **ui-states.md は一部 target spec**（実装より先行）。Phase B の spec 化時に実装と照合し、齟齬は「spec と実装のどちらを正とするか」を明示してから両方を直すこと。silent に spec 側を踏襲すると stale spec が Playwright で固定化される。

## 6. 利用・更新ルール

- 新しい画面 / ルートを実装する前に、対応する spec を本ドキュメントに追加してから着手する（[ui-states.md §5](ui-states.md) と同じ運用）
- 各 Phase 完了時は本ドキュメントの「現状」セクションを更新し、どの Phase まで通っているかを明記する
- AI にレビューを依頼する際は「本ドキュメント §3 の Phase X を満たしているか」を起点にする
