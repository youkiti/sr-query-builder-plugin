import {
  applyBlockImprovement,
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
 * 2 つの編集モードを提供する:
 *
 * 1. **全体エディタ**: 現在の currentFormulaMarkdown をテキストエリアで自由編集し、
 *    「新バージョンとして保存」で FormulaVersions に追記する。
 * 2. **行単位 AI 改善（requirements.md §4.7）**: 検索式を行ごとに分解し、
 *    各ブロックに「このブロックを AI に改善させる」ボタンを表示。クリックで
 *    improve-block skill を実行し、提案 expression と rationale を diff 表示。
 *    「置き換える」でテキストエリアの該当行を書き換え、「破棄」で現状維持。
 *
 * サービス呼び出しは bootstrap 側で editService の各関数を callback として渡す。
 */

export interface EditViewCallbacks {
  onSave?: (input: SaveEditedFormulaInput) => Promise<SaveEditedFormulaResult>;
  /** 指定ブロックを LLM で改善させる */
  onImproveBlock?: (input: RequestBlockImprovementInput) => Promise<BlockImprovementResult>;
  /**
   * textarea を拡張する（CodeMirror 等でシンタックスハイライトを付ける）オプション。
   * 既定では textarea のまま。本番エントリ（`src/app/app.ts`）で CodeMirror 実装を渡す。
   * jsdom テストでは未指定 or stub のまま動く。
   */
  enhanceEditor?: (textarea: HTMLTextAreaElement) => void;
}

interface ProposalEntry extends BlockImprovementResult {
  /** 提案受信時点のエディタ本文（accept 時の base として使う） */
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
      '検索式 Markdown を編集して「新バージョンとして保存」を押すと、FormulaVersions に user_edit として追記されます。';
    container.appendChild(lead);

    const textarea = doc.createElement('textarea');
    textarea.className = 'edit__formula';
    textarea.rows = 20;
    textarea.value = ctx.state.currentFormulaMarkdown;
    container.appendChild(textarea);
    // シンタックスハイライト等の DOM 拡張は呼び出し側で追加する
    // （bootstrap で CodeMirror 実装を注入、テストでは stub）。
    callbacks.enhanceEditor?.(textarea);

    const blocksSection = doc.createElement('section');
    blocksSection.className = 'edit__blocks';
    const blocksHeading = doc.createElement('h3');
    blocksHeading.textContent = 'ブロック別 AI 改善';
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

    const rerenderBlocks = (): void => {
      renderBlockList(doc, blocksList, textarea, callbacks);
    };
    rerenderBlocks();
    // 全体エディタを直接いじったら、ブロック分解も再描画（存在行の increment 等）
    textarea.addEventListener('input', rerenderBlocks);

    saveBtn.addEventListener('click', () => {
      if (!callbacks.onSave) {
        return;
      }
      saveBtn.disabled = true;
      status.textContent = '保存中…';
      errorBox.textContent = '';
      callbacks
        .onSave({ formulaMd: textarea.value, note: noteInput.value })
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
 * textarea の現在値を parsePubmedFormulaMd でブロック分解し、
 * 各ブロックごとに「現式表示 + AI 改善ボタン + 提案スロット」を再描画する。
 *
 * パースに失敗した場合は「式の形式が壊れているため行単位改善は使えません」を表示。
 */
function renderBlockList(
  doc: Document,
  ul: HTMLElement,
  textarea: HTMLTextAreaElement,
  callbacks: EditViewCallbacks
): void {
  ul.innerHTML = '';
  let formula;
  try {
    formula = parsePubmedFormulaMd(textarea.value);
  } catch (err) {
    const warn = doc.createElement('li');
    warn.className = 'edit__block-error';
    warn.textContent = `現状のエディタ内容が PubMed セクション形式としてパースできません: ${formatError(err)}`;
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
    ul.appendChild(buildBlockRow(doc, block.id, block.expression, textarea, callbacks));
  }
}

function buildBlockRow(
  doc: Document,
  blockId: string,
  expression: string,
  textarea: HTMLTextAreaElement,
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
  const improveBtn = doc.createElement('button');
  improveBtn.type = 'button';
  improveBtn.className = 'edit__block-improve';
  improveBtn.textContent = 'AI に改善させる';
  header.appendChild(improveBtn);
  li.appendChild(header);

  const currentPre = doc.createElement('pre');
  currentPre.className = 'edit__block-current';
  currentPre.textContent = expression;
  li.appendChild(currentPre);

  const proposalSlot = doc.createElement('div');
  proposalSlot.className = 'edit__block-proposal';
  proposalSlot.setAttribute('aria-live', 'polite');
  li.appendChild(proposalSlot);

  improveBtn.addEventListener('click', () => {
    if (!callbacks.onImproveBlock) {
      return;
    }
    improveBtn.disabled = true;
    proposalSlot.innerHTML = '';
    const pending = doc.createElement('p');
    pending.className = 'edit__block-pending';
    pending.textContent = '改善提案を取得中…';
    proposalSlot.appendChild(pending);
    callbacks
      .onImproveBlock({ blockId })
      .then((result) => {
        const base = textarea.value;
        renderProposal(doc, proposalSlot, textarea, {
          ...result,
          baseFormulaMd: base,
        });
      })
      .catch((err: unknown) => {
        proposalSlot.innerHTML = '';
        const errEl = doc.createElement('p');
        errEl.className = 'edit__block-error';
        errEl.textContent = `改善提案の取得に失敗しました: ${formatError(err)}`;
        proposalSlot.appendChild(errEl);
      })
      .finally(() => {
        improveBtn.disabled = false;
      });
  });

  return li;
}

/**
 * improve-block 結果の diff を表示し、accept / reject ボタンを用意する。
 * 受信時点の textarea 内容を base として握り、accept 時はその base に対して
 * applyBlockImprovement を当てて差し替える。
 */
function renderProposal(
  doc: Document,
  slot: HTMLElement,
  textarea: HTMLTextAreaElement,
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
      textarea.value = next;
      // textarea.value = は input イベントを自動で発火しないため、手動で再レンダを回す
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      feedback.textContent = '置き換えました。保存するには「新バージョンとして保存」を押してください。';
      acceptBtn.disabled = true;
      rejectBtn.disabled = true;
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
