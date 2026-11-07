import { getUiLanguage, t } from '@/lib/i18n';
import { ROUTE_LABELS } from '../router';
import {
  normalizeCombinationExpression,
  validateCombinationExpression,
} from '@/lib/combination-expression';
import {
  PREDEFINED_FILTER_DEFS,
  getDefaultSelectedFilterIds,
  explainDefaultFilterSelection,
  buildFiltersFromSelection,
} from '@/features/formula/skills';
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
 * ブロック承認画面（docs/ui-block-approval.md 準拠・案 B レイアウト）。
 * - 1〜5 個のブロック（label / description / note）の編集
 * - 並び替え（↑↓ ボタン）/ 追加 / 削除
 * - combination_expression の編集 + ライブ構文チェック + 自動フィルタプレビュー
 * - 「下書きとして保存」「承認してシード論文へ」の 2 種類のボタン
 *
 * 画面の 3 つの活動をローカルステッパーで可視化する:
 *   ① ブロックを確認・編集
 *   ② 結合式 (combination_expression) を確認
 *   ③ 承認してシード論文へ
 *
 * 各ブロックは「ヘッダ行（番号・バッジ・並び替え/削除）」と
 * 「本体（ラベル・説明・メモ）」に分けてカード表示する。
 * アクション行は sticky にし、スクロールしても操作できる。
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
    container.classList.add('blocks__view');

    const heading = container.ownerDocument.createElement('h2');
    heading.textContent = ROUTE_LABELS.blocks;
    container.appendChild(heading);

    if (!ctx.state.project) {
      const warn = container.ownerDocument.createElement('p');
      warn.className = 'view__placeholder';
      warn.textContent = t('blocks.noProject');
      container.appendChild(warn);
      return;
    }

    const draft = ensureDraft(store);

    container.appendChild(buildLede(container.ownerDocument));
    if (ctx.state.blocksDraftSavedAt !== null) {
      container.appendChild(
        buildUnapprovedDraftNotice(container.ownerDocument, ctx.state.blocksDraftSavedAt)
      );
    }
    container.appendChild(buildStepper(container.ownerDocument));
    container.appendChild(
      buildProtocolReference(container.ownerDocument, ctx.state.protocolDraft)
    );
    container.appendChild(buildBlocksSection(container.ownerDocument, draft, store));
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

function buildLede(doc: Document): HTMLElement {
  const p = doc.createElement('p');
  p.className = 'blocks__lede';
  p.textContent =
    t('blocks.lead');
  return p;
}

/**
 * 「下書きとして保存」済み（未承認）の編集があることを知らせるバナー。
 * chrome.storage のバックアップから復元した直後と、保存直後の両方で表示される。
 */
function buildUnapprovedDraftNotice(doc: Document, savedAt: string): HTMLElement {
  const notice = doc.createElement('div');
  notice.className = 'blocks__draft-notice';
  notice.setAttribute('role', 'status');
  const savedDate = new Date(savedAt);
  const savedLabel = Number.isNaN(savedDate.getTime())
    ? savedAt
    : savedDate.toLocaleString('ja-JP');
  notice.textContent = t('blocks.unsaved', { savedAt: savedLabel });
  return notice;
}

function buildStepper(doc: Document): HTMLElement {
  const ol = doc.createElement('ol');
  ol.className = 'blocks__stepper';
  ol.setAttribute('aria-label', t('blocks.steps'));
  const steps: Array<{ num: string; title: string; desc: string }> = [
    { num: '1', title: t('blocks.stepReview'), desc: t('blocks.stepReviewDescription') },
    { num: '2', title: t('blocks.stepCombination'), desc: t('blocks.stepCombinationDescription') },
    { num: '3', title: t('blocks.stepApprove'), desc: t('blocks.stepApproveDescription') },
  ];
  steps.forEach((s) => {
    const li = doc.createElement('li');
    li.className = 'blocks__step';
    const num = doc.createElement('span');
    num.className = 'blocks__step-num';
    num.textContent = s.num;
    const body = doc.createElement('span');
    body.className = 'blocks__step-body';
    const title = doc.createElement('span');
    title.className = 'blocks__step-title';
    title.textContent = s.title;
    const desc = doc.createElement('span');
    desc.className = 'blocks__step-desc';
    desc.textContent = s.desc;
    body.appendChild(title);
    body.appendChild(desc);
    li.appendChild(num);
    li.appendChild(body);
    ol.appendChild(li);
  });
  return ol;
}

function buildProtocolReference(doc: Document, protocol: ProtocolDraft | null): HTMLElement {
  const section = doc.createElement('section');
  section.className = 'blocks__protocol-ref';

  const title = doc.createElement('h3');
  title.className = 'blocks__protocol-ref-title';
  title.textContent = t('blocks.protocol');
  section.appendChild(title);

  if (!protocol) {
    const empty = doc.createElement('p');
    empty.className = 'blocks__protocol-ref-empty';
    empty.textContent = t('blocks.noProtocol');
    section.appendChild(empty);
    return section;
  }

  const body = doc.createElement('div');
  body.className = 'blocks__protocol-ref-body';
  // overflow-y: auto のスクロール領域はキーボードで到達できる必要がある（axe: scrollable-region-focusable）
  body.tabIndex = 0;
  body.setAttribute('role', 'region');
  body.setAttribute('aria-label', t('blocks.protocolReference'));

  appendRefField(doc, body, 'Framework', protocol.frameworkType.toUpperCase());
  appendRefField(doc, body, 'RQ', protocol.researchQuestion);
  appendRefField(doc, body, 'Study design', protocol.studyDesign);
  appendRefField(doc, body, t('blocks.inclusion'), protocol.inclusionCriteria);
  appendRefField(doc, body, t('blocks.exclusion'), protocol.exclusionCriteria);

  const rawText = protocol.rawTextInline ?? protocol.rawTextPreview;
  if (rawText) {
    const sourceLabel =
      protocol.sourceType === 'manual'
        ? t('blocks.source')
        : t('blocks.sourcePreview', { filename: protocol.sourceFilename ?? protocol.sourceType });
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

function buildBlocksSection(doc: Document, draft: BlocksDraft, store: AppStore): HTMLElement {
  const section = doc.createElement('section');
  section.className = 'blocks__section';
  section.dataset.tour = 'blocks-list';
  section.setAttribute('aria-labelledby', 'blocks-section-heading');

  const header = doc.createElement('div');
  header.className = 'blocks__section-header';

  const h3 = doc.createElement('h3');
  h3.id = 'blocks-section-heading';
  h3.className = 'blocks__section-title';
  h3.textContent = t('blocks.list');
  header.appendChild(h3);

  const summary = doc.createElement('span');
  summary.className = 'blocks__summary';
  summary.textContent = t('blocks.count', { count: draft.blocks.length, max: MAX_BLOCKS });
  header.appendChild(summary);

  section.appendChild(header);

  const hint = doc.createElement('p');
  hint.className = 'blocks__section-hint';
  hint.textContent =
    t('blocks.listHint');
  section.appendChild(hint);

  section.appendChild(buildBlockList(doc, draft, store));
  section.appendChild(buildAddRow(doc, draft, store));

  return section;
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
  badge.textContent = block.aiGenerated ? t('blocks.ai') : t('blocks.user');
  header.appendChild(badge);

  const controls = doc.createElement('div');
  controls.className = 'blocks__item-controls';
  controls.appendChild(
    buildIconButton(doc, '↑', () => mutateDraft(store, (d) => moveBlock(d, index, -1)), index === 0)
  );
  controls.appendChild(
    buildIconButton(
      doc,
      '↓',
      () => mutateDraft(store, (d) => moveBlock(d, index, 1)),
      index === draft.blocks.length - 1
    )
  );
  controls.appendChild(
    buildIconButton(
      doc,
      t('blocks.delete'),
      () => mutateDraft(store, (d) => removeBlock(d, index)),
      draft.blocks.length <= MIN_BLOCKS
    )
  );
  header.appendChild(controls);

  li.appendChild(header);

  const body = doc.createElement('div');
  body.className = 'blocks__item-body';

  body.appendChild(
    buildLabeledInput(doc, {
      className: 'blocks__field blocks__field--label',
      title: t('blocks.name'),
      hint: t('blocks.nameHint'),
      value: block.blockLabel,
      placeholder: t('blocks.namePlaceholder'),
      kind: 'input',
      inputClass: 'blocks__label-input',
      ariaLabel: t('blocks.nameAria', { number: index + 1 }),
      onInput: (v) => mutateDraft(store, (d) => updateBlock(d, index, { blockLabel: v })),
    })
  );

  body.appendChild(
    buildLabeledInput(doc, {
      className: 'blocks__field blocks__field--note',
      title: t('blocks.note'),
      hint: t('blocks.noteHint'),
      value: block.note,
      placeholder: t('blocks.notePlaceholder'),
      kind: 'textarea',
      inputClass: 'blocks__note',
      ariaLabel: t('blocks.noteAria', { number: index + 1 }),
      onInput: (v) => mutateDraft(store, (d) => updateBlock(d, index, { note: v })),
    })
  );

  body.appendChild(
    buildLabeledInput(doc, {
      className: 'blocks__field blocks__field--desc',
      title: t('blocks.description'),
      hint: t('blocks.descriptionHint'),
      value: block.description,
      placeholder: t('blocks.descriptionPlaceholder'),
      kind: 'textarea',
      inputClass: 'blocks__desc',
      ariaLabel: t('blocks.descriptionAria', { number: index + 1 }),
      onInput: (v) => mutateDraft(store, (d) => updateBlock(d, index, { description: v })),
    })
  );

  li.appendChild(body);

  return li;
}

interface LabeledInputOptions {
  className: string;
  title: string;
  hint: string;
  value: string;
  placeholder: string;
  kind: 'input' | 'textarea';
  inputClass: string;
  ariaLabel: string;
  onInput: (value: string) => void;
}

function buildLabeledInput(doc: Document, opts: LabeledInputOptions): HTMLElement {
  const wrapper = doc.createElement('label');
  wrapper.className = opts.className;

  const title = doc.createElement('span');
  title.className = 'blocks__field-title';
  title.textContent = opts.title;
  wrapper.appendChild(title);

  const hint = doc.createElement('span');
  hint.className = 'blocks__field-hint';
  hint.textContent = opts.hint;
  wrapper.appendChild(hint);

  if (opts.kind === 'input') {
    const input = doc.createElement('input');
    input.type = 'text';
    input.value = opts.value;
    input.placeholder = opts.placeholder;
    input.className = opts.inputClass;
    input.setAttribute('aria-label', opts.ariaLabel);
    input.addEventListener('input', () => opts.onInput(input.value));
    wrapper.appendChild(input);
  } else {
    const area = doc.createElement('textarea');
    area.value = opts.value;
    area.placeholder = opts.placeholder;
    area.className = opts.inputClass;
    area.setAttribute('aria-label', opts.ariaLabel);
    area.addEventListener('input', () => opts.onInput(area.value));
    wrapper.appendChild(area);
  }

  return wrapper;
}

function buildAddRow(doc: Document, draft: BlocksDraft, store: AppStore): HTMLElement {
  const wrap = doc.createElement('div');
  wrap.className = 'blocks__add-row';
  const addBtn = doc.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'blocks__btn-secondary';
  addBtn.textContent = t('blocks.add');
  addBtn.disabled = draft.blocks.length >= MAX_BLOCKS;
  addBtn.addEventListener('click', () => mutateDraft(store, addBlock));
  wrap.appendChild(addBtn);

  if (draft.blocks.length >= MAX_BLOCKS) {
    const note = doc.createElement('span');
    note.className = 'blocks__add-row-note';
    note.textContent = t('blocks.limit', { max: MAX_BLOCKS });
    wrap.appendChild(note);
  }
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
  legend.textContent = t('blocks.combination');
  fieldset.appendChild(legend);

  const hint = doc.createElement('p');
  hint.className = 'blocks__section-hint';
  hint.textContent =
    t('blocks.combinationHint');
  fieldset.appendChild(hint);

  fieldset.appendChild(buildFilterSelector(doc, draft, store));

  const protocol = store.getState().protocolDraft;
  const selectedIds =
    draft.selectedFilterIds ?? getDefaultSelectedFilterIds(protocol?.studyDesign ?? '');
  const filterResult = buildFiltersFromSelection(selectedIds);
  const baseExpr = normalizeCombinationExpression(draft.combinationExpression);
  const finalExpr = baseExpr + filterResult.appendToCombination;

  const preview = doc.createElement('div');
  preview.className = 'blocks__combination-preview';
  const previewLabel = doc.createElement('span');
  previewLabel.className = 'blocks__combination-preview-label';
  previewLabel.textContent = t('blocks.preview');
  const previewCode = doc.createElement('code');
  previewCode.textContent = finalExpr || t('blocks.empty');
  preview.appendChild(previewLabel);
  preview.appendChild(previewCode);
  fieldset.appendChild(preview);

  const inputWrap = doc.createElement('label');
  inputWrap.className = 'blocks__combination-edit';
  const inputTitle = doc.createElement('span');
  inputTitle.className = 'blocks__field-title';
  inputTitle.textContent = t('blocks.editCombination');
  inputWrap.appendChild(inputTitle);
  const inputHint = doc.createElement('span');
  inputHint.className = 'blocks__field-hint';
  inputHint.textContent = t('blocks.expressionHint');
  inputWrap.appendChild(inputHint);

  const input = doc.createElement('input');
  input.type = 'text';
  input.value = draft.combinationExpression;
  input.className = 'blocks__combination-input';
  input.addEventListener('input', () => {
    mutateDraft(store, (d) => setCombinationExpression(d, input.value));
  });
  inputWrap.appendChild(input);
  fieldset.appendChild(inputWrap);

  const validation = validateCombinationExpression(draft.combinationExpression, blockIdsOf(draft));
  const status = doc.createElement('div');
  status.className = `blocks__combination-status ${
    validation.errors.length === 0
      ? 'blocks__combination-status--ok'
      : 'blocks__combination-status--error'
  }`;
  status.setAttribute('aria-live', 'polite');
  status.textContent =
    validation.errors.length === 0
      ? t('blocks.syntaxOk')
      : t('blocks.errors', { count: validation.errors.length });
  fieldset.appendChild(status);

  const errorList = doc.createElement('ul');
  errorList.className = 'blocks__combination-errors';
  for (const err of validation.errors) {
    const li = doc.createElement('li');
    li.textContent = t('blocks.errorPosition', { position: err.position + 1, message: err.message });
    errorList.appendChild(li);
  }
  fieldset.appendChild(errorList);

  const actions = doc.createElement('div');
  actions.className = 'blocks__combination-actions';
  const resetBtn = doc.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'blocks__btn-secondary';
  resetBtn.textContent = t('blocks.reset');
  resetBtn.addEventListener('click', () => mutateDraft(store, resetCombinationToAllAnd));
  actions.appendChild(resetBtn);
  fieldset.appendChild(actions);

  return fieldset;
}

/**
 * ユーザーが適用するフィルターを選択できるインタラクティブなセレクター。
 * selectedFilterIds が undefined のときは studyDesign から自動推論した値をデフォルトにする。
 */
function buildFilterSelector(doc: Document, draft: BlocksDraft, store: AppStore): HTMLElement {
  const protocol = store.getState().protocolDraft;
  const selectedIds =
    draft.selectedFilterIds ?? getDefaultSelectedFilterIds(protocol?.studyDesign ?? '');

  const section = doc.createElement('div');
  section.className = 'blocks__filter-selector';
  section.dataset.tour = 'blocks-filters';

  const header = doc.createElement('div');
  header.className = 'blocks__filter-selector-header';

  const title = doc.createElement('span');
  title.className = 'blocks__field-title';
  title.textContent = t('blocks.filters');
  header.appendChild(title);

  const hint = doc.createElement('span');
  hint.className = 'blocks__field-hint';
  hint.textContent =
    t('blocks.filtersHint');
  header.appendChild(hint);

  section.appendChild(header);
  const reason = draft.selectedFilterIds === undefined
    ? explainDefaultFilterSelection(protocol?.studyDesign ?? '').rctSkippedReason : null;
  if (draft.filterSelectionSource === 'ai') {
    const notice = doc.createElement('p');
    notice.className = 'blocks__field-hint';
    notice.textContent = t('blocks.aiFilters');
    section.appendChild(notice);
  }
  if (reason) {
    const notice = doc.createElement('p');
    notice.className = 'blocks__field-hint';
    notice.textContent = getUiLanguage() === 'en'
      ? t('blocks.rctSkipped', { terms: (reason.match(/（(.*?)）/)?.[1] ?? '').split('、').join(', ') })
      : reason;
    section.appendChild(notice);
  }

  const list = doc.createElement('ul');
  list.className = 'blocks__filter-list';
  list.setAttribute('aria-label', t('blocks.availableFilters'));

  for (const def of PREDEFINED_FILTER_DEFS) {
    const li = doc.createElement('li');
    li.className = 'blocks__filter-item';

    const labelEl = doc.createElement('label');
    labelEl.className = 'blocks__filter-item-label';

    const checkbox = doc.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'blocks__filter-item-checkbox';
    checkbox.checked = selectedIds.includes(def.id);
    checkbox.setAttribute('aria-describedby', `filter-desc-${def.id}`);
    checkbox.addEventListener('change', () => {
      mutateDraft(store, (d) => {
        const current =
          d.selectedFilterIds ??
          getDefaultSelectedFilterIds(
            store.getState().protocolDraft?.studyDesign ?? ''
          );
        const next = checkbox.checked
          ? [...current, def.id]
          : current.filter((id) => id !== def.id);
        return { ...d, selectedFilterIds: next };
      });
    });
    labelEl.appendChild(checkbox);

    const nameEl = doc.createElement('span');
    nameEl.className = 'blocks__filter-item-name';
    nameEl.textContent = def.id === 'RCTfilter' ? t('blocks.rctName') :
      def.id === 'SRfilter' ? t('blocks.srName') : def.label;
    labelEl.appendChild(nameEl);

    li.appendChild(labelEl);

    const descEl = doc.createElement('p');
    descEl.className = 'blocks__filter-item-desc';
    descEl.id = `filter-desc-${def.id}`;
    descEl.textContent = def.id === 'RCTfilter' ? t('blocks.rctDescription') :
      def.id === 'SRfilter' ? t('blocks.srDescription') : def.description;
    li.appendChild(descEl);

    list.appendChild(li);
  }

  section.appendChild(list);
  return section;
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

  const summary = doc.createElement('div');
  summary.className = 'blocks__actions-summary';
  summary.textContent = t('blocks.actionSummary', {
    count: draft.blocks.length, max: MAX_BLOCKS,
    status: hasErrors ? t('blocks.errorStatus') : '✓ OK',
  });
  wrap.appendChild(summary);

  const buttons = doc.createElement('div');
  buttons.className = 'blocks__actions-buttons';

  const draftBtn = doc.createElement('button');
  draftBtn.type = 'button';
  draftBtn.className = 'blocks__btn-secondary';
  draftBtn.textContent = t('blocks.save');
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
  buttons.appendChild(draftBtn);

  const approveBtn = doc.createElement('button');
  approveBtn.type = 'button';
  approveBtn.className = 'blocks__btn-primary';
  approveBtn.dataset.tour = 'blocks-approve';
  approveBtn.textContent = t('blocks.approve');
  approveBtn.disabled = hasErrors;
  if (hasErrors) {
    approveBtn.title = t('blocks.fixErrors');
  }
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
  buttons.appendChild(approveBtn);

  wrap.appendChild(buttons);

  if (hasErrors) {
    const reason = doc.createElement('p');
    reason.className = 'blocks__approve-reason';
    reason.textContent = t('blocks.approveReason');
    wrap.appendChild(reason);
  }

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
  btn.className = 'blocks__item-control';
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
