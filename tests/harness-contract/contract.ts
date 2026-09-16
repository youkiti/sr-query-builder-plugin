/**
 * 実機ハーネス（tools/selenium/manualCheck.mjs・video/scenes/*.mjs・
 * video/scenes/examples/00-smoke.mjs、あわせて 16 ファイル）が `src/` の描画に依存している
 * セレクタと前提条件を、1 箇所に機械可読な形で宣言する（issue #183）。
 *
 * ## なぜこのファイルがあるか
 *
 * 16 ファイルは jest / eslint / webpack のどこからも参照されない（package.json の lint は
 * `src tests experiments` のみ、jest.config.ts の roots も `.mjs` を拾わない）。実行して
 * 確かめる手段は実 API を叩く `npm run manual:check` と、仮想ディスプレイ・音声が要る
 * `npm run video:record` だけで、どちらも CI には置けない。結果、`src/` の DOM 構造を
 * 変えても誰も気づかず、実行しようとした人が初めて詰まる（#177 で実際に起きた）。
 *
 * ## 「存在するか」ではなく「契約」を書く
 *
 * #177 で壊れたのは要素の存在ではなく契約だった: `.draft__actions` は元は「常に描画され、
 * 唯一の子が生成ボタン」だったが、いまは「検索式があるときだけ」描画され、中身の順序・
 * 意味も変わった。133 種のセレクタは #177 の後もすべて `src/` に存在していたため、
 * 単なる存在チェックでは検知できない。ここでは状態ごとの有効性・一意性・排他性など、
 * 消費側の操作に必要な条件を宣言し、`contract.test.ts` が実際に描画して検証する。
 *
 * ## verified について
 *
 * `verified: true` の項目は `contract.test.ts` が実アプリ（jsdom + 実 HTML）を描画して
 * 検証する。`verified: false` は宣言のみで、`unverifiedReason` に理由を書く。
 * 「#/draft 周辺（#177 / #180 で実際に壊れた範囲）を最優先にする。網羅そのものを目的に
 * しない」という issue の方針に沿って、#/draft・popup・options・#/settings・home
 * サイドナビ以外は宣言のみに留めている。
 */

export interface ContractConsumer {
  /** 依存しているファイル（リポジトリルートからの相対パス） */
  file: string;
  /** そのファイルの中で、依存している手順・コメント（人が読んで辿れる短い説明） */
  step: string;
}

export interface ContractEntry {
  /** 一意な ID。テストからはこれで引く（typo をコード上の参照切れとして検知するため） */
  id: string;
  consumers: ContractConsumer[];
  /** どのルート・どの状態で見るか（demoSeed プリセット名を含む） */
  precondition: string;
  /** 何が成り立つべきか。存在ではなく条件つきの構造を書く */
  expectation: string;
  verified: boolean;
  /** verified: true のとき、実際に検証している test() のタイトル */
  verifiedBy?: string;
  /** verified: false のとき、なぜ未検証か */
  unverifiedReason?: string;
}

export const HARNESS_CONTRACT: ContractEntry[] = [
  // ── #/draft（#177 / #180 の被害範囲。最優先） ──────────────────────────────
  {
    id: 'draft.no-formula.single-primary-action',
    consumers: [
      {
        file: 'tools/selenium/manualCheck.mjs',
        step:
          'optimizeAndValidateDraft(): `.view__placeholder` でなければ `.optimization__start` を' +
          ' 主操作として待ち・有効性を確認する（「反復上限」欄も `.optimization__setup details` の' +
          ' 中にある前提）',
      },
      {
        file: 'video/scenes/07-draft.mjs',
        step:
          'ヘッダーコメント「未生成時は `.draft__actions` 自体が無い」。' +
          '.optimization__start のみを主操作として操作する',
      },
    ],
    precondition:
      '#/draft を検索式未生成（currentFormulaMarkdown === null）で開き、' +
      '承認済みブロックとシードの設定読込が完了している（queryOptimizationSetup.status === ready）',
    expectation:
      '`.optimization__start` が唯一の主操作として有効で、目安件数・反復上限を入力して開始できる。' +
      ' 両入力は `section.optimization__setup` 内で対応する label の直下にあり、' +
      ' ラベルで取得できる。反復上限は details 内にあり、summary で開いて入力できる。' +
      ' `.draft__actions`（`.draft__revalidate` /' +
      ' `.draft__generate` を含む補助操作行）は一切描画されない（querySelector が null を返す）',
    verified: true,
    verifiedBy: '現式が無いとき > 設定入力と主操作が有効で、補助操作は描画されない',
  },
  {
    id: 'draft.formula-exists.unique-secondary-actions',
    consumers: [
      {
        file: 'tools/selenium/manualCheck.mjs',
        step:
          'optimizeAndValidateDraft(): 採用保存の直後に `.draft__generate` を' +
          ' driver.findElement(By.css(...)) で一意に取得してクリックする' +
          '（コメント: 採用保存は createdBy=\'auto_optimize\' になるため確認パネルは出ない前提）',
      },
      {
        file: 'video/scenes/07-draft.mjs',
        step:
          'cue 07: 採用保存の直後に `.draft__revalidate` を一意に取得してクリックする' +
          '（ヘッダーコメント「保存後の検証は `.draft__revalidate`」）',
      },
    ],
    precondition:
      '#/draft の採用保存直後（currentFormulaVersionId が非 null、createdBy=\'auto_optimize\'）。' +
      ' draftRun / queryOptimizationRun とも running でない。user_edit の版とも比較する',
    expectation:
      '現式があるとき `.draft__revalidate` と `.draft__generate` がそれぞれページ内で一意に取れる。' +
      ' 現式が無いときは両方とも描画されない。兄弟順序や追加の装飾クラスは問わない。' +
      ' auto_optimize の版で `.draft__generate` を押すと `.draft__discard-confirm` を表示せず' +
      ' 再生成を開始する。user_edit の版では確認パネルが表示され、直ちには再生成しない',
    verified: true,
    verifiedBy:
      '採用保存後 > 補助操作がページ内で一意に取れ、破棄確認なしで再生成できる',
  },
  {
    id: 'draft.block-hits.generation-only',
    consumers: [
      {
        file: 'video/scenes/07-draft.mjs',
        step:
          'cue 07: waitWithProgress() が `.draft__block-hits` を「実行中のあいだだけホバーする' +
          ' 進捗インジケータ」として progressSelectors に渡す',
      },
      {
        file: 'video/scenes/08-validation.mjs',
        step:
          'ヘッダーコメント「`.draft__tracker` / `.draft__step*` / `li.draft__block-hit` は' +
          ' 実行中しか描画されない。開いただけのこの章では存在しないので、触らない」',
      },
    ],
    precondition:
      '#/draft を demoSeed=08-validation で開いた直後（running=false）、`.draft__generate`' +
      ' クリックで生成中（running=true）、検証完了後（`.draft__validate-status` が描画された状態）' +
      ' の 3 状態。デモ既定の研究デザインと RCT / observational の混在入力の両方を通す',
    expectation:
      '実アプリの生成・検証を通して、生成中に `.draft__block-hits` の計測済み件数が表示される。' +
      ' 検証完了後は同じコンテナに `.draft__validate-status` が表示され、ブロック件数は残らない。' +
      ' 通知なしでは draftRun が null、フィルタ見送り通知がある場合は通知を保持して' +
      ' status=done / blockHits=[] になる',
    verified: true,
    verifiedBy: '.draft__block-hits は生成中だけ描画され、検証完了後には残らない',
  },
  {
    id: 'draft.optimization.review-and-save-status',
    consumers: [
      {
        file: 'tools/selenium/manualCheck.mjs',
        step:
          'draftOutcome(): `.optimization__review` と `.optimization__setup [role=alert]`' +
          ' は排他、`.optimization__save-status`（「保存しました」を含む）と' +
          ' `.optimization__save-error` も排他という前提で完了判定する',
      },
      {
        file: 'video/scenes/07-draft.mjs',
        step:
          'cue 04-05: `.optimization__review h3` → \'採用して保存\' ボタン（isEnabled 確認）→' +
          ' `.optimization__save-status`（「保存しました」フィルタ）の順で進む',
      },
    ],
    precondition: '#/draft を demoSeed=07-draft から自動調整を実行（目安件数・反復上限を指定）した後',
    expectation:
      '実行完了で `.optimization__review` が描画され、\'採用して保存\' 押下後に' +
      ' `.optimization__save-status` が「保存しました」を含むテキストになる',
    verified: false,
    unverifiedReason:
      '自動調整の全ループ（初期式生成・実測・外側の確認）を要し、同じ経路は' +
      ' src/demo/llmFixtures.test.ts の e2e 相当テストが実際に通している。本 contract 専用の' +
      ' 検証は #/draft 優先の中でも構造契約（上記 3 件）を優先し、時間の制約で未実施' +
      '（宣言のみ）',
  },

  // ── popup（プロジェクト作成・選択） ────────────────────────────────────
  {
    id: 'popup.auth-gate',
    consumers: [
      {
        file: 'tools/selenium/manualCheck.mjs',
        step: 'sceneProject(): `#login-button` クリック → `#popup-create-form button[type=submit]` クリック',
      },
      {
        file: 'video/scenes/03-project.mjs',
        step:
          '`#popup-create-title` / `#popup-email`（`@` を含むテキスト）の可視化待ちで' +
          ' ログイン解決を検知し、`#popup-create-form button[type="submit"]` を押す',
      },
    ],
    precondition: 'popup.html を isAuthenticated=false / true の両方で起動する',
    expectation:
      '未認証時は `#popup-auth`（`#login-button` を含む）が表示され `#popup-projects` は非表示。' +
      ' 認証済み時はその逆で、`#popup-email` に @ を含むテキストが表示される。' +
      ' `#popup-create-title` と有効な `#popup-create-form button[type="submit"]` が取得でき、' +
      ' 送信ボタンとメールは祖先を含め hidden ではない' +
      '（実 popup.html のマークアップに対して検証する。bootstrap.ts 側だけを見る' +
      ' fabricated スケルトンでは HTML 側の id 変更を検知できないため）',
    verified: true,
    verifiedBy: 'popup.html（実ファイル）> 未認証/認証済みで表示が切り替わる',
  },

  // ── options（Chrome 拡張の Options ページ本体。#/settings とは別物） ───────
  {
    id: 'options.provider-cards-and-save-status',
    consumers: [
      {
        file: 'tools/selenium/manualCheck.mjs',
        step:
          'sceneOptions(): OPTIONS_URL（options/options.html）を直接開き、`#options-status` の' +
          ' 確定待ち → `#llm-model-select` の value 読み取り → 保存後は' +
          ' `#options-status` が「保存しました」を含むことを待つ',
      },
    ],
    precondition:
      'options.html（Chrome 拡張の options_ui。popup の「設定を開く」が開く #/settings とは' +
      ' 別の入口）を未設定の状態で起動する',
    expectation:
      '`#gemini-card` / `#openrouter-card` / `#llm-model-select`（選択肢が 1 個以上あり、選択値が取れる）が' +
      ' 描画され、保存ボタン（`#save-keys`）押下後は `#options-status` が「保存しました」を含む' +
      '（実 options.html のマークアップに対して検証する）',
    verified: true,
    verifiedBy: 'options.html（実ファイル）> プロバイダカード・モデル選択・保存後の status',
  },

  // ── #/settings（アプリ内設定。popup の「設定を開く」がここへ飛ぶ） ──────────
  {
    id: 'settings.provider-cards-ids-and-custom-model',
    consumers: [
      {
        file: 'video/scenes/02-setup.mjs',
        step:
          '`#settings-gemini-card` / `#settings-gemini-key` / `#settings-save` /' +
          ' `#settings-gemini-tier-badge`（「プラン」を含むテキスト待ち）/' +
          ' `#settings-llm-model` / `#settings-openrouter-card` / `#settings-ncbi-key` を順に操作',
      },
      {
        file: 'video/scenes/13-history.mjs',
        step:
          '`#settings-custom-model-id` に入力 → `.settings__custom-model-form button`' +
          '（id が無いので class で取る、と明記）をクリック →' +
          ' `#settings-custom-models-list .settings__custom-model-item` の出現を待つ',
      },
    ],
    precondition: '#/settings を createSettingsView 経由で直接描画する（プロジェクト状態に依存しない）',
    expectation:
      '`#settings-gemini-card` / `#settings-openrouter-card` / `#settings-llm-model` /' +
      ' `#settings-ncbi-key` / `#settings-save` / `#settings-gemini-tier-badge` /' +
      ' `#settings-custom-model-id` / `#settings-custom-models-list` が id で一意に取れる。' +
      ' カスタムモデル追加ボタンは `.settings__custom-model-form button` で取得できる' +
      '（id の有無は問わない）。追加すると' +
      ' `#settings-custom-models-list` 直下に `.settings__custom-model-item` が増える',
    verified: true,
    verifiedBy: '#/settings > id 一覧とカスタムモデル追加後の一覧反映',
  },

  // ── home（サイドナビ。00-smoke.mjs・01-intro.mjs が依存） ───────────────────
  {
    id: 'home.sidebar-nav-always-renders',
    consumers: [
      {
        file: 'video/scenes/examples/00-smoke.mjs',
        step:
          'プロジェクト未選択のまま `#app-sidebar .app__nav-list button` を全件ホバーする' +
          '（コメント: 「プロトコル入力」「設定」以外は is-disabled でグレーアウトするが' +
          ' 描画自体はされる、と明記）',
      },
      {
        file: 'video/scenes/01-intro.mjs',
        step: '`#app-sidebar .app__nav-list button` を全件ホバーし、件数を数える',
      },
      {
        file: 'video/scenes/03-project.mjs',
        step:
          '新規タブで開いたメインビューの `#app-sidebar .app__nav-list button.is-disabled` を' +
          ' 最大 3 件ホバーする（プロジェクト作成直後はまだ他ルートが disabled という前提）',
      },
    ],
    precondition: '#/home を、プロジェクト未選択（store.project === null）の状態で開く',
    expectation:
      'サイドナビ（`#app-sidebar .app__nav-list button`）は 1 件以上描画され、' +
      ' ガードが通らないルート（blocks / seeds / draft 等）は `.is-disabled` を持つが' +
      ' 要素自体は消えない（hidden ではなく disabled 表現である）',
    verified: true,
    verifiedBy: 'home サイドナビ > プロジェクト未選択でも描画され、一部が is-disabled になる',
  },

  // ── 以下、宣言のみ（#/draft 優先の方針により未検証。selector と前提条件は grep 済み） ──
  {
    id: 'protocol.manual-input-and-transition',
    consumers: [
      {
        file: 'tools/selenium/manualCheck.mjs',
        step:
          'sceneProtocol(): `.view__placeholder` / `.protocol__readonly` / `.protocol__form` を' +
          ' 判定し、未入力なら `input[name=sourceMode][value=manual]` → `textarea#inline` →' +
          ' `.protocol__submit` の順で送信する',
      },
      {
        file: 'video/scenes/04-protocol.mjs',
        step:
          'ソースモードのラジオ（manual/file）を往復しても textarea#inline の入力内容が' +
          ' 保持される前提でチェック（cue 04 のコメント）。送信後は `#protocol-progress` の' +
          ' 表示 → hash が #/blocks に変わるまで待つ',
      },
    ],
    precondition: '#/protocol を未入力の状態で開く（demoSeed=04-protocol）',
    expectation:
      '`input[name=sourceMode]` を manual → file → manual と切り替えても `textarea#inline` の' +
      ' 値は消えない。`.protocol__submit` 押下で `#protocol-progress` が表示され、成功時は' +
      ' hash が `#/blocks` に変わる',
    verified: false,
    unverifiedReason:
      '#/draft 優先のため未検証（issue #183 の方針）。LLM 呼び出し（extract-protocol）を要する',
  },
  {
    id: 'blocks.single-approve-button-then-navigate',
    consumers: [
      {
        file: 'tools/selenium/manualCheck.mjs',
        step:
          'sceneBlocks(): `.blocks__item` の個数を確認後、`.blocks__btn-primary`' +
          '（isEnabled 確認）をクリックし、hash が #/blocks から変わるのを待つ',
      },
      {
        file: 'video/scenes/05-blocks.mjs',
        step:
          'ヘッダーコメント「`.blocks__btn-secondary` は「＋ ブロックを追加」「全 AND に戻す」' +
          '「下書きとして保存」の 3 か所で共有される。承認ボタンだけは `.blocks__btn-primary`' +
          ' でユニークに取れる」。承認後は hash が #/seeds になるのを待つ',
      },
    ],
    precondition: '#/blocks をブロック未承認の状態で開く（demoSeed=05-blocks）',
    expectation:
      '`.blocks__btn-primary` は承認ボタン専用の class で、ページ内に 1 個しか無い（複数目的で' +
      ' 共有される `.blocks__btn-secondary` と区別される）。承認成功で hash が `#/seeds` に変わる',
    verified: false,
    unverifiedReason: '#/draft 優先のため未検証（issue #183 の方針）',
  },
  {
    id: 'seeds.primary-button-scoped-by-fieldset',
    consumers: [
      {
        file: 'video/scenes/06-seeds.mjs',
        step:
          'ヘッダーコメント「`.seeds__primary` は「登録」と「アップロードして登録」の 2 か所に' +
          ' あるので、fieldset で絞る」。`fieldset.seeds__section` の 1 番目の `.seeds__primary`' +
          ' を押す',
      },
    ],
    precondition: '#/seeds をシード未登録の状態で開く（demoSeed=06-seeds）',
    expectation:
      '`.seeds__primary` は class 単体では 2 箇所（PMID 登録／ファイルアップロード）に存在し、' +
      ' `fieldset.seeds__section` でスコープしないと意図しない方を押しうる',
    verified: false,
    unverifiedReason: '#/draft 優先のため未検証（issue #183 の方針）',
  },
  {
    id: 'draft.excess-hits-block-hits-absent-note',
    consumers: [
      {
        file: 'video/scenes/08-validation.mjs',
        step:
          'ヘッダーコメント「保存済みの式には `.draft__revalidate` と `.draft__generate` が' +
          ' 表示される。この章は検証済みプリセットを読むため、どちらも押さない」',
      },
    ],
    precondition: '#/draft を demoSeed=08-validation で開く（検証済み・実行しない）',
    expectation:
      '`.validate__final > p` は class の無い `<p>` が 2 個（全体ヒット数・捕捉率の順）で、' +
      ' `.validate__missed li` は先頭が見出し行（「未捕捉 PMID:」）で実際の PMID は nth(1) 以降',
    verified: false,
    unverifiedReason:
      '#/draft の構造契約は上記 3 件（no-formula / unique-secondary-actions / block-hits）で' +
      ' 検証済み。本項目は表示内容の細部（見出し行の有無）で優先度が低いため宣言のみ',
  },
  {
    id: 'expand.round-complete-and-focused-abstract',
    consumers: [
      {
        file: 'video/scenes/09-expand.mjs',
        step:
          'ヘッダーコメントに実装根拠つきで明記: (1) `checkRoundComplete`（expandView.ts）は' +
          ' `items.every(isDecided)` なので 3 件すべて判定しないと `.expand__round-summary` /' +
          ' `.expand__proposals` は出ない、(2) `buildUpdateProposals` は include した論文だけを' +
          ' 集計するので 1 件も include しないと更新提案が空、(3) 抄録は' +
          ' `.expand__candidate--focused` のカードにしか表示されない',
      },
    ],
    precondition:
      '#/expand を demoSeed=09-expand（v1 検証済み）で開き、「境界事例を取得」' +
      '（`.expand__actions button`）を押した後',
    expectation:
      '`li.expand__candidate` 3 件すべての判定保存が完了するとラウンド完了処理を開始する。' +
      ' onRoundComplete による再検証が成功すると `.expand__round-summary` が描画される' +
      '（全件 exclude でも同じ）。`section.expand__proposals` は include した論文から' +
      ' 組み立てた更新提案が 1 件以上ある場合だけ描画され、include が 0 件なら出ない。' +
      ' 判定ボタンは class を持たず' +
      ' `button[data-decision="include|exclude|maybe"]` のみなので' +
      ' `li.expand__candidate[data-pmid="…"]` でスコープしないと 9 個中どれを押したか特定できない',
    verified: false,
    unverifiedReason:
      '#/draft 優先のため未検証（issue #183 の方針）。LLM 2 回 + eutils 数回の取得パイプラインを要する',
  },
  {
    id: 'edit.pencil-hidden-until-hover-and-status-persists',
    consumers: [
      {
        file: 'video/scenes/10-edit.mjs',
        step:
          'ヘッダーコメントに issue 番号つきで明記: 「鉛筆 `.edit__block-edit-toggle` は CSS で' +
          ' 通常は不可視。行を hover して初めて現れる」（#39/#42 の修正で「保存しました」が' +
          ' 再描画後も残るようになった経緯も記載）',
      },
    ],
    precondition: '#/edit を demoSeed=10-edit（境界事例 include 済み）で開く',
    expectation:
      '`li.edit__block-row[data-block-id="N"]` でブロックごとにスコープしないと' +
      ' `.edit__block-*` 系の要素（4 行ぶん存在）を取り違える。`p.edit__status` の' +
      ' 「保存しました（version_id: …）」は保存後の再描画でも消えない（store 化済み。#42）',
    verified: false,
    unverifiedReason:
      '#/draft 優先のため未検証（issue #183 の方針）。AI 改善提案（LLM 1 回）の取得を要する',
  },
  {
    id: 'export.details-closed-by-default-and-methods-model-id',
    consumers: [
      {
        file: 'video/scenes/11-export.mjs',
        step:
          'ヘッダーコメント「`details` は変換後に閉じた状態で出る（`open` 属性なし）。`summary`' +
          ' をクリックして開く操作が要る」。`data-db` 属性（central/dialog/clinicaltrials/ictrp）で' +
          ' 4 個をスコープする',
      },
      {
        file: 'tools/selenium/manualCheck.mjs',
        step:
          'assertMethods(): `.export__methods-text` が英日の 2 本であること、' +
          ' expectLegacy=false のとき `{AI model}` プレースホルダが残っていないこと' +
          '（FormulaVersions に model が記録されていれば実モデル ID に置き換わる）を確認する',
      },
    ],
    precondition: '#/export を demoSeed=11-export（4 DB 変換前）で開く',
    expectation:
      '4 DB への変換後、`.export__result` / `.export__download` / `.export__formula` は' +
      ' 各 4 個あり、`details.export__result[data-db]` で DB ごとに絞れる。' +
      ' `.export__warnings` は各 DB の変換結果に警告がある場合だけ描画され、不存在も許容する。' +
      ' 変換直後の `details.export__result` は' +
      ' `open` 属性を持たず閉じている。`.export__methods-text` の `{AI model}` は' +
      ' FormulaVersions.model が記録されている版なら実モデル ID に置換され、' +
      ' 記録が無い旧バージョンではプレースホルダのまま残り `.export__methods-note` に' +
      ' 手動置換の案内が出る',
    verified: false,
    unverifiedReason: '#/draft 優先のため未検証（issue #183 の方針）',
  },
  {
    id: 'done.reachable-without-dedicated-preset',
    consumers: [
      {
        file: 'video/scenes/12-done.mjs',
        step:
          'ヘッダーコメント「`#/done` は `11-export` プリセットから到達できる（done のガードは' +
          ' `currentFormulaVersionId !== null` のみ）。12 章専用の demoSeed プリセットは無い」',
      },
    ],
    precondition: '#/done を demoSeed=11-export で開く（12 章専用プリセットは存在しない）',
    expectation: '`currentFormulaVersionId !== null` であれば #/done のガードは通り、専用プリセット無しで到達できる',
    verified: false,
    unverifiedReason: '#/draft 優先のため未検証（issue #183 の方針）。ガード条件自体は guards.ts 側の変更検知が主眼',
  },
  {
    id: 'history.load-button-and-preview-only',
    consumers: [
      {
        file: 'video/scenes/13-history.mjs',
        step:
          'ヘッダーコメント「差分（diff）表示は無い。あるのは `pre.history__preview`' +
          '（先頭 10 行）だけ」。「このバージョンを読み込む」押下で一覧が再描画され、' +
          ' `.history__status` が一瞬「読み込み中…」に戻る',
      },
    ],
    precondition: '#/history を demoSeed=13-history（v1/v2 の 2 版）で開く',
    expectation:
      '`li.history__item` は `data-version-id` でスコープする必要がある（2 件存在）。' +
      ' diff 用の要素は存在せず、`pre.history__preview` のみがバージョンの中身を見せる',
    verified: false,
    unverifiedReason: '#/draft 優先のため未検証（issue #183 の方針）',
  },
];

/**
 * id から contract entry を引く。存在しない id は typo とみなしてすぐ落とす
 * （テスト内で参照した id が宣言から漏れている／宣言側が rename されたことに早く気づくため）。
 */
export function getContract(id: string): ContractEntry {
  const found = HARNESS_CONTRACT.find((entry) => entry.id === id);
  if (!found) {
    throw new Error(
      `[harness-contract] 未知の contract id です: "${id}"。` +
        'tests/harness-contract/contract.ts の HARNESS_CONTRACT に無いか、id が変更されています。'
    );
  }
  return found;
}
