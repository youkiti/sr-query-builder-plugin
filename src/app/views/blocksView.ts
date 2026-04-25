import {
  normalizeCombinationExpression,
  validateCombinationExpression,
} from '@/lib/combination-expression';
import { designDefaultFilters } from '@/features/formula/skills';
import { ROUTE_LABELS } from '../router';
import type { AppStore, BlockDraft, BlocksDraft, ProtocolDraft } from '../store';
import {
  MAX_BLOCKS,
  MIN_BLOCKS,
  addBlock,
  blockIdsOf,
  defaultCombination,
  emptyBlock,
  moveBlock,
  removeBlock,
  resetCombinationToAllAnd,
  setCombinationExpression,
  updateBlock,
} from './blocksHelpers';
import type { RenderView } from './types';

/**
 * ブロック承認画面（docs/ui-block-approval.md 準拠）。
 * - 1〜5 個のブロック（label / description / note）の編集
 * - 並び替え（↑↓ ボタン）
 * - 追加 / 削除
 * - combination_expression の編集 + ライブ構文チェック
 * - 「下書きとして保存」「承認してシード論文へ」の 2 種類のボタン
 *
 * MVP では LLM 再生成 / 統合 / 分割は省略（後続セッションで追加）。
 *
 * 編集状態は app/store の blocksDraft に持つ。store を必要とするため
 * createBlocksView(store) でファクトリ経由で生成する。
 */

export interface BlocksViewCallbacks {
  /** 「下書きとして保存」ボタンが押されたとき */
  onSaveDraft?: (draft: BlocksDraft) => void | Promise<void>;
  /** 「承認してシード論文へ」が押されたとき */
  onApprove?: (draft: BlocksDraft) => void | Promise<void>;
}

export function createBlocksView(
  store: AppStore,
  callbacks: BlocksViewCallbacks = {}
): RenderView {
  return (container, ctx) => {
    container.innerHTML = '';

    const heading = container.ownerDocument.createElement('h2');
    heading.textContent = ROUTE_LABELS.blocks;
    container.appendChild(heading);

    if (!ctx.state.project) {
      const warn = container.ownerDocument.createElement('p');
      warn.className = 'view__placeholder';
      warn.textContent = '先にプロジェクトを選択してください。';
      container.appendChild(warn);
      return;
    }

    const draft = ensureDraft(store);
    container.appendChild(
      buildProtocolReference(container.ownerDocument, ctx.state.protocolDraft)
    );
    container.appendChild(buildSummary(container.ownerDocument, draft));
    container.appendChild(buildBlockList(container.ownerDocument, draft, store));
    container.appendChild(buildAddRow(container.ownerDocument, draft, store));
    container.appendChild(buildCombinationEditor(container.ownerDocument, draft, store));
    container.appendChild(buildActionRow(container.ownerDocument, draft, store, callbacks));
  };
}

function ensureDraft(store: AppStore): BlocksDraft {
  const current = store.getState().blocksDraft;
  if (current !== null) {
    return current;
  }
  const initial: BlocksDraft = {
    blocks: [emptyBlock()],
    combinationExpression: defaultCombination(1),
  };
  store.setState((s) => ({ ...s, blocksDraft: initial }));
  return initial;
}

function buildProtocolReference(doc: Document, protocol: ProtocolDraft | null): HTMLElement {
  const section = doc.createElement('section');
  section.className = 'blocks__protocol-ref';

  const title = doc.createElement('h3');
  title.className = 'blocks__protocol-ref-title';
  title.textContent = 'プロトコル';
  section.appendChild(title);

  if (!protocol) {
    const empty = doc.createElement('p');
    empty.className = 'blocks__protocol-ref-empty';
    empty.textContent = 'プロトコルが入力されていません。';
    section.appendChild(empty);
    return section;
  }

  const body = doc.createElement('div');
  body.className = 'blocks__protocol-ref-body';

  appendRefField(doc, body, 'Framework', protocol.frameworkType.toUpperCase());
  appendRefField(doc, body, 'RQ', protocol.researchQuestion);
  appendRefField(doc, body, 'Study design', protocol.studyDesign);
  appendRefField(doc, body, '組入基準', protocol.inclusionCriteria);
  appendRefField(doc, body, '除外基準', protocol.exclusionCriteria);

  const rawText = protocol.rawTextInline ?? protocol.rawTextPreview;
  if (rawText) {
    const sourceLabel =
      protocol.sourceType === 'manual'
        ? '元テキスト'
        : `元テキスト（${protocol.sourceFilename ?? protocol.sourceType}・先頭 500 文字）`;
    appendRefField(doc, body, sourceLabel, rawText);
  }

  section.appendChild(body);
  return section;
}

function appendRefField(
  doc: Document,
  parent: HTMLElement,
  label: string,
  value: string
): void {
  if (!value) {
    return;
  }
  const wrap = doc.createElement('div');
  wrap.className = 'blocks__protocol-ref-field';

  const dt = doc.createElement('div');
  dt.className = 'blocks__protocol-ref-label';
  dt.textContent = label;
  wrap.appendChild(dt);

  const dd = doc.createElement('div');
  dd.className = 'blocks__protocol-ref-value';
  dd.textContent = value;
  wrap.appendChild(dd);

  parent.appendChild(wrap);
}

function buildSummary(doc: Document, draft: BlocksDraft): HTMLElement {
  const p = doc.createElement('p');
  p.className = 'blocks__summary';
  p.textContent = `ブロック数: ${draft.blocks.length} / ${MAX_BLOCKS}`;
  return p;
}

function buildBlockList(doc: Document, draft: BlocksDraft, store: AppStore): HTMLElement {
  const list = doc.createElement('ol');
  list.className = 'blocks__list';
  draft.blocks.forEach((block, index) => {
    list.appendChild(buildBlockItem(doc, block, index, draft, store));
  });
  return list;
}

function buildBlockItem(
  doc: Document,
  block: BlockDraft,
  index: number,
  draft: BlocksDraft,
  store: AppStore
): HTMLElement {
  const li = doc.createElement('li');
  li.className = 'blocks__item';
  li.dataset['index'] = String(index);

  const header = doc.createElement('div');
  header.className = 'blocks__item-header';

  const idLabel = doc.createElement('span');
  idLabel.className = 'blocks__item-id';
  idLabel.textContent = `#${index + 1}`;
  header.appendChild(idLabel);

  const badge = doc.createElement('span');
  badge.className = `blocks__badge blocks__badge--${block.aiGenerated ? 'ai' : 'user'}`;
  badge.textContent = block.aiGenerated ? '🤖 AI 生成' : '✏️ ユーザー編集';
  header.appendChild(badge);

  header.appendChild(buildIconButton(doc, '↑', () => mutateDraft(store, (d) => moveBlock(d, index, -1))));
  header.appendChild(buildIconButton(doc, '↓', () => mutateDraft(store, (d) => moveBlock(d, index, 1))));
  header.appendChild(
    buildIconButton(
      doc,
      '削除',
      () => mutateDraft(store, (d) => removeBlock(d, index)),
      draft.blocks.length <= MIN_BLOCKS
    )
  );

  li.appendChild(header);

  const labelInput = doc.createElement('input');
  labelInput.type = 'text';
  labelInput.value = block.blockLabel;
  labelInput.placeholder = 'Label (例: Population)';
  labelInput.className = 'blocks__label-input';
  labelInput.setAttribute('aria-label', `ブロック ${index + 1} のラベル`);
  labelInput.addEventListener('input', () => {
    mutateDraft(store, (d) => updateBlock(d, index, { blockLabel: labelInput.value }));
  });
  li.appendChild(labelInput);

  const descArea = doc.createElement('textarea');
  descArea.value = block.description;
  descArea.placeholder = 'このブロックで捉えたい概念を 1-3 文で';
  descArea.className = 'blocks__desc';
  descArea.setAttribute('aria-label', `ブロック ${index + 1} の説明`);
  descArea.addEventListener('input', () => {
    mutateDraft(store, (d) => updateBlock(d, index, { description: descArea.value }));
  });
  li.appendChild(descArea);

  const noteArea = doc.createElement('textarea');
  noteArea.value = block.note;
  noteArea.placeholder = 'note（任意）';
  noteArea.className = 'blocks__note';
  noteArea.setAttribute('aria-label', `ブロック ${index + 1} のノート`);
  noteArea.addEventListener('input', () => {
    mutateDraft(store, (d) => updateBlock(d, index, { note: noteArea.value }));
  });
  li.appendChild(noteArea);

  return li;
}

function buildAddRow(doc: Document, draft: BlocksDraft, store: AppStore): HTMLElement {
  const wrap = doc.createElement('div');
  wrap.className = 'blocks__add-row';
  const addBtn = doc.createElement('button');
  addBtn.type = 'button';
  addBtn.textContent = '＋ ブロックを追加';
  addBtn.disabled = draft.blocks.length >= MAX_BLOCKS;
  addBtn.addEventListener('click', () => mutateDraft(store, addBlock));
  wrap.appendChild(addBtn);
  return wrap;
}

function buildCombinationEditor(
  doc: Document,
  draft: BlocksDraft,
  store: AppStore
): HTMLElement {
  const fieldset = doc.createElement('fieldset');
  fieldset.className = 'blocks__combination';
  const legend = doc.createElement('legend');
  legend.textContent = '結合式 (combination_expression)';
  fieldset.appendChild(legend);

  const preview = doc.createElement('div');
  preview.className = 'blocks__combination-preview';
  preview.textContent = `プレビュー: ${normalizeCombinationExpression(draft.combinationExpression)}`;
  fieldset.appendChild(preview);

  const input = doc.createElement('input');
  input.type = 'text';
  input.value = draft.combinationExpression;
  input.className = 'blocks__combination-input';
  input.setAttribute('aria-label', '結合式 (combination_expression)');
  input.addEventListener('input', () => {
    mutateDraft(store, (d) => setCombinationExpression(d, input.value));
  });
  fieldset.appendChild(input);

  const errorList = doc.createElement('ul');
  errorList.className = 'blocks__combination-errors';
  const validation = validateCombinationExpression(draft.combinationExpression, blockIdsOf(draft));
  for (const err of validation.errors) {
    const li = doc.createElement('li');
    li.textContent = `pos ${err.position}: ${err.message}`;
    errorList.appendChild(li);
  }
  fieldset.appendChild(errorList);

  const autoFilter = buildAutoFilterPreview(doc, draft, store.getState().protocolDraft);
  if (autoFilter) {
    fieldset.appendChild(autoFilter);
  }

  const resetBtn = doc.createElement('button');
  resetBtn.type = 'button';
  resetBtn.textContent = '全 AND に戻す';
  resetBtn.addEventListener('click', () => mutateDraft(store, resetCombinationToAllAnd));
  fieldset.appendChild(resetBtn);

  return fieldset;
}

/**
 * 検索式生成時に filter-designer が決定論的に自動付与するブロック（#RCTfilter / #DateFilter）の
 * プレビューを返す。study_design / yearRange のいずれも該当しない場合は null。
 */
function buildAutoFilterPreview(
  doc: Document,
  draft: BlocksDraft,
  protocol: ProtocolDraft | null
): HTMLElement | null {
  if (!protocol) {
    return null;
  }
  const filterResult = designDefaultFilters({ studyDesign: protocol.studyDesign });
  if (filterResult.filters.length === 0) {
    return null;
  }

  const wrap = doc.createElement('div');
  wrap.className = 'blocks__autofilter';

  const finalLine = doc.createElement('div');
  finalLine.className = 'blocks__autofilter-final';
  const finalExpr =
    normalizeCombinationExpression(draft.combinationExpression) +
    filterResult.appendToCombination;
  finalLine.textContent = `検索式生成後: ${finalExpr}`;
  wrap.appendChild(finalLine);

  const list = doc.createElement('ul');
  list.className = 'blocks__autofilter-list';
  for (const f of filterResult.filters) {
    const li = doc.createElement('li');
    li.textContent = `#${f.blockId}: ${f.comment}`;
    list.appendChild(li);
  }
  wrap.appendChild(list);

  return wrap;
}

function buildActionRow(
  doc: Document,
  draft: BlocksDraft,
  store: AppStore,
  callbacks: BlocksViewCallbacks
): HTMLElement {
  const wrap = doc.createElement('div');
  wrap.className = 'blocks__actions';

  const validation = validateCombinationExpression(draft.combinationExpression, blockIdsOf(draft));
  const hasErrors = validation.errors.length > 0;

  const draftBtn = doc.createElement('button');
  draftBtn.type = 'button';
  draftBtn.textContent = '下書きとして保存';
  draftBtn.addEventListener('click', () => {
    runAction(
      callbacks.onSaveDraft,
      store,
      errorBox,
      () => {
        draftBtn.disabled = true;
        approveBtn.disabled = true;
      },
      () => {
        draftBtn.disabled = false;
        approveBtn.disabled = hasErrors;
      }
    );
  });
  wrap.appendChild(draftBtn);

  const approveBtn = doc.createElement('button');
  approveBtn.type = 'button';
  approveBtn.textContent = '承認してシード論文へ →';
  approveBtn.disabled = hasErrors;
  approveBtn.addEventListener('click', () => {
    runAction(
      callbacks.onApprove,
      store,
      errorBox,
      () => {
        draftBtn.disabled = true;
        approveBtn.disabled = true;
      },
      () => {
        draftBtn.disabled = false;
        approveBtn.disabled = hasErrors;
      }
    );
  });
  wrap.appendChild(approveBtn);

  const errorBox = doc.createElement('p');
  errorBox.className = 'blocks__error';
  errorBox.id = 'blocks-error';
  errorBox.setAttribute('aria-live', 'polite');
  wrap.appendChild(errorBox);

  return wrap;
}

function buildIconButton(
  doc: Document,
  label: string,
  onClick: () => void,
  disabled = false
): HTMLButtonElement {
  const btn = doc.createElement('button');
  btn.type = 'button';
  btn.textContent = label;
  btn.disabled = disabled;
  btn.addEventListener('click', onClick);
  return btn;
}

function mutateDraft(store: AppStore, mutator: (d: BlocksDraft) => BlocksDraft): void {
  store.setState((s) => {
    if (s.blocksDraft === null) return s;
    return { ...s, blocksDraft: mutator(s.blocksDraft) };
  });
}

function runAction(
  action: ((draft: BlocksDraft) => void | Promise<void>) | undefined,
  store: AppStore,
  errorBox: HTMLElement,
  onStart: () => void,
  onFinally: () => void
): void {
  errorBox.textContent = '';
  const draft = store.getState().blocksDraft;
  if (!action || draft === null) {
    return;
  }
  try {
    const result = action(draft);
    if (!isPromiseLike(result)) {
      return;
    }
    onStart();
    void result
      .catch((err: unknown) => {
        errorBox.textContent = formatError(err);
      })
      .finally(onFinally);
  } catch (err) {
    errorBox.textContent = formatError(err);
  }
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isPromiseLike(value: unknown): value is Promise<void> {
  return typeof value === 'object' && value !== null && 'then' in value;
}
