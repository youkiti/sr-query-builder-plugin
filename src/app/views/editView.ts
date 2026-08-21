import {
  applyBlockImprovement,
  type BlockImprovementContext,
  type BlockImprovementResult,
  type ImproveBlockTurn,
  type RequestBlockImprovementInput,
  type SaveEditedFormulaInput,
} from '@/app/services';
import {
  formatCombinationError,
  normalizeCombinationExpression,
  tokenizeCombination,
  validateCombinationExpression,
} from '@/lib/combination-expression';
import {
  extractBlockReferences,
  findUnreachableBlockIds,
  parsePubmedFormulaMd,
  wouldCreateReferenceCycle,
  type PubmedFormula,
} from '@/lib/search-formula-md';
import {
  buildBlockInspector,
  collectMeasuredContext,
  computeSiblingOverlaps,
  type BlockInspectorDeps,
  type SiblingBlock,
  type SiblingOverlap,
} from './blockInspector';
import { renderEditableBlockInto, type EditableBlockHandlers } from './editableBlock';
import {
  buildLegend,
  diffExpressions,
  renderDiffSideInto,
  renderExpressionInto,
  type ExpressionDiff,
} from './formulaDisplay';
import { dedupeOperands, sortOperandsMeshFirst } from './meshExpressionEdit';
import { analyzeOperand, appendFreeword, removeOperandAt, setOperandTerm } from './operandEdit';
import { ROUTE_LABELS } from '../router';
import type { AppState, BlocksDraft, BlockImprovementState, FormulaSaveState } from '../store';
import type { RenderView } from './types';

/**
 * 検索式手編集画面（#/edit）。
 *
 * ブロック（`#1`〜）ごとのカードを並べ、各ブロックに対して 3 つの編集手段を提供する:
 *
 * 1. **チップ編集（クイック編集。issue #58 chunk 3b）**: 鉛筆アイコンでカードを開くと、
 *    式が句（operand）単位のチップに割れる（editableBlock.ts）。MeSH は × で削除・リンクの
 *    まま、フリーワードは × で削除・クリックでその場編集、末尾の「＋ 語を追加」で新語を足せる。
 *    句の書き換えは operandEdit.ts の純関数（removeOperandAt / setOperandTerm /
 *    appendFreeword）に委譲し、editView 自身は文字列操作をしない。あわせて
 *    「重複する語を整理」「MeSH を先頭に並べ替え」（meshExpressionEdit.ts の
 *    dedupeOperands / sortOperandsMeshFirst）をクイック操作として置く。
 * 2. **詳細編集（生テキスト）**: チップ編集面の下にある折りたたみ。複合句（ネスト群。
 *    チップでは削除しかできない）や式全体の一括書き換えのための逃げ道。既定で閉じている。
 * 3. **ブロック単位 AI 改善（requirements.md §4.7）**: 「AI に改善させる」を押すと
 *    任意の指示文を入力する欄が開き（空でも可）、improve-block skill を実行する。送信時は
 *    兄弟ブロック（結合行を除く他の概念ブロック）を式・完全一致の共有語つきで渡す
 *    （blockInspector.ts の computeSiblingOverlaps。共有語 0 件の兄弟も渡す — 表記ゆれ・
 *    タグ違い等「完全一致しない重複」もありうるため、0 件を「重複なし」と決めつけて隠さない）
 *    ので、「#1 と重複するキーワードを消して」のような指示を根拠を持って実行できる
 *    （issue #89。以前は自分の式しか渡らず、過剰削除の原因になっていた）。
 *    提案 expression と rationale を句単位の diff（formulaDisplay.ts の diffExpressions /
 *    renderDiffSideInto）で色分け表示し、削除/追加語数のサマリを添えたうえで、
 *    「置き換える」で内部 md に反映する。
 *
 * ブロック行の下には、鉛筆または AI パネルを開いたときだけブロック・インスペクタ
 * （blockInspector.ts）を展開する。チップ・詳細編集・インスペクタの MeSH ブラウザ
 * （置換 / OR追加 / 削除）・Δ 表・他ブロックとの重複セクション（削除ボタン。issue #89）の
 * いずれから編集しても、同じ純粋関数（operandEdit / meshExpressionEdit）を経由した
 * 同じ結果になる。
 *
 * 上記 3 手段はいずれも `isCombination=false` の概念ブロックだけが対象（issue #88）。
 * `#3 #1 AND #2` のような掛け合わせ行（他ブロック ID への参照を含む行）は検索の実体を
 * 持たないため、✏️ / 「AI に改善させる」を出さず、読み取り表示と参照 ID を示す注記のみ
 * 表示する。掛け合わせ行の語を書き換えて参照を失うと、`expandFormula.ts` の
 * `chooseEntryBlockId` が「結合行なし → 最後の行」にフォールバックし、#1/#2 が効いていない
 * 式のまま捕捉率が計算・エクスポートされてしまう（ユーザーからは見えない回帰）。
 *
 * 4. **組み合わせ方の編集（issue #91）**: 掛け合わせ行だけに出る「組み合わせ方を編集」
 *    トグルで、参照と論理演算子の組み替え（`#1 AND #2` → `(#1 OR #2) AND #3` 等）だけを
 *    許可する。キーワードは書けない（`src/lib/combination-expression` の
 *    `validateCombinationExpression` が `#<id>` / `AND` / `OR` / `NOT` / `(` / `)`
 *    以外のトークンをすべて拒否するため、`asthma[tiab]` のような語は構文エラーになる）。
 *    保存は他の編集経路と同じ applyBlockImprovement を通すため、この式が必ず 1 つ以上の
 *    参照を含む（validateGrammar が空・演算子のみを弾く）ことと合わせて、#88 の参照整合性
 *    ガードと矛盾しない。#/blocks の結合式エディタ（blocksView.ts の
 *    `buildCombinationEditor`）と同じ検証ロジック・同じ文言のトーンを使う。
 *
 * 参照を保ったままの構造編集はこの 4 番目の手段に限定され、概念ブロック側の 3 手段は
 * 依然として掛け合わせ行の対象外のまま（キーワードの編集は各ブロックでのみ行う）。
 * 適用口 applyBlockImprovement（editService.ts）側にも同じ理由の参照整合性ガードがあり、
 * この画面はその最初の防波堤にすぎない。
 *
 * 検索式 Markdown 全文は `state.formulaEditDraft`、ブロック単位 AI 改善の進捗/提案/エラーは
 * `state.blockImprovement`、保存の進捗/結果/エラーは `state.formulaSave`、編集メモは
 * `state.formulaEditNote` から描画する（詳細は store.ts の doc コメント参照）。
 * いずれも LLM コスト集計（cumulativeCostUsd）や保存完了の setState による全ビュー再描画
 * （editView は再描画のたびに `container.innerHTML = ''` で丸ごと作り直す）でも消えない
 * ようにするための設計で、draftRun / validationResult / expandRun と同じ理由
 * （提案と md は issue #39、保存ステータスとメモは issue #42）。
 * 「AI への指示」プロンプトフォームの開閉・入力途中テキストは未送信の一時入力なので、
 * これだけは従来どおりローカル DOM のまま扱う。
 *
 * サービス呼び出しは bootstrap 側で editService の各関数を callback として渡す。
 */

export interface EditViewCallbacks
  extends Pick<
    BlockInspectorDeps,
    'onCountHits' | 'onFetchMeshTrees' | 'onFetchMeshChildren' | 'onFetchMeshLabels'
  > {
  /**
   * 編集中の md を新バージョンとして保存する。
   * 進捗・確認メッセージ・エラーは返り値ではなく store.formulaSave 経由で view に届く
   * （view は解決値を使わない。onImproveBlock と同じ思想。issue #42）。
   */
  onSave?: (input: SaveEditedFormulaInput) => Promise<void>;
  /**
   * 指定ブロックを LLM で改善させる（instruction はユーザー任意の指示）。
   * 結果は返り値ではなく store.blockImprovement 経由で view に届く（view は解決値を使わない）。
   */
  onImproveBlock?: (input: RequestBlockImprovementInput) => Promise<void>;
  /**
   * 「AI に渡す内容を見る」表示用の文脈スナップショットを取得する（SeedPapers 読み取りを伴う）。
   * siblings は onImproveBlock の submit 時に渡すのと同じ computeSiblingOverlaps の結果
   * （issue #89）。開示の内容と実際にプロンプトへ載る内容を一致させるため、view 側
   * （openAiPromptForm）で 1 度だけ計算したものをここへも渡す。
   */
  onGetImproveContext?: (
    blockId: string,
    siblings: SiblingOverlap[]
  ) => Promise<BlockImprovementContext | null>;
  /** 編集中の md 全文を store（formulaEditDraft）へ反映する */
  onDraftChange?: (markdown: string) => void;
  /** ブロック単位 AI 改善の提案を破棄する（accept / reject の両方で呼ぶ） */
  onClearImprovement?: () => void;
  /**
   * 編集メモを store（formulaEditNote）へ反映する（打鍵のたび＝input イベント）。
   * store 側は setStateSilently で受けるため、この呼び出しは再描画を誘発しない
   * （PR #43 の回帰対応。store.ts の FormulaEditNote doc コメント参照）。
   */
  onNoteChange?: (note: string) => void;
  /**
   * 「AI への指示」欄（初回・「指示を追加してやり直す」の追加指示欄の両方）を
   * store（blockImprovementInstruction）へ反映する（打鍵のたび＝input イベント）。
   * onNoteChange と同じく setStateSilently で受けるため、この呼び出しは再描画を誘発しない
   * （issue #90。store.ts の BlockImprovementInstruction doc コメント参照）。
   */
  onInstructionChange?: (blockId: string, instruction: string) => void;
  /**
   * 「AI への指示」欄（初回）を開く時点で store の最新値を読み直す（issue #92 C-3）。
   * buildBlockRow は行の描画時に resolveInstructionDraft を 1 度だけ評価してクロージャに
   * 閉じ込めるため、onInstructionChange（setStateSilently で再描画を起こさない）で store が
   * 更新された後に「パネルを閉じる→もう一度開く」をすると、描画時点の古い値（多くは空文字）が
   * 復元されてしまう（store には残っているのに戻らない）。このコールバックがあれば、
   * パネルを開く瞬間に常に最新値を読み直す。未配線（テスト等）では従来どおり描画時
   * スナップショット（instructionDraft 引数）にフォールバックする。
   */
  onGetInstructionDraft?: (blockId: string) => string;
  /**
   * 「提案を編集してから採用する」欄（issue #90）の未送信テキストを
   * store（blockImprovementManualEditDraft）へ反映する（打鍵のたび＝input イベント）。
   * onNoteChange / onInstructionChange と同じく setStateSilently で受けるため、
   * この呼び出しは再描画を誘発しない（issue #92 B-3。store.ts の
   * BlockImprovementManualEditDraft doc コメント参照）。
   */
  onManualEditChange?: (blockId: string, expression: string) => void;
}

/** 検索式 Markdown 全文を保持し、更新時にブロック一覧を再描画する内部コントローラ。 */
interface FormulaEditor {
  getMd(): string;
  /** md を差し替えてブロック一覧を再描画する */
  setMd(next: string): void;
}

/**
 * 表示する md を state から解決する。
 * formulaEditDraft が現在の formula バージョンと一致すればそちらを優先し、
 * 一致しない（stale、または未編集）なら currentFormulaMarkdown にフォールバックする。
 */
function resolveMarkdown(state: AppState, fallback: string): string {
  const draft = state.formulaEditDraft;
  if (draft !== null && draft.formulaVersionId === state.currentFormulaVersionId) {
    return draft.markdown;
  }
  return fallback;
}

/**
 * state.blockImprovement を現在の formula バージョンに照らして取り出す。
 * stale（別バージョンの提案）なら null を返す。
 */
function resolveBlockImprovement(state: AppState): BlockImprovementState | null {
  const improvement = state.blockImprovement;
  if (improvement === null || improvement.formulaVersionId !== state.currentFormulaVersionId) {
    return null;
  }
  return improvement;
}

/**
 * state.formulaSave を現在の formula バージョンに照らして取り出す。
 * saved は保存で採番された新しい版を持つので保存直後の current と一致し、
 * saving / error は保存前の版（保存が完了していないので current のまま）と一致する。
 * どちらにも当てはまらない（別バージョンを読み込み直した）なら stale として null を返す。
 */
function resolveSaveState(state: AppState): FormulaSaveState | null {
  const save = state.formulaSave;
  if (save === null || save.formulaVersionId !== state.currentFormulaVersionId) {
    return null;
  }
  return save;
}

/** state.formulaEditNote を現在の formula バージョンに照らして取り出す（stale なら空文字）。 */
function resolveNote(state: AppState): string {
  const note = state.formulaEditNote;
  if (note === null || note.formulaVersionId !== state.currentFormulaVersionId) {
    return '';
  }
  return note.note;
}

/**
 * ブロック・インスペクタ（blockInspector.ts）の計測結果キャッシュ + 開閉状態。
 *
 * `createEditView` は bootstrap 側で 1 回だけ呼ばれ、返り値の `RenderView` が再描画のたびに
 * 呼び出される（editView は再描画のたびに `container.innerHTML = ''` で丸ごと作り直す）。
 * この型の値は `createEditView` の戻り値を作る前（＝返り値のクロージャの外側）に生成して
 * 保持することで、再描画をまたいで生存させる。そうしないと:
 * - `caches` 側: 同じ式を再描画のたびに esearch / MeSH RDF へ問い合わせ直してしまう
 *   （blockInspector.ts の `BlockInspectorDeps` 各 doc コメント参照）
 * - `editOpenBlocks` / `aiOpenBlocks` 側: 「どのブロックの鉛筆編集面 / AI パネルを開いたか」が
 *   LLM コスト集計（cumulativeCostUsd）等、他ブロックの操作起点の setState による全ビュー
 *   再描画で閉じてしまう（issue #39 / #42 と同じ構造の回帰。issue #58 chunk 3a）
 *
 * `editOpenBlocks` と `aiOpenBlocks` を分けているのは、鉛筆（チップ編集 + 詳細編集）と
 * AI 指示フォームは独立に開閉できるため。片方の開閉判定にもう片方の集合を参照する必要が
 * 無くなる分、chunk 3a で必要だった「両方閉じていたら削除」という相互参照ロジックが要らなくなる
 * （インスペクタの表示可否は `isInspectorOpen` で両集合の OR を取る）。
 *
 * `combinationOpenBlocks`（issue #91）は掛け合わせ行の「組み合わせ方を編集」パネルの開閉状態。
 * 概念ブロックにしか出ない `editOpenBlocks` / `aiOpenBlocks` とは対象ブロックの集合が排他
 * （`isCombination` で分岐が別れる）なので、同じ ID が両方に載ることは無いが、意味が異なる
 * ため別集合として持つ。
 */
interface EditInspectorRuntime {
  caches: Pick<
    BlockInspectorDeps,
    | 'hitsCache'
    | 'hitsSnapshot'
    | 'freewordDeltaCache'
    | 'freewordDeltaSnapshot'
    | 'meshTreeCache'
    | 'meshChildrenCache'
    | 'meshLabelCache'
    | 'meshExpandedState'
  >;
  /** 鉛筆（チップ編集 + 「詳細編集（生テキスト）」）を開いたブロック ID の集合。 */
  editOpenBlocks: Set<string>;
  /**
   * AI 指示入力フォーム（未送信）を開いたブロック ID の集合。
   * AI 改善の結果（running/ready/error）は store.blockImprovement 由来で毎描画ごとに
   * 判定できるためここには含めない（`isInspectorOpen` 参照）。
   */
  aiOpenBlocks: Set<string>;
  /**
   * 掛け合わせ行の「組み合わせ方を編集」パネル（issue #91）を開いたブロック ID の集合。
   * editOpenBlocks / aiOpenBlocks と同じ理由（他ブロックの操作起点の setState による
   * 全ビュー再描画でパネルが閉じてしまうのを防ぐため）で、createEditView の戻り値の
   * クロージャの外側に置いて再描画をまたいで生存させる。
   */
  combinationOpenBlocks: Set<string>;
}

function createInspectorRuntime(): EditInspectorRuntime {
  return {
    caches: {
      hitsCache: new Map(),
      // hitsCache / freewordDeltaCache の確定値スナップショット。「AI に改善させる」submit 時に
      // collectMeasuredContext が同期的（新規 esearch なし）に読む（issue #58 chunk 3c）。
      hitsSnapshot: new Map(),
      freewordDeltaCache: new Map(),
      freewordDeltaSnapshot: new Map(),
      meshTreeCache: new Map(),
      meshChildrenCache: new Map(),
      meshLabelCache: new Map(),
      meshExpandedState: new Map(),
    },
    editOpenBlocks: new Set(),
    aiOpenBlocks: new Set(),
    combinationOpenBlocks: new Set(),
  };
}

/** このブロックのインスペクタを表示すべきか（明示的に開いた、または AI 改善結果を表示中）。 */
function isInspectorOpen(
  inspector: EditInspectorRuntime,
  blockId: string,
  improvement: BlockImprovementState | null
): boolean {
  return (
    inspector.editOpenBlocks.has(blockId) ||
    inspector.aiOpenBlocks.has(blockId) ||
    improvement !== null
  );
}

/**
 * ブロック ID（`"1"`, `"2"`, …）から blocksDraft 上のラベルを解決する。
 * draftView.ts の `renderLiveBlockHits`（blocksDraft.blocks[index] ↔ `#${index + 1}`）と
 * 同じ「1 始まりの通し番号 = blocksDraft の並び順」という規約に合わせている。
 * 数値でない ID（フィルタ・結合行）や対応する定義が無ければ null（インスペクタは ID のみ表示）。
 *
 * この規約は blocksDraft の並び順と formula の #ID 発番がずれると崩れる heuristic（例えば
 * 手編集でブロックを挿入・並べ替えた場合）だが、影響は「他ブロックとの重複」セクションの
 * 表示ラベルだけで、比較対象そのもの（siblings の選定）には影響しない。表示上の見栄えの
 * リスクとして許容している（issue #58 chunk 3a）。
 */
function resolveBlockLabel(blocksDraft: BlocksDraft | null, blockId: string): string | null {
  const index = Number.parseInt(blockId, 10);
  if (!Number.isFinite(index) || index < 1) {
    return null;
  }
  const label = blocksDraft?.blocks[index - 1]?.blockLabel?.trim();
  return label && label !== '' ? label : null;
}

export function createEditView(callbacks: EditViewCallbacks = {}): RenderView {
  const inspector = createInspectorRuntime();
  return (container, ctx) => {
    container.innerHTML = '';
    const doc = container.ownerDocument;
    const heading = doc.createElement('h2');
    heading.textContent = ROUTE_LABELS.edit;
    container.appendChild(heading);

    if (!ctx.state.project) {
      const warn = doc.createElement('p');
      warn.className = 'view__placeholder';
      warn.textContent = '先にプロジェクトを選択してください。';
      container.appendChild(warn);
      return;
    }
    if (!ctx.state.currentFormulaMarkdown) {
      const warn = doc.createElement('p');
      warn.className = 'view__placeholder';
      warn.textContent = '先に /draft で検索式を生成するか、/history で読み込んでください。';
      container.appendChild(warn);
      return;
    }

    const lead = doc.createElement('p');
    lead.className = 'edit__lead';
    lead.textContent =
      '各ブロックは鉛筆アイコンでチップ編集するか、「AI に改善させる」で再設計できます。最後に「新バージョンとして保存」を押すと FormulaVersions に user_edit として追記されます。';
    container.appendChild(lead);

    // 表示する md は store（formulaEditDraft）優先、無ければ現在の formula。
    // テキストエリアは表示せず、この変数を単一の真実とする。
    let currentMd = resolveMarkdown(ctx.state, ctx.state.currentFormulaMarkdown);
    const editor: FormulaEditor = {
      getMd: () => currentMd,
      setMd: (next: string) => {
        if (callbacks.onDraftChange) {
          // store 更新 → 再描画で反映される（この render 実行のローカル DOM はそのまま
          // 破棄される想定なので、ここではローカル再描画をしない）。
          callbacks.onDraftChange(next);
          return;
        }
        // callback 未指定時は view 単体で完結させるためローカル再描画にフォールバックする。
        currentMd = next;
        rerenderBlocks();
      },
    };

    // ブロック単位 AI 改善の提案（running/ready/error）。store 由来の値で初期化するが、
    // 「引っ込める」操作（改善ボタンのトグル close / 破棄 / 置換）を store 未配線
    // （onClearImprovement が無い＝フォールバック経路）で扱うときだけ再代入する。
    // rerenderBlocks はこの変数を都度参照するので、null にしておけば以後何度ローカル
    // 再描画が起きても同じ提案が復元されない（store 配線ありなら store 側の再描画で
    // resolveBlockImprovement が毎回 null を返すのでこちらは触らなくてよい）。
    let improvement = resolveBlockImprovement(ctx.state);

    /**
     * 提案パネル（ready/error）を恒久的に引っ込める。
     * 配線あり: onClearImprovement() を呼んで store.blockImprovement を消す（同期的に
     * 全ビュー再描画が走り、以後は resolveBlockImprovement 経由で常に null になる）。
     * 配線なし（フォールバック）: 上の `improvement` を null にする。DOM 自体は
     * 呼び出し元（トグル close / renderProposal の accept・reject）が空にする。
     */
    function clearImprovement(): void {
      if (callbacks.onClearImprovement) {
        callbacks.onClearImprovement();
        return;
      }
      improvement = null;
    }
    // renderBlockList 以下（buildBlockRow / renderProposal）へは、onClearImprovement を
    // 上の clearImprovement で常に上書きしたバージョンを渡す。配線あり/なしの分岐を
    // 呼び出し側に持たせず、末端は常に「呼べば恒久的に引っ込む」ものとして扱えるようにする。
    const internalCallbacks: EditViewCallbacks = {
      ...callbacks,
      onClearImprovement: clearImprovement,
    };

    const blocksSection = doc.createElement('section');
    blocksSection.className = 'edit__blocks';
    const blocksHeading = doc.createElement('h3');
    blocksHeading.textContent = 'ブロック';
    blocksSection.appendChild(blocksHeading);
    // MeSH / フリーワードの色分け凡例（読み取り表示・チップ編集・AI 差分の 3 か所で共通）。
    blocksSection.appendChild(buildLegend(doc));
    // 検索式の構造上の問題（掛け合わせ行なし / 参照されないブロック）をブロック一覧の
    // 直前に注意表示するスロット（issue #88）。保存は止めない。
    const noticeSlot = doc.createElement('div');
    noticeSlot.className = 'edit__consistency-notices';
    blocksSection.appendChild(noticeSlot);
    const blocksList = doc.createElement('ul');
    blocksList.className = 'edit__block-list';
    blocksSection.appendChild(blocksList);
    container.appendChild(blocksSection);

    const noteRow = doc.createElement('p');
    noteRow.className = 'edit__note-row';
    const noteLabel = doc.createElement('label');
    noteLabel.textContent = '編集メモ:';
    const noteInput = doc.createElement('input');
    noteInput.type = 'text';
    noteInput.className = 'edit__note-input';
    noteInput.placeholder = '変更理由・気づきなど（任意）';
    noteInput.value = resolveNote(ctx.state);
    // 打鍵のたび（input）に store へ送る。onNoteChange は setStateSilently で書き込むため
    // 再描画は起きず、開いている鉛筆編集フォームや AI 指示欄を壊さない。
    // （旧実装は change＝blur/Enter でだけ通常の setState を行っていたが、これだと
    // メモ欄から直接ボタンを押したときの mousedown が change の再描画に巻き込まれて
    // ボタンが DOM から切り離され、1 回目のクリックが飲まれる回帰を生んだ。PR #43 対応）
    noteInput.addEventListener('input', () => {
      callbacks.onNoteChange?.(noteInput.value);
    });
    noteLabel.appendChild(noteInput);
    noteRow.appendChild(noteLabel);
    container.appendChild(noteRow);

    const save = resolveSaveState(ctx.state);

    const actions = doc.createElement('div');
    actions.className = 'edit__actions';
    const saveBtn = doc.createElement('button');
    saveBtn.type = 'button';
    saveBtn.textContent = '新バージョンとして保存';
    // 保存中の二重起動防止（実行そのものの排他は bootstrap 側の guard が担う）。
    saveBtn.disabled = save?.status === 'saving';
    actions.appendChild(saveBtn);
    container.appendChild(actions);

    const status = doc.createElement('p');
    status.className = 'edit__status';
    status.setAttribute('aria-live', 'polite');
    status.textContent = formatSaveStatus(save);
    container.appendChild(status);

    const errorBox = doc.createElement('p');
    errorBox.className = 'edit__error';
    errorBox.setAttribute('aria-live', 'polite');
    errorBox.textContent = save?.status === 'error' ? (save.error ?? '不明なエラー') : '';
    container.appendChild(errorBox);

    function rerenderBlocks(): void {
      renderBlockList(
        doc,
        blocksList,
        noticeSlot,
        editor,
        internalCallbacks,
        improvement,
        ctx.state,
        inspector
      );
    }
    rerenderBlocks();

    saveBtn.addEventListener('click', () => {
      if (!callbacks.onSave) {
        return;
      }
      // メモは「今画面に入っている値」を直接読む（change 未発火の打鍵も保存内容に含める）。
      // 進捗・確認メッセージ・エラーは store.formulaSave 経由で描画されるため、
      // ここでは解決値を扱わない（onSave の同期部分が status='saving' の setState を起こし、
      // このボタンを含む DOM は即座に作り直される。issue #42）。
      void callbacks.onSave({ formulaMd: editor.getMd(), note: noteInput.value });
    });
  };
}

/** 保存ステータス行（`p.edit__status`）の文言。error 時は `.edit__error` 側に出すので空にする。 */
function formatSaveStatus(save: FormulaSaveState | null): string {
  if (save === null || save.status === 'error') {
    return '';
  }
  if (save.status === 'saving') {
    return '保存中…';
  }
  // saved の formulaVersionId は保存で採番された新しい版そのもの（store.ts の doc コメント参照）。
  return `保存しました（version_id: ${save.formulaVersionId}）`;
}

/**
 * editor.getMd() を parsePubmedFormulaMd でブロック分解し、各ブロックのカードを再描画する。
 * パースに失敗した場合はその旨を表示する。
 *
 * blocksDraft ではなく state 全体を受け取るのは、ブロックラベル解決（resolveBlockLabel）に
 * 加えて「AI への指示」欄の未送信ドラフト（resolveInstructionDraft。issue #90）もブロックごとに
 * state から解決する必要があるため。
 */
function renderBlockList(
  doc: Document,
  ul: HTMLElement,
  noticeSlot: HTMLElement,
  editor: FormulaEditor,
  callbacks: EditViewCallbacks,
  improvement: BlockImprovementState | null,
  state: AppState,
  inspector: EditInspectorRuntime
): void {
  ul.innerHTML = '';
  noticeSlot.innerHTML = '';
  let formula;
  try {
    formula = parsePubmedFormulaMd(editor.getMd());
  } catch (err) {
    const warn = doc.createElement('li');
    warn.className = 'edit__block-error';
    warn.textContent = `現状の検索式が PubMed セクション形式としてパースできません: ${formatError(err)}`;
    ul.appendChild(warn);
    return;
  }
  if (formula.blocks.length === 0) {
    const empty = doc.createElement('li');
    empty.className = 'edit__block-empty';
    empty.textContent = 'ブロックがありません。';
    ul.appendChild(empty);
    return;
  }
  renderConsistencyNotices(doc, noticeSlot, formula);
  // インスペクタの「他ブロックとの重複」セクション向け。結合行（他ブロック ID を参照する行）は
  // 検索の実体を持たないので概念ブロックの比較対象から除く（requirements: ブロック編集インスペクタ）。
  const conceptBlocks = formula.blocks.filter((b) => !b.isCombination);
  const knownIds = new Set(formula.blocks.map((b) => b.id));
  for (const block of formula.blocks) {
    const siblings: SiblingBlock[] = conceptBlocks
      .filter((b) => b.id !== block.id)
      .map((b) => ({
        id: b.id,
        label: resolveBlockLabel(state.blocksDraft, b.id),
        expression: b.expression,
      }));
    // 掛け合わせ行のみ: 注記に出す「どのブロックの掛け合わせか」（issue #88）。
    const combinationRefs = block.isCombination
      ? extractBlockReferences(block.expression, block.id, knownIds)
      : [];
    // 「組み合わせ方を編集」パネル（issue #91）の参照先候補。この結合行自身の ID は
    // 除く（自己参照は validateGrammar 上は書けてしまうが意味を持たないため）。
    // 概念ブロックだけでなく #Filter1 のようなフィルタブロックも参照先になりうるので、
    // isCombination で絞り込まずブロック全体の ID 集合から自分の ID だけを除く。
    const combinationKnownIds = new Set(Array.from(knownIds).filter((id) => id !== block.id));
    ul.appendChild(
      buildBlockRow(
        doc,
        block.id,
        block.expression,
        block.isCombination,
        combinationRefs,
        combinationKnownIds,
        formula,
        editor,
        callbacks,
        improvement !== null && improvement.blockId === block.id ? improvement : null,
        siblings,
        inspector,
        resolveInstructionDraft(state, block.id),
        resolveManualEditDraft(state, block.id)
      )
    );
  }
}

/**
 * state.blockImprovementInstruction を指定ブロックについて解決する（stale なら空文字）。
 * openAiPromptForm の初回指示欄と renderProposal の「指示を追加してやり直す」欄は、同一ブロックの
 * AI パネル内で同時に表示されることが無い（status='ready' かどうかで排他的に切り替わる）ため、
 * 同じフィールドを共有する（issue #90。store.ts の BlockImprovementInstruction doc コメント参照）。
 *
 * export しているのは bootstrap.ts の onGetInstructionDraft コールバックが同じ解決ロジックを
 * 再実装せずそのまま使うため（issue #92 C-3。resolveInstructionDraft(state, blockId) の
 * 呼び出し元が render 時スナップショットと open 時の最新読み直しの 2 箇所に増えたので、
 * ロジックが 2 箇所に分岐しないよう単一の関数へ集約する）。
 */
export function resolveInstructionDraft(state: AppState, blockId: string): string {
  const draft = state.blockImprovementInstruction;
  if (
    draft === null ||
    draft.formulaVersionId !== state.currentFormulaVersionId ||
    draft.blockId !== blockId
  ) {
    return '';
  }
  return draft.instruction;
}

/**
 * state.blockImprovementManualEditDraft を指定ブロックについて解決する（issue #92 B-3）。
 * stale（別バージョン/別ブロック）または未入力なら null を返し、呼び出し元（renderProposal）は
 * result.proposedExpression を初期値にフォールバックする。resolveInstructionDraft と違い
 * 空文字にフォールバックしないのは、「ユーザーが手編集欄を空にした」状態と「まだ何も
 * 触っていない」状態を区別する必要があるため（後者は proposedExpression を出したい）。
 */
function resolveManualEditDraft(state: AppState, blockId: string): string | null {
  const draft = state.blockImprovementManualEditDraft;
  if (
    draft === null ||
    draft.formulaVersionId !== state.currentFormulaVersionId ||
    draft.blockId !== blockId
  ) {
    return null;
  }
  return draft.expression;
}

/**
 * ブロック一覧の直前に、検索式の構造上の問題を注意表示する（issue #88）。保存は止めない。
 *
 * - 掛け合わせ行が 1 本も無い: `expandFormula.ts` の `chooseEntryBlockId` は結合行が
 *   無ければ最後の行を起点にフォールバックするため、それ以外の行が検索に反映されない。
 *   ただし**ブロックが 1 本しか無い式ではこのフォールバックこそが正しい挙動**（掛け合わせる
 *   相手がそもそも存在しない）なので、`formula.blocks.length > 1` のときだけこの注意を出す
 *   （issue #92 B-6。1 ブロック式は元々「最後の行を起点にする」以外の設計があり得ず、
 *   このガードが無いと恒久的な偽陽性の警告になっていた）。
 * - `findUnreachableBlockIds` が非空: 起点から辿れないブロックがある（結合行の編集で
 *   参照を書き換えた、または最初から漏れていた等）。
 */
function renderConsistencyNotices(doc: Document, slot: HTMLElement, formula: PubmedFormula): void {
  const hasCombination = formula.blocks.some((b) => b.isCombination);
  if (!hasCombination && formula.blocks.length > 1) {
    slot.appendChild(
      buildConsistencyNotice(
        doc,
        '⚠ ブロックを掛け合わせる行（例: #3 #1 AND #2）がありません。このままでは最後の行だけが検索式として扱われます。'
      )
    );
  }
  const unreachable = findUnreachableBlockIds(formula);
  if (unreachable.length > 0) {
    const list = unreachable.map((id) => `#${id}`).join('、');
    slot.appendChild(
      buildConsistencyNotice(doc, `⚠ ${list} はどの行からも参照されていません。検索に反映されません。`)
    );
  }
}

function buildConsistencyNotice(doc: Document, text: string): HTMLElement {
  const p = doc.createElement('p');
  p.className = 'edit__consistency-notice';
  p.textContent = text;
  return p;
}

function buildBlockRow(
  doc: Document,
  blockId: string,
  expression: string,
  isCombination: boolean,
  combinationRefs: string[],
  combinationKnownIds: ReadonlySet<string>,
  formula: PubmedFormula,
  editor: FormulaEditor,
  callbacks: EditViewCallbacks,
  improvement: BlockImprovementState | null,
  siblings: SiblingBlock[],
  inspector: EditInspectorRuntime,
  instructionDraft: string,
  manualEditDraft: string | null
): HTMLElement {
  const li = doc.createElement('li');
  li.className = 'edit__block-row';
  li.setAttribute('data-block-id', blockId);

  const header = doc.createElement('div');
  header.className = 'edit__block-header';
  const idSpan = doc.createElement('span');
  idSpan.className = 'edit__block-id';
  idSpan.textContent = `#${blockId}`;
  header.appendChild(idSpan);

  // 読み取り表示（MeSH / フリーワードを色分け。formulaDisplay.ts の renderExpressionInto）。
  // 鉛筆編集面が開いている間は隠す（旧実装からの継続）。掛け合わせ行でも変わらず出す。
  const currentPre = doc.createElement('pre');
  currentPre.className = 'edit__block-current';
  renderExpressionInto(currentPre, expression);

  // 掛け合わせ行（isCombination=true）には ✏️ / 「AI に改善させる」を出さない（issue #88）。
  // 読み取り表示 + 参照 ID を示す注記に加えて、「組み合わせ方を編集」パネル（issue #91）だけを
  // 出す。編集スロット・AI スロット・インスペクタスロットと、それらのイベント配線は作らない
  // （この関数の残りは概念ブロック専用として進む）。
  if (isCombination) {
    li.classList.add('edit__block-row--combination');
    li.appendChild(header);
    li.appendChild(currentPre);
    const note = doc.createElement('p');
    note.className = 'edit__block-combination-note';
    const refList = combinationRefs.map((id) => `#${id}`).join('、');

    // 参照 / 演算子（AND OR NOT）/ 括弧だけで構成される「純粋な掛け合わせ行」か、
    // `#4 #1 AND #2 AND humans[mh]` のように参照とリテラル検索語が混在する行かを判定する。
    // 独自パーサは書かず tokenizeCombination のエラー有無だけで判定する（issue #88 の
    // 分岐は isCombination（extractBlockReferences が 1 件でも参照を拾えば true）でしか
    // 判定していないため、キーワード混在行も ✏️ / AI 抜きになる一方、唯一残る「組み合わせ方を
    // 編集」パネルも validateCombinationExpression が既存のキーワードをエラーにして保存できず、
    // この行を編集する手段が画面から消えていた。この退行を直す）。
    const isPureCombination = tokenizeCombination(expression).errors.length === 0;

    if (!isPureCombination) {
      // リテラル語混在行: チップ編集・AI 改善は出さない（#88 の趣旨どおり。参照を失う
      // 編集を防ぐため）。「組み合わせ方を編集」パネルも出さない（保存できないため）。
      // 代わりに従来どおりの生テキスト編集（buildRawEditForm）を逃げ道として残す。
      // 保存は他の編集経路と同じ applyBlockImprovement を通るため、#88 の参照整合性ガード
      // （assertReferenceIntegrity）はここでも変わらず効く。
      note.textContent =
        refList === ''
          ? 'この行には参照以外の検索語が混ざっているため「組み合わせ方を編集」は使えません。下の詳細編集（生テキスト）で式を直接書き換えてください。'
          : `この行は ${refList} を参照していますが、参照以外の検索語も混ざっているため「組み合わせ方を編集」は使えません。下の詳細編集（生テキスト）で式を直接書き換えてください。`;
      li.appendChild(note);

      const rawEditSlot = doc.createElement('div');
      rawEditSlot.className = 'edit__block-combination-rawedit';
      li.appendChild(rawEditSlot);
      // この行専用の開閉状態は持たず常時表示する（editOpenBlocks / combinationOpenBlocks は
      // どちらもこの行の対象外）。「キャンセル」は入力中のテキストを現在の expression へ
      // 戻すためだけに、このスロットだけを再構築する。
      const renderRawEdit = (): void => {
        rawEditSlot.innerHTML = '';
        rawEditSlot.appendChild(buildRawEditForm(doc, blockId, expression, editor, renderRawEdit));
      };
      renderRawEdit();
      return li;
    }

    note.textContent =
      refList === ''
        ? 'この行は他のブロックを掛け合わせる行です。組み合わせ方は編集できますが、語の編集は各ブロックで行ってください。'
        : `この行は ${refList} の掛け合わせです。組み合わせ方は編集できますが、語の編集は各ブロックで行ってください。`;
    li.appendChild(note);

    const combinationToggle = doc.createElement('button');
    combinationToggle.type = 'button';
    combinationToggle.className = 'edit__block-combination-toggle';
    combinationToggle.textContent = '組み合わせ方を編集';
    combinationToggle.setAttribute('aria-expanded', 'false');
    li.appendChild(combinationToggle);

    const combinationPanelSlot = doc.createElement('div');
    combinationPanelSlot.className = 'edit__block-combination-panel';
    li.appendChild(combinationPanelSlot);

    /**
     * inspector.combinationOpenBlocks に基づいてパネルを描画し直す。
     * editSlot / aiSlot と同じ「開くべきか判定に DOM を見ない」規則（syncInspector 参照）。
     * ESLint no-inner-declarations（if ブロック内での function 宣言）を避けるため
     * 関数式で定義する（他の syncXxx は buildBlockRow の直下＝関数ボディの root にあるので
     * 通常の function 宣言のままでよいが、これは isCombination 分岐の内側にあるため）。
     */
    const syncCombinationPanel = (): void => {
      combinationPanelSlot.innerHTML = '';
      const open = inspector.combinationOpenBlocks.has(blockId);
      combinationToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (!open) {
        return;
      }
      combinationPanelSlot.appendChild(
        buildCombinationEditPanel(
          doc,
          blockId,
          expression,
          combinationKnownIds,
          formula,
          editor,
          () => {
            inspector.combinationOpenBlocks.delete(blockId);
            syncCombinationPanel();
          }
        )
      );
    };
    syncCombinationPanel();

    combinationToggle.addEventListener('click', () => {
      if (inspector.combinationOpenBlocks.has(blockId)) {
        inspector.combinationOpenBlocks.delete(blockId);
      } else {
        inspector.combinationOpenBlocks.add(blockId);
      }
      syncCombinationPanel();
    });

    return li;
  }

  const tools = doc.createElement('div');
  tools.className = 'edit__block-tools';
  const editToggle = doc.createElement('button');
  editToggle.type = 'button';
  editToggle.className = 'edit__block-edit-toggle';
  editToggle.textContent = '✏️';
  editToggle.title = 'このブロックを編集';
  editToggle.setAttribute('aria-label', `ブロック #${blockId} を編集`);
  tools.appendChild(editToggle);
  const improveBtn = doc.createElement('button');
  improveBtn.type = 'button';
  improveBtn.className = 'edit__block-improve';
  improveBtn.textContent = 'AI に改善させる';
  // 進行中は二重起動を防ぐため disabled にする（状態は store.blockImprovement 由来）。
  improveBtn.disabled = improvement?.status === 'running';
  tools.appendChild(improveBtn);
  header.appendChild(tools);
  li.appendChild(header);
  li.appendChild(currentPre);

  // インライン手編集用スロット（鉛筆ボタンで開く）。中身は syncEditSlot が組む
  // （チップ編集 + クイック整理 + 「詳細編集（生テキスト）」）。
  const editSlot = doc.createElement('div');
  editSlot.className = 'edit__block-edit';
  li.appendChild(editSlot);

  // AI 改善（プロンプト欄 → 提案）用スロット。
  // running / ready / error は store.blockImprovement から復元する（再描画に耐えるため）。
  const aiSlot = doc.createElement('div');
  aiSlot.className = 'edit__block-ai';
  aiSlot.setAttribute('aria-live', 'polite');
  li.appendChild(aiSlot);
  if (improvement) {
    renderImprovementState(
      doc,
      aiSlot,
      improvement,
      editor,
      callbacks,
      blockId,
      siblings,
      inspector.caches,
      instructionDraft,
      manualEditDraft
    );
  }

  // ブロック・インスペクタ（requirements: 検索式編集の MeSH/フリーワード可視化）用スロット。
  // 鉛筆編集または AI 改善パネルを開いたときだけ、このブロックの下に展開する（issue #58 chunk 3a）。
  const inspectorSlot = doc.createElement('div');
  inspectorSlot.className = 'edit__block-inspector';
  li.appendChild(inspectorSlot);

  /**
   * ブロック式を newExpression へ差し替える（チップ / クイック整理 / インスペクタの
   * MeSH ブラウザ・Δ 表からの編集の共通適用口。issue #58 chunk 3b）。
   *
   * - 変化が無ければ何もしない（無駄な再描画をしない）。
   * - 差し替え後に式が空になる操作は拒否し、onError（渡されていれば）へ理由を伝える
   *   （ブロック行が空文字になると formula_md の再パースが壊れるため）。
   * - 成功時は editor.setMd（store 経由 / フォールバックローカル再描画のいずれでも同期的に
   *   完了する）でブロック一覧を作り直したあと、focusTerm があれば同じ語のチップへ
   *   フォーカスを戻す（要素の消失でフォーカスが body に落ちるのを防ぐ）。
   *
   * 詳細編集（生テキスト）の保存は、この関数を経由しない（無変更でも常に commit する・
   * 空文字は独自の文言で弾く、という元のインライン編集の挙動をそのまま保つため）。
   *
   * applyBlockImprovement は参照整合性ガード（editService.ts の assertReferenceIntegrity）が
   * 違反時に throw する。チップ編集で語を `#1` のような参照風の文字列にリネームする、
   * インスペクタの Δ 表・MeSH ブラウザ・他ブロックとの重複セクション経由の編集で参照が
   * 混入する、といった操作はここを経由するため、try/catch せずに呼ぶと例外が click リスナの
   * 外へ抜け、チップ UI は更新されずユーザーには無反応＋console エラーしか残らない
   * （生テキスト編集経路の buildRawEditForm と AI accept 経路の renderProposal は元から
   * try/catch している。issue #92 B-2）。
   */
  function commitExpression(
    nextExpression: string,
    focusTerm: string | null,
    onError?: (message: string) => void
  ): void {
    const next = nextExpression.trim();
    if (next === expression.trim()) {
      return;
    }
    if (next === '') {
      onError?.('ブロックを空にすることはできません。');
      return;
    }
    try {
      editor.setMd(applyBlockImprovement(editor.getMd(), blockId, next));
    } catch (err) {
      onError?.(`更新に失敗しました: ${formatError(err)}`);
      return;
    }
    restoreChipFocus(doc, blockId, focusTerm);
  }

  /**
   * inspector.editOpenBlocks / aiOpenBlocks / store.blockImprovement の現在値に基づいて
   * インスペクタを描画し直す。「開くべきか」の判定に editSlot / aiSlot の DOM を見ないのは、
   * この関数は行の初回構築時（まだ何もクリックしていない時点）にも呼ぶため。
   */
  function syncInspector(): void {
    inspectorSlot.innerHTML = '';
    if (!isInspectorOpen(inspector, blockId, improvement)) {
      return;
    }
    const el = buildBlockInspector(doc, {
      blockId,
      expression,
      siblings,
      onCountHits: callbacks.onCountHits,
      onFetchMeshTrees: callbacks.onFetchMeshTrees,
      onFetchMeshChildren: callbacks.onFetchMeshChildren,
      onFetchMeshLabels: callbacks.onFetchMeshLabels,
      // MeSH ブラウザの置換 / OR追加 / 削除、Δ 表の語編集・削除、他ブロックとの重複セクション
      // の削除ボタン（issue #89）を有効化する。チップ編集面と同じ commitExpression を通すので、
      // インスペクタ側から触ってもチップ側から触っても同じ結果になる（blockInspector.ts の
      // doc コメント参照）。onError は式が空になる等で拒否されたときの理由を呼び出し元
      // （重複セクションのエラー行）へ伝える。
      onApplyExpression: (next, onError) => commitExpression(next, null, onError),
      ...inspector.caches,
    });
    if (el) {
      inspectorSlot.appendChild(el);
    }
  }

  /**
   * inspector.editOpenBlocks に基づいて editSlot（チップ編集 + 詳細編集）を描画し直す。
   * `editOpenBlocks` は再描画をまたいで保持されるため、チップ操作（commitExpression）
   * 自身が引き起こす再描画でもパネルは開いたまま保たれる（何度も鉛筆を押し直さずに
   * 連続して句を削除・編集できる）。
   */
  function syncEditSlot(): void {
    editSlot.innerHTML = '';
    const open = inspector.editOpenBlocks.has(blockId);
    if (!open) {
      currentPre.style.display = '';
      editToggle.removeAttribute('aria-expanded');
      return;
    }
    currentPre.style.display = 'none';
    editToggle.setAttribute('aria-expanded', 'true');
    renderEditPanel(doc, editSlot, blockId, expression, editor, commitExpression, closeEditSlot);
  }

  function openEditSlot(): void {
    inspector.editOpenBlocks.add(blockId);
    syncEditSlot();
    syncInspector();
  }

  function closeEditSlot(): void {
    inspector.editOpenBlocks.delete(blockId);
    syncEditSlot();
    syncInspector();
  }

  syncEditSlot();
  syncInspector();

  editToggle.addEventListener('click', () => {
    if (inspector.editOpenBlocks.has(blockId)) {
      closeEditSlot();
    } else {
      openEditSlot();
    }
  });

  improveBtn.addEventListener('click', () => {
    if (!callbacks.onImproveBlock) {
      return;
    }
    if (aiSlot.childElementCount > 0) {
      // 既に開いていればトグルで閉じる。
      aiSlot.innerHTML = '';
      // aiOpenBlocks の削除は、この下の onClearImprovement()（store 配線ありなら同期的に
      // 全ビュー再描画を起こし、この行を含む DOM 全体が作り直される）より前に済ませる。
      // 後回しにすると、再描画で作り直された新しい行がまだ更新前の aiOpenBlocks を読んで
      // しまい、閉じたはずのインスペクタが再構築後の行に残ってしまう（issue #58 chunk 3a）。
      inspector.aiOpenBlocks.delete(blockId);
      if (improvement) {
        // store 由来の提案パネル（ready/error）を閉じる場合は恒久的に引っ込める
        // （呼ばなければ次の再描画で同じ内容が復元されてしまう）。
        // improvement が null（＝未送信の指示入力フォームを閉じるだけ）のときは
        // store 側に消すものが無いので呼ばない（他ブロックの編集中の状態を無駄に
        // 巻き込む全ビュー再描画を誘発しないため）。
        callbacks.onClearImprovement?.();
      }
      // store 未配線（フォールバック）時は上の呼び出しで再描画が起きないため、
      // この行自身を明示的に同期する（配線ありのときは既に破棄された行への呼び出しに
      // なるだけで無害）。
      syncInspector();
      return;
    }
    openAiPromptForm(
      doc,
      aiSlot,
      blockId,
      expression,
      siblings,
      callbacks.onImproveBlock,
      callbacks.onGetImproveContext,
      inspector.caches,
      () => {
        // 「キャンセル」（未送信のまま閉じる）は上の分岐を通らないので個別に処理する。
        inspector.aiOpenBlocks.delete(blockId);
        syncInspector();
      },
      // パネルを開く瞬間に store の最新値を読み直す（issue #92 C-3）。callback 未配線
      // （テスト等）では従来どおり行の描画時スナップショット instructionDraft を使う。
      callbacks.onGetInstructionDraft?.(blockId) ?? instructionDraft,
      callbacks.onInstructionChange
    );
    inspector.aiOpenBlocks.add(blockId);
    syncInspector();
  });

  return li;
}

/**
 * チップ編集のコミット後、フォーカスを妥当な場所へ戻す。
 *
 * commitExpression は editor.setMd を呼んだ時点でブロック一覧が（store 経由 / フォールバック
 * ローカル再描画のいずれでも）同期的に作り直されているため、この関数が呼ばれる時点で
 * クリックされた × ボタンや確定した input は既に DOM から切り離されている。何もしないと
 * フォーカスが document.body へ落ちる（要素が消えたときのブラウザの既定動作）ため、
 * 明示的に戻す。
 *
 * - focusTerm が指定されていれば、同じ語（data-operand-term。editableBlock.ts 参照）の
 *   チップへ戻す。
 * - 見つからなければ「＋ 語を追加」ボタン、それも無ければ鉛筆ボタンへ戻す。
 */
function restoreChipFocus(doc: Document, blockId: string, focusTerm: string | null): void {
  const row = doc.querySelector<HTMLElement>(`.edit__block-row[data-block-id="${blockId}"]`);
  if (!row) {
    return;
  }
  if (focusTerm !== null) {
    for (const chip of Array.from(row.querySelectorAll<HTMLElement>('.edit__chip'))) {
      if (chip.getAttribute('data-operand-term') !== focusTerm) {
        continue;
      }
      const target = chip.querySelector<HTMLElement>(
        '.edit__chip-term--editable, .edit__chip-term--mesh'
      );
      if (target) {
        target.focus();
        return;
      }
    }
  }
  const addBtn = row.querySelector<HTMLButtonElement>('.edit__chip-add-btn');
  if (addBtn) {
    addBtn.focus();
    return;
  }
  row.querySelector<HTMLButtonElement>('.edit__block-edit-toggle')?.focus();
}

/**
 * 鉛筆で開いた編集面の中身を構築する（issue #58 chunk 3b）。
 *
 * 1. **チップ編集**（editableBlock.ts）: MeSH / フリーワードの句単位で削除・語編集・追加。
 *    句の書き換えは operandEdit.ts の純関数（removeOperandAt / setOperandTerm /
 *    appendFreeword）に委譲する。
 * 2. **クイック整理**: 「重複する語を整理」（dedupeOperands）/ 「MeSH を先頭に並べ替え」
 *    （sortOperandsMeshFirst）。適用しても変化が無ければボタンを disabled にする。
 * 3. **詳細編集（生テキスト）**: チップでは自由編集できない複合句（ネスト群）や式全体の
 *    一括書き換え用の逃げ道（editableBlock.ts の同名コメント参照）。鉛筆クリック直後から
 *    常に表示する（チップと同じタイミングで開閉する。折りたたみにしないのは、issue #42 の
 *    実操作 E2E 回帰確認 `tests/e2e/journey-edit-save.spec.ts` が `.edit__block-edit-toggle`
 *    クリック直後に `.edit__block-edit-input` へ直接 `fill()` する前提で書かれており、
 *    追加の開閉操作を挟むとそのテストが壊れるため）。保存 / キャンセル / エラー表示は
 *    旧来のインライン編集（issue #58 chunk 3a 以前）と完全に同じ挙動: 保存は無変更でも
 *    commit し、空文字は独自の文言で弾く。キャンセルは詳細編集だけでなく鉛筆編集面全体
 *    （チップ含む）を閉じる（onCancelWhole）。commitExpression は経由しない。
 */
function renderEditPanel(
  doc: Document,
  slot: HTMLElement,
  blockId: string,
  expression: string,
  editor: FormulaEditor,
  commitExpression: (
    next: string,
    focusTerm: string | null,
    onError?: (message: string) => void
  ) => void,
  onCancelWhole: () => void
): void {
  const chipsWrap = doc.createElement('div');
  slot.appendChild(chipsWrap);

  const chipsError = doc.createElement('p');
  chipsError.className = 'edit__block-chips-error';
  chipsError.setAttribute('aria-live', 'polite');

  const handlers: EditableBlockHandlers = {
    onRemove: (index) => {
      commitExpression(removeOperandAt(expression, index), null, (msg) => {
        chipsError.textContent = msg;
      });
    },
    onEditTerm: (index, newTerm) => {
      commitExpression(setOperandTerm(expression, index, newTerm), newTerm, (msg) => {
        chipsError.textContent = msg;
      });
    },
    onAddFreeword: (term) => {
      commitExpression(appendFreeword(expression, term), term, (msg) => {
        chipsError.textContent = msg;
      });
    },
  };
  renderEditableBlockInto(chipsWrap, expression, handlers);
  slot.appendChild(chipsError);

  const quickTools = doc.createElement('div');
  quickTools.className = 'edit__block-quicktools';

  const dedupeBtn = doc.createElement('button');
  dedupeBtn.type = 'button';
  dedupeBtn.className = 'edit__block-quicktool';
  dedupeBtn.textContent = '重複する語を整理';
  const deduped = dedupeOperands(expression);
  dedupeBtn.disabled = deduped.trim() === expression.trim();
  dedupeBtn.addEventListener('click', () => commitExpression(deduped, null));
  quickTools.appendChild(dedupeBtn);

  const sortBtn = doc.createElement('button');
  sortBtn.type = 'button';
  sortBtn.className = 'edit__block-quicktool';
  sortBtn.textContent = 'MeSH を先頭に並べ替え';
  const sorted = sortOperandsMeshFirst(expression);
  sortBtn.disabled = sorted.trim() === expression.trim();
  sortBtn.addEventListener('click', () => commitExpression(sorted, null));
  quickTools.appendChild(sortBtn);

  slot.appendChild(quickTools);
  slot.appendChild(buildRawEditForm(doc, blockId, expression, editor, onCancelWhole));
}

/**
 * 「詳細編集（生テキスト）」。チップ編集面の下に常時表示する（鉛筆クリックで即座に
 * `.edit__block-edit-input` を操作できる。issue #42 の実操作 E2E 回帰確認との互換性の
 * 理由は renderEditPanel の doc コメント参照）。保存 / キャンセル / エラー表示は旧来の
 * インライン編集（issue #58 chunk 3a 以前）と完全に同じ挙動: 保存は無変更でも commit し、
 * 空文字は独自の文言で弾く。キャンセルは詳細編集だけでなく鉛筆編集面全体（チップ含む）を
 * 閉じる（onCancelWhole）。
 */
function buildRawEditForm(
  doc: Document,
  blockId: string,
  expression: string,
  editor: FormulaEditor,
  onCancelWhole: () => void
): HTMLElement {
  const wrap = doc.createElement('div');
  wrap.className = 'edit__block-rawedit';
  const label = doc.createElement('p');
  label.className = 'edit__block-rawedit-label';
  label.textContent = '詳細編集（生テキスト）';
  wrap.appendChild(label);

  const form = doc.createElement('div');
  form.className = 'edit__block-edit-form';
  const input = doc.createElement('textarea');
  input.className = 'edit__block-edit-input';
  input.rows = 3;
  input.value = expression;
  input.setAttribute('aria-label', `ブロック #${blockId} の式`);
  form.appendChild(input);

  const editActions = doc.createElement('div');
  editActions.className = 'edit__block-edit-actions';
  const saveBtn = doc.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'edit__block-edit-save';
  saveBtn.textContent = '保存';
  const cancelBtn = doc.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'edit__block-edit-cancel';
  cancelBtn.textContent = 'キャンセル';
  editActions.appendChild(saveBtn);
  editActions.appendChild(cancelBtn);
  form.appendChild(editActions);

  const editError = doc.createElement('p');
  editError.className = 'edit__block-edit-error';
  editError.setAttribute('aria-live', 'polite');
  form.appendChild(editError);

  wrap.appendChild(form);

  saveBtn.addEventListener('click', () => {
    const next = input.value.trim();
    if (next === '') {
      editError.textContent = '式が空です。内容を入力してください。';
      return;
    }
    try {
      const updated = applyBlockImprovement(editor.getMd(), blockId, next);
      // setMd がブロック一覧（または store 経由の全体）を再描画するため、
      // この row は破棄され新値で再生成される（editOpenBlocks は保持されるので、
      // 新しい行はチップ編集面が開いたまま再構築される）。
      editor.setMd(updated);
    } catch (err) {
      editError.textContent = `保存に失敗しました: ${formatError(err)}`;
    }
  });

  cancelBtn.addEventListener('click', () => {
    onCancelWhole();
  });

  return wrap;
}

/**
 * 「組み合わせ方を編集」パネル（issue #91）。掛け合わせ行だけに出る。
 *
 * 参照と論理演算子の組み替え（`#1 AND #2` → `(#1 OR #2) AND #3` 等）だけを許可し、
 * キーワードは書けない。検証は `src/lib/combination-expression` の
 * `validateCombinationExpression` に一任する（このライブラリのトークナイザは
 * `#<id>` / `AND` / `OR` / `NOT` / `(` / `)` 以外を受け付けず、`asthma[tiab]` のような
 * キーワードは「不正な文字」「予期しないキーワード」として弾くため、独自の判定は作らない）。
 * knownIds は呼び出し元（buildBlockRow）が組み立てた「この結合行自身の ID を除いた全ブロック
 * ID」（#/blocks の結合式エディタと同じ、`#Filter1` のようなフィルタブロックも含む集合）。
 *
 * 文言・ステータス表示の作りは #/blocks の結合式エディタ（blocksView.ts の
 * `buildCombinationEditor`）にできるだけ揃える。
 *
 * 保存時は validateCombinationExpression でエラーが 0 件のときだけ
 * normalizeCombinationExpression を通した式で applyBlockImprovement を呼ぶ。
 * このパネルが通す式は validateGrammar 上必ず 1 つ以上の参照を含む（被演算子として
 * 許可されるトークンは ref のみのため）ので、applyBlockImprovement 側の参照整合性ガード
 * （editService.ts の assertReferenceIntegrity。「参照 → 参照」の書き換えは許可）と矛盾しない。
 * 念のため try/catch し、ガードが例外を投げたらステータスへ出す。
 *
 * キャンセル（onCancel）は式を変えずにパネルを閉じるだけ。入力途中のテキストはローカル DOM の
 * まま扱う（詳細編集の `.edit__block-edit-input` と同じ挙動。再描画で現在の式に戻る）。
 *
 * 循環参照の検出（issue #92 B-1）: `#3 #1 AND #2` と `#4 #3 AND #Filter1` があるとき #3 を
 * `#1 AND #4` に書き換えると、#4 の定義を経由して #3 → #4 → #3 という経路ができてしまう。
 * validateCombinationExpression は構文と「参照先が存在するか」しか見ないため、この種の
 * 間接循環はすり抜ける（assertReferenceIntegrity も「参照が非空か」しか見ない）。放置すると
 * 次の検証／変換／エクスポートで expandFormula.ts の chooseEntryBlockId 経由の探索が
 * `throw new Error('検索式ブロックの参照が循環しています: #N')` に当たる。保存前に
 * {@link wouldCreateReferenceCycle} でこの画面自身が拒否する。
 */
function buildCombinationEditPanel(
  doc: Document,
  blockId: string,
  expression: string,
  knownIds: ReadonlySet<string>,
  formula: PubmedFormula,
  editor: FormulaEditor,
  onCancel: () => void
): HTMLElement {
  const wrap = doc.createElement('div');
  wrap.className = 'edit__block-combination-form';

  const hint = doc.createElement('p');
  hint.className = 'edit__block-combination-hint';
  hint.textContent =
    '使える記号: AND / OR / NOT / ( ) と #番号だけです。キーワードは各ブロック（#1〜）で編集してください。';
  wrap.appendChild(hint);

  const input = doc.createElement('input');
  input.type = 'text';
  input.className = 'edit__block-combination-input';
  input.value = expression;
  input.setAttribute('aria-label', `ブロック #${blockId} の組み合わせ方`);
  wrap.appendChild(input);

  const status = doc.createElement('p');
  status.setAttribute('aria-live', 'polite');
  wrap.appendChild(status);

  const errorList = doc.createElement('ul');
  errorList.className = 'edit__block-combination-errors';
  wrap.appendChild(errorList);

  /**
   * 現在の input 値を検証し、status / errorList を更新する。呼び出し元へ結果を返す。
   * 構文エラーが 0 件でも、この書き換えが参照グラフに循環を作る場合は hasCycle=true とし、
   * 保存を拒否する（issue #92 B-1）。
   */
  function refreshValidation(): { validation: ReturnType<typeof validateCombinationExpression>; hasCycle: boolean } {
    const validation = validateCombinationExpression(input.value, knownIds);
    errorList.innerHTML = '';
    if (validation.errors.length > 0) {
      status.className = 'edit__block-combination-status edit__block-combination-status--error';
      status.textContent = `⚠ ${validation.errors.length} 件のエラーがあります`;
      for (const err of validation.errors) {
        const li = doc.createElement('li');
        li.textContent = formatCombinationError(err);
        errorList.appendChild(li);
      }
      return { validation, hasCycle: false };
    }
    const hasCycle = wouldCreateReferenceCycle(formula, blockId, input.value);
    if (hasCycle) {
      status.className = 'edit__block-combination-status edit__block-combination-status--error';
      status.textContent = '⚠ この組み合わせ方は参照の循環を作ります';
      const li = doc.createElement('li');
      li.textContent =
        '他のブロックの掛け合わせ行を辿ると自分自身に戻ってしまいます。参照先を見直してください。';
      errorList.appendChild(li);
      return { validation, hasCycle: true };
    }
    status.className = 'edit__block-combination-status edit__block-combination-status--ok';
    status.textContent = '✓ 構文 OK';
    return { validation, hasCycle: false };
  }
  refreshValidation();
  input.addEventListener('input', () => {
    refreshValidation();
  });

  const actions = doc.createElement('div');
  actions.className = 'edit__block-combination-actions';
  const saveBtn = doc.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'edit__block-combination-save';
  saveBtn.textContent = '保存';
  const cancelBtn = doc.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'edit__block-combination-cancel';
  cancelBtn.textContent = 'キャンセル';
  actions.appendChild(saveBtn);
  actions.appendChild(cancelBtn);
  wrap.appendChild(actions);

  saveBtn.addEventListener('click', () => {
    const { validation, hasCycle } = refreshValidation();
    if (validation.errors.length > 0 || hasCycle) {
      return;
    }
    const next = normalizeCombinationExpression(input.value);
    try {
      editor.setMd(applyBlockImprovement(editor.getMd(), blockId, next));
    } catch (err) {
      status.className = 'edit__block-combination-status edit__block-combination-status--error';
      status.textContent = `保存に失敗しました: ${formatError(err)}`;
    }
  });

  cancelBtn.addEventListener('click', () => {
    onCancel();
  });

  return wrap;
}

/**
 * 「AI に改善させる」で開くプロンプト入力フォーム。
 * 任意の指示文（空でも可）と、「AI に渡す内容を見る」の開示を備える。
 * 「改善案を取得」で onImproveBlock を呼ぶ。進捗・結果は store.blockImprovement 経由で
 * 反映されるため、ここでは呼び出すだけで解決値は扱わない（expand の onFetch と同じ思想）。
 *
 * submit 時、インスペクタが既に計測済みの値（measuredCaches の hitsSnapshot /
 * freewordDeltaSnapshot）を collectMeasuredContext で同期的に読み、非空のときだけ
 * onImproveBlock の入力に載せる（issue #58 chunk 3c）。新規 esearch は発行しない
 * （インスペクタを開いていない・計測が未解決のブロックでは何も載らないのが正常）。
 *
 * 兄弟ブロック（結合行を除く他の概念ブロック）は computeSiblingOverlaps(expression, siblings)
 * をここで 1 度だけ計算し、「AI に渡す内容を見る」（onGetImproveContext）と実際の submit
 * （onImproveBlock）の両方へ同じ値を渡す（開示と実際にプロンプトへ載る内容を一致させる
 * という openAiPromptForm 全体の設計方針を守るため）。共有語（sharedTerms）は完全一致でしか
 * 検出できないため、共有語が 0 件の兄弟も含めて全件渡す（issue #89。表記ゆれ等で完全一致
 * しない重複のときに AI へ何も渡らず、根拠の無い推測で過剰削除するのを防ぐため）。
 *
 * 指示欄の内容は打鍵のたび onInstructionChange 経由で store（blockImprovementInstruction）へ
 * 反映し、初期値も同じ場所から復元する（issue #90）。LLM コスト集計等の setState による
 * 全ビュー再描画（editView は再描画のたびに `container.innerHTML = ''` で丸ごと作り直す）を
 * またいでも、打鍵の途中経過が消えないようにするため（formulaEditNote と同じ理由）。
 */
function openAiPromptForm(
  doc: Document,
  slot: HTMLElement,
  blockId: string,
  expression: string,
  siblings: SiblingBlock[],
  onImproveBlock: NonNullable<EditViewCallbacks['onImproveBlock']>,
  onGetImproveContext: EditViewCallbacks['onGetImproveContext'],
  measuredCaches: EditInspectorRuntime['caches'],
  onClosed: () => void,
  initialInstruction: string,
  onInstructionChange: EditViewCallbacks['onInstructionChange']
): void {
  slot.innerHTML = '';
  const overlaps = computeSiblingOverlaps(expression, siblings);
  const form = doc.createElement('div');
  form.className = 'edit__block-ai-form';

  const instructionLabel = doc.createElement('label');
  instructionLabel.className = 'edit__block-ai-instruction-label';
  instructionLabel.textContent = 'AI への指示（任意）:';
  const instruction = doc.createElement('textarea');
  instruction.className = 'edit__block-ai-instruction';
  instruction.rows = 2;
  instruction.placeholder = '例: 同義語をもっと増やして / MeSH を減らして tiab 中心に';
  instruction.value = initialInstruction;
  instruction.addEventListener('input', () => {
    onInstructionChange?.(blockId, instruction.value);
  });
  instructionLabel.appendChild(instruction);
  form.appendChild(instructionLabel);

  // AI に渡る文脈の開示（callback があれば）。SeedPapers 読み取りを伴うので非同期で埋める。
  if (onGetImproveContext) {
    const details = doc.createElement('details');
    details.className = 'edit__block-ai-context';
    const summary = doc.createElement('summary');
    summary.textContent = 'AI に渡す内容を見る';
    details.appendChild(summary);
    const loading = doc.createElement('p');
    loading.className = 'edit__block-ai-context-loading';
    loading.textContent = '読み込み中…';
    details.appendChild(loading);
    form.appendChild(details);
    onGetImproveContext(blockId, overlaps)
      .then((context) => {
        loading.remove();
        details.appendChild(buildContextBody(doc, context, expression, overlaps));
      })
      .catch(() => {
        loading.textContent = '文脈の取得に失敗しました（改善は実行できます）。';
      });
  }

  const aiActions = doc.createElement('div');
  aiActions.className = 'edit__block-ai-actions';
  const submitBtn = doc.createElement('button');
  submitBtn.type = 'button';
  submitBtn.className = 'edit__block-ai-submit';
  submitBtn.textContent = '改善案を取得';
  const cancelBtn = doc.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'edit__block-ai-cancel';
  cancelBtn.textContent = 'キャンセル';
  aiActions.appendChild(submitBtn);
  aiActions.appendChild(cancelBtn);
  form.appendChild(aiActions);

  slot.appendChild(form);
  instruction.focus();

  cancelBtn.addEventListener('click', () => {
    slot.innerHTML = '';
    onClosed();
  });

  submitBtn.addEventListener('click', () => {
    // store 側が blockImprovement.status='running' を設定し、その setState が
    // 再描画を起こしてこのフォームごと置き換える想定。ここでのローカル無効化は保険のみ
    // （store 連携が無い呼び出し側でも二重送信を軽減する）。
    submitBtn.disabled = true;
    cancelBtn.disabled = true;
    const measured = collectMeasuredContext(expression, measuredCaches);
    void onImproveBlock({
      blockId,
      instruction: instruction.value,
      // 何も計測できていなければキーを足さない（呼び出し側の「未計測」判定と揃える）。
      ...(measured.keywordHits.length > 0 ? { keywordHits: measured.keywordHits } : {}),
      ...(measured.freewordDedupTotal !== null
        ? { freewordDedupTotal: measured.freewordDedupTotal }
        : {}),
      // 兄弟ブロックが 1 件も無ければキーを足さない（issue #89。既存の未計測判定と揃える）。
      // computeSiblingOverlaps は共有語の有無にかかわらず全兄弟を返すため、この条件は
      // 「共有語がある兄弟が居るか」ではなく「兄弟ブロックが存在するか」になる
      // （完全一致しない重複でも AI に自分以外の式を見せるため。blockInspector.ts の
      // computeSiblingOverlaps の doc コメント参照）。
      ...(overlaps.length > 0 ? { siblings: overlaps } : {}),
    });
  });
}

/**
 * 「AI に渡す内容を見る」の中身。context が null なら現式・siblings は fallback で示す
 * （fallbackSiblings は openAiPromptForm が computeSiblingOverlaps で同期的に計算した値。
 * context.siblings はそれを onGetImproveContext 経由でそのまま echo したものなので、
 * 通常は同じ内容になる）。
 */
function buildContextBody(
  doc: Document,
  context: BlockImprovementContext | null,
  fallbackExpression: string,
  fallbackSiblings: SiblingOverlap[]
): HTMLElement {
  const wrapper = doc.createElement('div');
  wrapper.className = 'edit__block-ai-context-body';

  const dl = doc.createElement('dl');
  dl.className = 'edit__block-ai-context-list';
  const rq = context?.researchQuestion?.trim();
  const label = context?.blockLabel?.trim();
  const desc = context?.blockDescription?.trim();
  const current = (context?.currentExpression ?? fallbackExpression).trim();
  appendContextItem(doc, dl, 'RQ', rq && rq !== '' ? rq : '(未設定)');
  appendContextItem(doc, dl, 'ブロックの役割', label && label !== '' ? label : '(自動推定)');
  appendContextItem(doc, dl, '説明', desc && desc !== '' ? desc : '(自動推定)');
  appendContextItem(doc, dl, '現在の式', current);
  wrapper.appendChild(dl);

  // 他ブロック（issue #89: 重複を根拠づけるため AI にも見せる文脈と同じものを表示する）。
  // siblings は結合行を除く全ての兄弟ブロック（共有語の有無を問わない）。共有語は
  // MeSH descriptor / フリーワード query の完全一致でしか検出できないため、0 件でも
  // 「重複が無い」とは限らない（表記ゆれ等）ことを表示上も明示する。
  const siblings = context?.siblings ?? fallbackSiblings;
  const siblingsHeading = doc.createElement('p');
  siblingsHeading.className = 'edit__block-ai-context-subheading';
  siblingsHeading.textContent = `他ブロック（${siblings.length} 件）`;
  wrapper.appendChild(siblingsHeading);
  if (siblings.length === 0) {
    const none = doc.createElement('p');
    // seeds セクションの「(登録なし)」と意味が異なる（他ブロックが無い＝結合行以外に
    // ブロックが自分だけ）ため、意図的に別クラスにする（既存の .edit__block-ai-context-empty
    // との querySelector 衝突も避ける）。
    none.className = 'edit__block-ai-context-siblings-empty';
    none.textContent = '(他ブロックなし)';
    wrapper.appendChild(none);
  } else {
    const siblingList = doc.createElement('ul');
    siblingList.className = 'edit__block-ai-context-siblings';
    for (const sib of siblings) {
      const item = doc.createElement('li');
      const sibLabel = sib.label ? ` ${sib.label}` : '';
      const sharedText =
        sib.sharedTerms.length > 0
          ? sib.sharedTerms.map((t) => t.term).join(', ')
          : '完全一致の重複なし';
      item.textContent = `#${sib.id}${sibLabel}: ${sib.expression}（共有語: ${sharedText}）`;
      siblingList.appendChild(item);
    }
    wrapper.appendChild(siblingList);
  }

  // シード論文
  const seeds = context?.seedPapers ?? [];
  const seedsHeading = doc.createElement('p');
  seedsHeading.className = 'edit__block-ai-context-subheading';
  seedsHeading.textContent = `シード論文（${seeds.length} 件）`;
  wrapper.appendChild(seedsHeading);
  if (seeds.length === 0) {
    const none = doc.createElement('p');
    none.className = 'edit__block-ai-context-empty';
    none.textContent = '(登録なし)';
    wrapper.appendChild(none);
  } else {
    const seedList = doc.createElement('ul');
    seedList.className = 'edit__block-ai-context-seeds';
    for (const seed of seeds) {
      const item = doc.createElement('li');
      const tag = seed.source === 'interactive' ? '対話拡張' : '初期';
      item.textContent = `PMID ${seed.pmid}（${tag}・${seed.decision}）: ${seed.title}`;
      seedList.appendChild(item);
    }
    wrapper.appendChild(seedList);
  }

  // 直近の検証捕捉情報
  const validation = context?.validation ?? null;
  const valHeading = doc.createElement('p');
  valHeading.className = 'edit__block-ai-context-subheading';
  valHeading.textContent = '直近の検証結果';
  wrapper.appendChild(valHeading);
  const valBody = doc.createElement('p');
  valBody.className = 'edit__block-ai-context-validation';
  if (validation === null) {
    valBody.textContent = '(未検証)';
  } else {
    const ratePct = Math.round(validation.captureRate * 1000) / 10;
    const total = validation.capturedPmids.length + validation.missedPmids.length;
    const missed =
      validation.missedPmids.length === 0 ? 'なし' : validation.missedPmids.join(', ');
    valBody.textContent = `捕捉率 ${ratePct}%（${validation.capturedPmids.length}/${total}）／取りこぼし PMID: ${missed}`;
  }
  wrapper.appendChild(valBody);

  return wrapper;
}

function appendContextItem(
  doc: Document,
  dl: HTMLElement,
  term: string,
  value: string
): void {
  const dt = doc.createElement('dt');
  dt.textContent = term;
  const dd = doc.createElement('dd');
  dd.textContent = value;
  dl.appendChild(dt);
  dl.appendChild(dd);
}

/**
 * store.blockImprovement の状態（running / ready / error）を AI スロットへ復元する。
 * running: 取得中インジケータ。ready: 提案の diff 表示（renderProposal）。error: エラー表示。
 *
 * siblings / measuredCaches / instructionDraft は「指示を追加してやり直す」（issue #90）が
 * 初回 submit（openAiPromptForm）と同じ文脈を再送信できるよう、ready 分岐でそのまま
 * renderProposal へ引き渡すだけのバケツリレー。
 */
function renderImprovementState(
  doc: Document,
  slot: HTMLElement,
  improvement: BlockImprovementState,
  editor: FormulaEditor,
  callbacks: EditViewCallbacks,
  blockId: string,
  siblings: SiblingBlock[],
  measuredCaches: EditInspectorRuntime['caches'],
  instructionDraft: string,
  manualEditDraft: string | null
): void {
  slot.innerHTML = '';
  if (improvement.status === 'running') {
    const pending = doc.createElement('p');
    pending.className = 'edit__block-pending';
    pending.textContent = '改善提案を取得中…';
    slot.appendChild(pending);
    return;
  }
  if (improvement.status === 'error') {
    const errEl = doc.createElement('p');
    errEl.className = 'edit__block-error';
    errEl.textContent = `改善提案の取得に失敗しました: ${improvement.error ?? '不明なエラー'}`;
    slot.appendChild(errEl);
    return;
  }
  const result = improvement.result;
  /* istanbul ignore if -- status='ready' は bootstrap 側が result 付きでしか設定しない不変条件 */
  if (result === null) {
    return;
  }
  renderProposal(
    doc,
    slot,
    editor,
    callbacks,
    blockId,
    result,
    improvement.history,
    siblings,
    measuredCaches,
    instructionDraft,
    manualEditDraft
  );
}

/**
 * improve-block 結果の diff を表示し、accept / reject ボタンを用意する。
 * before/after は句単位（formulaDisplay.ts の diffExpressions / renderDiffSideInto）で
 * 削除 = 取り消し線・追加 = 強調に色分けする（issue #58 chunk 3b）。concatenated textContent
 * は元の expression 文字列と一致する（renderDiffSideInto の doc コメント参照）。
 *
 * accept は「現在の編集中 md」（editor.getMd()、他ブロックへの並行編集を含みうる）に対して
 * applyBlockImprovement を当てる。提案受信時点の md を base として握らないのは、md が
 * store 化された今それをやると他ブロックへの並行編集を巻き戻してしまうため。
 *
 * issue #90（会話継続）で 3 つの追加操作を持つ:
 * - 「これまでのやり取り（N 回）」`<details>`（history が空なら出さない）
 * - 「提案を編集してから採用する」`<details>`（textarea + applyBlockImprovement 経由の適用）
 * - 「指示を追加してやり直す」（textarea + onImproveBlock の再送信。history / siblings /
 *   計測済みヒット数を初回 submit と同じ形で載せ直す）
 */
function renderProposal(
  doc: Document,
  slot: HTMLElement,
  editor: FormulaEditor,
  callbacks: EditViewCallbacks,
  blockId: string,
  result: BlockImprovementResult,
  history: ImproveBlockTurn[],
  siblings: SiblingBlock[],
  measuredCaches: EditInspectorRuntime['caches'],
  instructionDraft: string,
  manualEditDraft: string | null
): void {
  slot.innerHTML = '';
  const rationale = doc.createElement('p');
  rationale.className = 'edit__block-rationale';
  rationale.textContent = result.rationale === '' ? '（改善ポイントの説明なし）' : result.rationale;
  slot.appendChild(rationale);

  const tokenDiff = diffExpressions(result.currentExpression, result.proposedExpression);

  const diff = doc.createElement('div');
  diff.className = 'edit__block-diff';
  const before = doc.createElement('div');
  before.className = 'edit__block-diff-before';
  const beforeHeader = doc.createElement('strong');
  beforeHeader.textContent = 'Before:';
  before.appendChild(beforeHeader);
  const beforePre = doc.createElement('pre');
  renderDiffSideInto(beforePre, tokenDiff.beforeTokens);
  before.appendChild(beforePre);

  const after = doc.createElement('div');
  after.className = 'edit__block-diff-after';
  const afterHeader = doc.createElement('strong');
  afterHeader.textContent = 'After:';
  after.appendChild(afterHeader);
  const afterPre = doc.createElement('pre');
  renderDiffSideInto(afterPre, tokenDiff.afterTokens);
  after.appendChild(afterPre);

  diff.appendChild(before);
  diff.appendChild(after);
  slot.appendChild(diff);

  // 削除サマリ（issue #89）: 過剰削除に気づけるよう、diff の直下に語数と内訳を 1 行で出す。
  const summaryLine = buildDiffSummaryLine(doc, tokenDiff);
  if (summaryLine) {
    slot.appendChild(summaryLine);
  }

  // 「提案を編集してから採用する」（issue #90）: AI の提案は良い方向だが細部を直したい、
  // というケース向け。applyBlockImprovement を通す（#88 の参照整合性ガード・空文字チェックが
  // そこにある）ので accept ボタンと同じ安全性を持つ。既存 E2E は触らない新規要素なので
  // <details> で畳んでよい（CLAUDE.md の #/edit 注意事項参照）。
  //
  // 入力途中のテキストは指示欄（blockImprovementInstruction）と同じやり方で store
  // （blockImprovementManualEditDraft）backed にする（issue #92 B-3）。この textarea は
  // 元々ローカル DOM のみで、LLM コスト集計等の setState による全ビュー再描画（editView は
  // 再描画のたびに `container.innerHTML = ''` で丸ごと作り直す）でこの render が呼ばれ直すと
  // manualEditInput.value が毎回 result.proposedExpression で上書きされ、入力途中の手編集が
  // 消えていた（テスターが実際に踏んだ回帰）。draft が無ければ（＝まだ手を触れていなければ）
  // 従来どおり result.proposedExpression を初期値にする。
  const manualEditDetails = doc.createElement('details');
  manualEditDetails.className = 'edit__block-ai-manual-edit';
  // draft が残っている（＝手を触れたことがある）なら、再描画をまたいでも開いたままにする。
  // そうしないと値自体は復元されても <details> が閉じ直り、消えたように見えてしまう。
  manualEditDetails.open = manualEditDraft !== null;
  const manualEditSummary = doc.createElement('summary');
  manualEditSummary.textContent = '提案を編集してから採用する';
  manualEditDetails.appendChild(manualEditSummary);
  const manualEditInput = doc.createElement('textarea');
  manualEditInput.className = 'edit__block-ai-manual-edit-input';
  manualEditInput.rows = 3;
  manualEditInput.value = manualEditDraft ?? result.proposedExpression;
  manualEditInput.setAttribute('aria-label', `ブロック #${blockId} の提案を編集`);
  manualEditInput.addEventListener('input', () => {
    callbacks.onManualEditChange?.(blockId, manualEditInput.value);
  });
  manualEditDetails.appendChild(manualEditInput);
  const manualEditActions = doc.createElement('div');
  manualEditActions.className = 'edit__block-ai-manual-edit-actions';
  const manualEditApplyBtn = doc.createElement('button');
  manualEditApplyBtn.type = 'button';
  manualEditApplyBtn.className = 'edit__block-ai-manual-edit-apply';
  manualEditApplyBtn.textContent = '編集した内容で置き換える';
  manualEditActions.appendChild(manualEditApplyBtn);
  manualEditDetails.appendChild(manualEditActions);
  const manualEditError = doc.createElement('p');
  manualEditError.className = 'edit__block-ai-manual-edit-error';
  manualEditError.setAttribute('aria-live', 'polite');
  manualEditDetails.appendChild(manualEditError);
  slot.appendChild(manualEditDetails);

  manualEditApplyBtn.addEventListener('click', () => {
    try {
      const next = applyBlockImprovement(editor.getMd(), blockId, manualEditInput.value);
      // accept ボタンと同じ順序（先に提案を引っ込めてから setMd）。理由は下の acceptBtn の
      // コメント参照。
      callbacks.onClearImprovement?.();
      editor.setMd(next);
    } catch (err) {
      manualEditError.textContent = `置き換えに失敗しました: ${formatError(err)}`;
    }
  });

  const actions = doc.createElement('div');
  actions.className = 'edit__block-actions';

  const acceptBtn = doc.createElement('button');
  acceptBtn.type = 'button';
  acceptBtn.className = 'edit__block-accept';
  acceptBtn.textContent = 'この提案で置き換える';
  const rejectBtn = doc.createElement('button');
  rejectBtn.type = 'button';
  rejectBtn.className = 'edit__block-reject';
  rejectBtn.textContent = '破棄';

  // proposed == current なら accept の意味が無いので無効化
  if (result.proposedExpression.trim() === '' ||
      result.proposedExpression.trim() === result.currentExpression.trim()) {
    acceptBtn.disabled = true;
    acceptBtn.title = '提案が空、または現式と同じです';
  }

  actions.appendChild(acceptBtn);
  actions.appendChild(rejectBtn);
  slot.appendChild(actions);

  const feedback = doc.createElement('p');
  feedback.className = 'edit__block-feedback';
  feedback.setAttribute('aria-live', 'polite');
  slot.appendChild(feedback);

  // 「これまでのやり取り（N 回）」（issue #90）: history が空なら出さない。
  // 各 turn の指示と、それに対する提案の rationale を並べる（提案 expression 自体は
  // 差分として見せるほど頻繁に見返すものではないため、ここでは rationale のみ）。
  if (history.length > 0) {
    const historyDetails = doc.createElement('details');
    historyDetails.className = 'edit__block-ai-history';
    const historySummary = doc.createElement('summary');
    historySummary.textContent = `これまでのやり取り（${history.length} 回）`;
    historyDetails.appendChild(historySummary);
    const historyList = doc.createElement('ol');
    historyList.className = 'edit__block-ai-history-list';
    for (const turn of history) {
      const item = doc.createElement('li');
      const instructionP = doc.createElement('p');
      instructionP.className = 'edit__block-ai-history-instruction';
      instructionP.textContent = `指示: ${turn.instruction.trim() === '' ? '(特になし)' : turn.instruction}`;
      item.appendChild(instructionP);
      const rationaleP = doc.createElement('p');
      rationaleP.className = 'edit__block-ai-history-rationale';
      rationaleP.textContent = turn.rationale === '' ? '（改善ポイントの説明なし）' : turn.rationale;
      item.appendChild(rationaleP);
      historyList.appendChild(item);
    }
    historyDetails.appendChild(historyList);
    slot.appendChild(historyDetails);
  }

  // 「指示を追加してやり直す」（issue #90）: 「これは違う、こうして」と続けて指示できるように、
  // 初回 submit（openAiPromptForm）と同じ文脈（history / siblings / 計測済みヒット数）を
  // 載せ直して onImproveBlock を再送信する。accept / reject の下に常時表示する（<details> で
  // 畳まない）ため、既存 E2E が触る .edit__block-accept / .edit__block-reject には影響しない。
  const redoWrap = doc.createElement('div');
  redoWrap.className = 'edit__block-ai-redo';
  const redoLabel = doc.createElement('label');
  redoLabel.className = 'edit__block-ai-redo-label';
  redoLabel.textContent = '指示を追加してやり直す:';
  const redoInstruction = doc.createElement('textarea');
  redoInstruction.className = 'edit__block-ai-redo-instruction';
  redoInstruction.rows = 2;
  redoInstruction.placeholder = '例: それは違う、代わりに MeSH を先頭に';
  redoInstruction.value = instructionDraft;
  redoInstruction.addEventListener('input', () => {
    callbacks.onInstructionChange?.(blockId, redoInstruction.value);
  });
  redoLabel.appendChild(redoInstruction);
  redoWrap.appendChild(redoLabel);
  const redoActions = doc.createElement('div');
  redoActions.className = 'edit__block-ai-redo-actions';
  const redoBtn = doc.createElement('button');
  redoBtn.type = 'button';
  redoBtn.className = 'edit__block-ai-redo-submit';
  redoBtn.textContent = 'この指示でやり直す';
  redoActions.appendChild(redoBtn);
  redoWrap.appendChild(redoActions);
  slot.appendChild(redoWrap);

  redoBtn.addEventListener('click', () => {
    if (!callbacks.onImproveBlock) {
      return;
    }
    // store 側が blockImprovement.status='running' を設定し、その setState が再描画を起こして
    // このパネルごと置き換える想定（openAiPromptForm の submit と同じ思想）。
    redoBtn.disabled = true;
    const overlaps = computeSiblingOverlaps(result.currentExpression, siblings);
    const measured = collectMeasuredContext(result.currentExpression, measuredCaches);
    void callbacks.onImproveBlock({
      blockId,
      instruction: redoInstruction.value,
      // history は status='ready' である以上 1 turn 以上あるはずだが、テスト用の fixture 等で
      // 空配列が渡るケースも考慮し、他の任意項目（keywordHits 等）と同じく空なら省略する。
      ...(history.length > 0 ? { history } : {}),
      ...(measured.keywordHits.length > 0 ? { keywordHits: measured.keywordHits } : {}),
      ...(measured.freewordDedupTotal !== null
        ? { freewordDedupTotal: measured.freewordDedupTotal }
        : {}),
      ...(overlaps.length > 0 ? { siblings: overlaps } : {}),
    });
  });

  // accept / reject のどちらも inspector.editOpenBlocks / aiOpenBlocks は意図的に触らない。
  // 「開いたことがあるブロックのインスペクタは、明示的な鉛筆/AI ボタンのトグル close 以外では
  // 閉じない」という単純な規則のままにしておくと、提案の accept/reject 直後も（鉛筆編集面が
  // 閉じていれば）インスペクタが開いたまま残ることがある。accept 後に更新済み式の計測値を
  // すぐ見られる利点があり、受け入れ条件にも含まれないため許容している。
  acceptBtn.addEventListener('click', () => {
    try {
      const next = applyBlockImprovement(editor.getMd(), blockId, result.proposedExpression);
      // 提案を先に引っ込めてから setMd する（順序が重要）。setMd はフォールバック経路では
      // ローカル rerenderBlocks を同期的に起こすため、先に引っ込めておかないとその再描画で
      // まだ nullified されていない古い提案を拾って復元してしまう。
      callbacks.onClearImprovement?.();
      // setMd が onDraftChange（store 経由の再描画）またはローカル再描画のいずれかで反映する。
      editor.setMd(next);
    } catch (err) {
      feedback.textContent = `置き換えに失敗しました: ${formatError(err)}`;
    }
  });

  rejectBtn.addEventListener('click', () => {
    // md は変わらない（setMd を呼ばない）ため、この操作自体では再描画が起きるとは限らない。
    // フォールバック経路では特に、ここで DOM を空にしないと見た目上パネルが閉じない。
    slot.innerHTML = '';
    callbacks.onClearImprovement?.();
  });
}

/**
 * 提案 diff の削除/追加サマリ行（issue #89）。過剰削除に気づけるよう、句数と
 * MeSH / フリーワード内訳を 1 行で示す。削除・追加どちらも 0 件なら null（行を出さない）。
 * 例: 「この提案で 7 語が削除され、2 語が追加されます（削除: MeSH 2 / フリーワード 5）」
 */
function buildDiffSummaryLine(doc: Document, diff: ExpressionDiff): HTMLElement | null {
  if (diff.removed.length === 0 && diff.added.length === 0) {
    return null;
  }
  let sentence: string;
  if (diff.removed.length > 0 && diff.added.length > 0) {
    sentence = `この提案で ${diff.removed.length} 語が削除され、${diff.added.length} 語が追加されます`;
  } else if (diff.removed.length > 0) {
    sentence = `この提案で ${diff.removed.length} 語が削除されます`;
  } else {
    sentence = `この提案で ${diff.added.length} 語が追加されます`;
  }
  if (diff.removed.length > 0) {
    sentence += `（削除: ${summarizeOperandKinds(diff.removed)}）`;
  }
  const p = doc.createElement('p');
  p.className = 'edit__block-diff-summary';
  p.textContent = sentence;
  return p;
}

/**
 * operand テキスト群を MeSH / フリーワード / その他（複合句など判定できないもの）に分類して
 * 「MeSH x / フリーワード y[ / その他 z]」の内訳文字列にする。
 */
function summarizeOperandKinds(texts: readonly string[]): string {
  let mesh = 0;
  let freeword = 0;
  let other = 0;
  for (const text of texts) {
    const kind = analyzeOperand(text).kind;
    if (kind === 'mesh') {
      mesh += 1;
    } else if (kind === 'freeword') {
      freeword += 1;
    } else {
      other += 1;
    }
  }
  const parts = [`MeSH ${mesh}`, `フリーワード ${freeword}`];
  if (other > 0) {
    parts.push(`その他 ${other}`);
  }
  return parts.join(' / ');
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
