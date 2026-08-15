import {
  applyBlockImprovement,
  type BlockImprovementContext,
  type BlockImprovementResult,
  type RequestBlockImprovementInput,
  type SaveEditedFormulaInput,
} from '@/app/services';
import { parsePubmedFormulaMd } from '@/lib/search-formula-md';
import { buildBlockInspector, type BlockInspectorDeps, type SiblingBlock } from './blockInspector';
import { renderEditableBlockInto, type EditableBlockHandlers } from './editableBlock';
import {
  buildLegend,
  diffExpressions,
  renderDiffSideInto,
  renderExpressionInto,
} from './formulaDisplay';
import { dedupeOperands, sortOperandsMeshFirst } from './meshExpressionEdit';
import { appendFreeword, removeOperandAt, setOperandTerm } from './operandEdit';
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
 *    任意の指示文を入力する欄が開き（空でも可）、improve-block skill を実行する。
 *    提案 expression と rationale を句単位の diff（formulaDisplay.ts の diffExpressions /
 *    renderDiffSideInto）で色分け表示し、「置き換える」で内部 md に反映する。
 *
 * ブロック行の下には、鉛筆または AI パネルを開いたときだけブロック・インスペクタ
 * （blockInspector.ts）を展開する。チップ・詳細編集・インスペクタの MeSH ブラウザ
 * （置換 / OR追加 / 削除）・Δ 表のいずれから編集しても、同じ純粋関数（operandEdit /
 * meshExpressionEdit）を経由した同じ結果になる。
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
  /** 「AI に渡す内容を見る」表示用の文脈スナップショットを取得する（SeedPapers 読み取りを伴う） */
  onGetImproveContext?: (blockId: string) => Promise<BlockImprovementContext | null>;
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
 */
interface EditInspectorRuntime {
  caches: Pick<
    BlockInspectorDeps,
    | 'hitsCache'
    | 'freewordDeltaCache'
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
}

function createInspectorRuntime(): EditInspectorRuntime {
  return {
    caches: {
      hitsCache: new Map(),
      freewordDeltaCache: new Map(),
      meshTreeCache: new Map(),
      meshChildrenCache: new Map(),
      meshLabelCache: new Map(),
      meshExpandedState: new Map(),
    },
    editOpenBlocks: new Set(),
    aiOpenBlocks: new Set(),
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
      renderBlockList(doc, blocksList, editor, internalCallbacks, improvement, ctx.state.blocksDraft, inspector);
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
 */
function renderBlockList(
  doc: Document,
  ul: HTMLElement,
  editor: FormulaEditor,
  callbacks: EditViewCallbacks,
  improvement: BlockImprovementState | null,
  blocksDraft: BlocksDraft | null,
  inspector: EditInspectorRuntime
): void {
  ul.innerHTML = '';
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
  // インスペクタの「他ブロックとの重複」セクション向け。結合行（他ブロック ID を参照する行）は
  // 検索の実体を持たないので概念ブロックの比較対象から除く（requirements: ブロック編集インスペクタ）。
  const conceptBlocks = formula.blocks.filter((b) => !b.isCombination);
  for (const block of formula.blocks) {
    const siblings: SiblingBlock[] = conceptBlocks
      .filter((b) => b.id !== block.id)
      .map((b) => ({ id: b.id, label: resolveBlockLabel(blocksDraft, b.id), expression: b.expression }));
    ul.appendChild(
      buildBlockRow(
        doc,
        block.id,
        block.expression,
        editor,
        callbacks,
        improvement !== null && improvement.blockId === block.id ? improvement : null,
        siblings,
        inspector
      )
    );
  }
}

function buildBlockRow(
  doc: Document,
  blockId: string,
  expression: string,
  editor: FormulaEditor,
  callbacks: EditViewCallbacks,
  improvement: BlockImprovementState | null,
  siblings: SiblingBlock[],
  inspector: EditInspectorRuntime
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

  // 読み取り表示（MeSH / フリーワードを色分け。formulaDisplay.ts の renderExpressionInto）。
  // 鉛筆編集面が開いている間は隠す（旧実装からの継続）。
  const currentPre = doc.createElement('pre');
  currentPre.className = 'edit__block-current';
  renderExpressionInto(currentPre, expression);
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
    renderImprovementState(doc, aiSlot, improvement, editor, callbacks, blockId);
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
    editor.setMd(applyBlockImprovement(editor.getMd(), blockId, next));
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
      // MeSH ブラウザの置換 / OR追加 / 削除、Δ 表の語編集・削除を有効化する。
      // チップ編集面と同じ commitExpression を通すので、インスペクタ側から触っても
      // チップ側から触っても同じ結果になる（blockInspector.ts の doc コメント参照）。
      onApplyExpression: (next) => commitExpression(next, null),
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
      callbacks.onImproveBlock,
      callbacks.onGetImproveContext,
      () => {
        // 「キャンセル」（未送信のまま閉じる）は上の分岐を通らないので個別に処理する。
        inspector.aiOpenBlocks.delete(blockId);
        syncInspector();
      }
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
 * 「AI に改善させる」で開くプロンプト入力フォーム。
 * 任意の指示文（空でも可）と、「AI に渡す内容を見る」の開示を備える。
 * 「改善案を取得」で onImproveBlock を呼ぶ。進捗・結果は store.blockImprovement 経由で
 * 反映されるため、ここでは呼び出すだけで解決値は扱わない（expand の onFetch と同じ思想）。
 */
function openAiPromptForm(
  doc: Document,
  slot: HTMLElement,
  blockId: string,
  expression: string,
  onImproveBlock: NonNullable<EditViewCallbacks['onImproveBlock']>,
  onGetImproveContext: EditViewCallbacks['onGetImproveContext'],
  onClosed: () => void
): void {
  slot.innerHTML = '';
  const form = doc.createElement('div');
  form.className = 'edit__block-ai-form';

  const instructionLabel = doc.createElement('label');
  instructionLabel.className = 'edit__block-ai-instruction-label';
  instructionLabel.textContent = 'AI への指示（任意）:';
  const instruction = doc.createElement('textarea');
  instruction.className = 'edit__block-ai-instruction';
  instruction.rows = 2;
  instruction.placeholder = '例: 同義語をもっと増やして / MeSH を減らして tiab 中心に';
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
    onGetImproveContext(blockId)
      .then((context) => {
        loading.remove();
        details.appendChild(buildContextBody(doc, context, expression));
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
    void onImproveBlock({ blockId, instruction: instruction.value });
  });
}

/** 「AI に渡す内容を見る」の中身。context が null なら現式のみ示す。 */
function buildContextBody(
  doc: Document,
  context: BlockImprovementContext | null,
  fallbackExpression: string
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
 */
function renderImprovementState(
  doc: Document,
  slot: HTMLElement,
  improvement: BlockImprovementState,
  editor: FormulaEditor,
  callbacks: EditViewCallbacks,
  blockId: string
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
  renderProposal(doc, slot, editor, callbacks, blockId, result);
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
 */
function renderProposal(
  doc: Document,
  slot: HTMLElement,
  editor: FormulaEditor,
  callbacks: EditViewCallbacks,
  blockId: string,
  result: BlockImprovementResult
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

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
