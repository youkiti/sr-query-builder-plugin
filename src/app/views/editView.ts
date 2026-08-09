import {
  applyBlockImprovement,
  type BlockImprovementContext,
  type BlockImprovementResult,
  type RequestBlockImprovementInput,
  type SaveEditedFormulaInput,
} from '@/app/services';
import { parsePubmedFormulaMd } from '@/lib/search-formula-md';
import { ROUTE_LABELS } from '../router';
import type { AppState, BlockImprovementState, FormulaSaveState } from '../store';
import type { RenderView } from './types';

/**
 * 検索式手編集画面（#/edit）。
 *
 * ブロック（`#1`〜）ごとのカードを並べ、各ブロックに対して 2 つの編集手段を提供する:
 *
 * 1. **インライン手編集**: カードにホバー / フォーカスすると鉛筆ボタンが現れ、
 *    クリックでその行を直接書き換えられる。保存すると内部の formula_md を更新する。
 * 2. **ブロック単位 AI 改善（requirements.md §4.7）**: 「AI に改善させる」を押すと
 *    任意の指示文を入力する欄が開き（空でも可）、improve-block skill を実行する。
 *    提案 expression と rationale を diff 表示し、「置き換える」で内部 md に反映する。
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

export interface EditViewCallbacks {
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
  /** 編集メモを store（formulaEditNote）へ反映する（確定時＝change イベントのみ） */
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

export function createEditView(callbacks: EditViewCallbacks = {}): RenderView {
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
      '各ブロックは鉛筆アイコンで直接編集するか、「AI に改善させる」で再設計できます。最後に「新バージョンとして保存」を押すと FormulaVersions に user_edit として追記されます。';
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
    // 確定時（blur / Enter）だけ store へ送る。打鍵ごとに setState すると全ビュー再描画が
    // 走り、開いている鉛筆編集フォームや AI 指示欄が毎回壊れてしまうため。
    noteInput.addEventListener('change', () => {
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
      renderBlockList(doc, blocksList, editor, internalCallbacks, improvement);
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
  improvement: BlockImprovementState | null
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
  for (const block of formula.blocks) {
    ul.appendChild(
      buildBlockRow(
        doc,
        block.id,
        block.expression,
        editor,
        callbacks,
        improvement !== null && improvement.blockId === block.id ? improvement : null
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
  improvement: BlockImprovementState | null
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

  const currentPre = doc.createElement('pre');
  currentPre.className = 'edit__block-current';
  currentPre.textContent = expression;
  li.appendChild(currentPre);

  // インライン手編集用スロット（鉛筆ボタンで開く）
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

  editToggle.addEventListener('click', () => {
    if (editSlot.childElementCount > 0) {
      // 既に開いていればトグルで閉じる
      closeInlineEdit(editSlot, currentPre, editToggle);
      return;
    }
    openInlineEdit(doc, editSlot, currentPre, editToggle, blockId, expression, editor);
  });

  improveBtn.addEventListener('click', () => {
    if (!callbacks.onImproveBlock) {
      return;
    }
    if (aiSlot.childElementCount > 0) {
      // 既に開いていればトグルで閉じる。
      aiSlot.innerHTML = '';
      if (improvement) {
        // store 由来の提案パネル（ready/error）を閉じる場合は恒久的に引っ込める
        // （呼ばなければ次の再描画で同じ内容が復元されてしまう）。
        // improvement が null（＝未送信の指示入力フォームを閉じるだけ）のときは
        // store 側に消すものが無いので呼ばない（他ブロックの編集中の状態を無駄に
        // 巻き込む全ビュー再描画を誘発しないため）。
        callbacks.onClearImprovement?.();
      }
      return;
    }
    openAiPromptForm(
      doc,
      aiSlot,
      blockId,
      expression,
      callbacks.onImproveBlock,
      callbacks.onGetImproveContext
    );
  });

  return li;
}

/** 鉛筆ボタンで開くインライン編集フォームを構築する。 */
function openInlineEdit(
  doc: Document,
  slot: HTMLElement,
  currentPre: HTMLElement,
  editToggle: HTMLButtonElement,
  blockId: string,
  expression: string,
  editor: FormulaEditor
): void {
  currentPre.style.display = 'none';
  editToggle.setAttribute('aria-expanded', 'true');

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

  slot.appendChild(form);
  input.focus();

  saveBtn.addEventListener('click', () => {
    const next = input.value.trim();
    if (next === '') {
      editError.textContent = '式が空です。内容を入力してください。';
      return;
    }
    try {
      const updated = applyBlockImprovement(editor.getMd(), blockId, next);
      // setMd がブロック一覧（または store 経由の全体）を再描画するため、
      // この row は破棄され新値で再生成される。
      editor.setMd(updated);
    } catch (err) {
      editError.textContent = `保存に失敗しました: ${formatError(err)}`;
    }
  });

  cancelBtn.addEventListener('click', () => {
    closeInlineEdit(slot, currentPre, editToggle);
  });
}

function closeInlineEdit(
  slot: HTMLElement,
  currentPre: HTMLElement,
  editToggle: HTMLButtonElement
): void {
  slot.innerHTML = '';
  currentPre.style.display = '';
  editToggle.removeAttribute('aria-expanded');
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
  onGetImproveContext: EditViewCallbacks['onGetImproveContext']
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

  const diff = doc.createElement('div');
  diff.className = 'edit__block-diff';
  const before = doc.createElement('div');
  before.className = 'edit__block-diff-before';
  const beforeHeader = doc.createElement('strong');
  beforeHeader.textContent = 'Before:';
  before.appendChild(beforeHeader);
  const beforePre = doc.createElement('pre');
  beforePre.textContent = result.currentExpression;
  before.appendChild(beforePre);

  const after = doc.createElement('div');
  after.className = 'edit__block-diff-after';
  const afterHeader = doc.createElement('strong');
  afterHeader.textContent = 'After:';
  after.appendChild(afterHeader);
  const afterPre = doc.createElement('pre');
  afterPre.textContent = result.proposedExpression;
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
