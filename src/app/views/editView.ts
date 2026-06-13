import {
  applyBlockImprovement,
  type BlockImprovementContext,
  type BlockImprovementResult,
  type RequestBlockImprovementInput,
  type SaveEditedFormulaInput,
  type SaveEditedFormulaResult,
} from '@/app/services';
import { parsePubmedFormulaMd } from '@/lib/search-formula-md';
import { ROUTE_LABELS } from '../router';
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
 * 検索式 Markdown 全文は内部状態 `currentMd` として保持し（テキストエリアは出さない）、
 * 「新バージョンとして保存」で FormulaVersions に user_edit として追記する。
 *
 * サービス呼び出しは bootstrap 側で editService の各関数を callback として渡す。
 */

export interface EditViewCallbacks {
  onSave?: (input: SaveEditedFormulaInput) => Promise<SaveEditedFormulaResult>;
  /** 指定ブロックを LLM で改善させる（instruction はユーザー任意の指示） */
  onImproveBlock?: (input: RequestBlockImprovementInput) => Promise<BlockImprovementResult>;
  /** 「AI に渡す内容を見る」表示用の文脈スナップショットを取得する（SeedPapers 読み取りを伴う） */
  onGetImproveContext?: (blockId: string) => Promise<BlockImprovementContext | null>;
}

/** 検索式 Markdown 全文を保持し、更新時にブロック一覧を再描画する内部コントローラ。 */
interface FormulaEditor {
  getMd(): string;
  /** md を差し替えてブロック一覧を再描画する */
  setMd(next: string): void;
}

interface ProposalEntry extends BlockImprovementResult {
  /** 提案受信時点の md 全文（accept 時の base として使う） */
  baseFormulaMd: string;
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

    // 内部状態。テキストエリアは表示せず、この変数を単一の真実とする。
    let currentMd = ctx.state.currentFormulaMarkdown;
    const editor: FormulaEditor = {
      getMd: () => currentMd,
      setMd: (next: string) => {
        currentMd = next;
        rerenderBlocks();
      },
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
    noteLabel.appendChild(noteInput);
    noteRow.appendChild(noteLabel);
    container.appendChild(noteRow);

    const actions = doc.createElement('div');
    actions.className = 'edit__actions';
    const saveBtn = doc.createElement('button');
    saveBtn.type = 'button';
    saveBtn.textContent = '新バージョンとして保存';
    actions.appendChild(saveBtn);
    container.appendChild(actions);

    const status = doc.createElement('p');
    status.className = 'edit__status';
    status.setAttribute('aria-live', 'polite');
    container.appendChild(status);

    const errorBox = doc.createElement('p');
    errorBox.className = 'edit__error';
    errorBox.setAttribute('aria-live', 'polite');
    container.appendChild(errorBox);

    function rerenderBlocks(): void {
      renderBlockList(doc, blocksList, editor, callbacks);
    }
    rerenderBlocks();

    saveBtn.addEventListener('click', () => {
      if (!callbacks.onSave) {
        return;
      }
      saveBtn.disabled = true;
      status.textContent = '保存中…';
      errorBox.textContent = '';
      callbacks
        .onSave({ formulaMd: editor.getMd(), note: noteInput.value })
        .then((result) => {
          status.textContent = `保存しました（version_id: ${result.versionId}）`;
        })
        .catch((err: unknown) => {
          errorBox.textContent = formatError(err);
          status.textContent = '';
        })
        .finally(() => {
          saveBtn.disabled = false;
        });
    });
  };
}

/**
 * editor.getMd() を parsePubmedFormulaMd でブロック分解し、各ブロックのカードを再描画する。
 * パースに失敗した場合はその旨を表示する。
 */
function renderBlockList(
  doc: Document,
  ul: HTMLElement,
  editor: FormulaEditor,
  callbacks: EditViewCallbacks
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
    ul.appendChild(buildBlockRow(doc, block.id, block.expression, editor, callbacks));
  }
}

function buildBlockRow(
  doc: Document,
  blockId: string,
  expression: string,
  editor: FormulaEditor,
  callbacks: EditViewCallbacks
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

  // AI 改善（プロンプト欄 → 提案）用スロット
  const aiSlot = doc.createElement('div');
  aiSlot.className = 'edit__block-ai';
  aiSlot.setAttribute('aria-live', 'polite');
  li.appendChild(aiSlot);

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
      // 既に開いていればトグルで閉じる
      aiSlot.innerHTML = '';
      return;
    }
    openAiPromptForm(
      doc,
      aiSlot,
      improveBtn,
      blockId,
      expression,
      editor,
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
      // setMd がブロック一覧を丸ごと再描画するため、この row は破棄され新値で再生成される。
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
 * 「改善案を取得」で onImproveBlock を呼び、結果を同じスロットに diff 表示する。
 */
function openAiPromptForm(
  doc: Document,
  slot: HTMLElement,
  improveBtn: HTMLButtonElement,
  blockId: string,
  expression: string,
  editor: FormulaEditor,
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
    submitBtn.disabled = true;
    cancelBtn.disabled = true;
    const pendingInstruction = instruction.value;
    slot.innerHTML = '';
    const pending = doc.createElement('p');
    pending.className = 'edit__block-pending';
    pending.textContent = '改善提案を取得中…';
    slot.appendChild(pending);
    const base = editor.getMd();
    onImproveBlock({ blockId, instruction: pendingInstruction })
      .then((result) => {
        renderProposal(doc, slot, editor, { ...result, baseFormulaMd: base });
      })
      .catch((err: unknown) => {
        slot.innerHTML = '';
        const errEl = doc.createElement('p');
        errEl.className = 'edit__block-error';
        errEl.textContent = `改善提案の取得に失敗しました: ${formatError(err)}`;
        slot.appendChild(errEl);
      })
      .finally(() => {
        improveBtn.disabled = false;
      });
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
 * improve-block 結果の diff を表示し、accept / reject ボタンを用意する。
 * 受信時点の md を base として握り、accept 時はその base に対して
 * applyBlockImprovement を当てて差し替える。
 */
function renderProposal(
  doc: Document,
  slot: HTMLElement,
  editor: FormulaEditor,
  entry: ProposalEntry
): void {
  slot.innerHTML = '';
  const rationale = doc.createElement('p');
  rationale.className = 'edit__block-rationale';
  rationale.textContent = entry.rationale === '' ? '（改善ポイントの説明なし）' : entry.rationale;
  slot.appendChild(rationale);

  const diff = doc.createElement('div');
  diff.className = 'edit__block-diff';
  const before = doc.createElement('div');
  before.className = 'edit__block-diff-before';
  const beforeHeader = doc.createElement('strong');
  beforeHeader.textContent = 'Before:';
  before.appendChild(beforeHeader);
  const beforePre = doc.createElement('pre');
  beforePre.textContent = entry.currentExpression;
  before.appendChild(beforePre);

  const after = doc.createElement('div');
  after.className = 'edit__block-diff-after';
  const afterHeader = doc.createElement('strong');
  afterHeader.textContent = 'After:';
  after.appendChild(afterHeader);
  const afterPre = doc.createElement('pre');
  afterPre.textContent = entry.proposedExpression;
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
  if (entry.proposedExpression.trim() === '' ||
      entry.proposedExpression.trim() === entry.currentExpression.trim()) {
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
      const next = applyBlockImprovement(
        entry.baseFormulaMd,
        entry.blockId,
        entry.proposedExpression
      );
      // setMd がブロック一覧を再描画するので、提案スロットは破棄され新値で再生成される。
      editor.setMd(next);
    } catch (err) {
      feedback.textContent = `置き換えに失敗しました: ${formatError(err)}`;
    }
  });

  rejectBtn.addEventListener('click', () => {
    slot.innerHTML = '';
  });
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
