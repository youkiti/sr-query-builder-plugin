import {
  formatCombinationError,
  normalizeCombinationExpression,
  validateCombinationExpression,
} from '@/lib/combination-expression';
import {
  PREDEFINED_FILTER_DEFS,
  getDefaultSelectedFilterIds,
  buildFiltersFromSelection,
} from '@/features/formula/skills';
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
      warn.textContent = '先にプロジェクトを選択してください。';
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
  const studyDesign = store.getState().protocolDraft?.studyDesign ?? '';
  const initial: BlocksDraft = {
    blocks: [emptyBlock()],
    combinationExpression: defaultCombination(1),
    selectedFilterIds: getDefaultSelectedFilterIds(studyDesign),
  };
  store.setState((s) => ({ ...s, blocksDraft: initial }));
  return initial;
}

function buildLede(doc: Document): HTMLElement {
  const p = doc.createElement('p');
  p.className = 'blocks__lede';
  p.textContent =
    'プロトコルから抽出された検索ブロック（PICO などの概念グループ）を確認してください。内容を承認するとシード論文の登録へ進み、その後 AI が PubMed 検索式のドラフトを生成します。';
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
  notice.textContent = `未承認の下書きがあります（保存: ${savedLabel}）。「承認してシード論文へ」を押すまで Sheets には反映されません。`;
  return notice;
}

function buildStepper(doc: Document): HTMLElement {
  const ol = doc.createElement('ol');
  ol.className = 'blocks__stepper';
  ol.setAttribute('aria-label', '画面内の作業ステップ');
  const steps: Array<{ num: string; title: string; desc: string }> = [
    { num: '1', title: 'ブロックを確認・編集', desc: '名称と説明を見直す' },
    { num: '2', title: '結合式を確認', desc: 'AND / OR の組み合わせ' },
    { num: '3', title: '承認して次へ', desc: 'シード論文の登録へ進む' },
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
  // overflow-y: auto のスクロール領域はキーボードで到達できる必要がある（axe: scrollable-region-focusable）
  body.tabIndex = 0;
  body.setAttribute('role', 'region');
  body.setAttribute('aria-label', 'プロトコル参照');

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

function buildBlocksSection(doc: Document, draft: BlocksDraft, store: AppStore): HTMLElement {
  const section = doc.createElement('section');
  section.className = 'blocks__section';
  section.setAttribute('aria-labelledby', 'blocks-section-heading');

  const header = doc.createElement('div');
  header.className = 'blocks__section-header';

  const h3 = doc.createElement('h3');
  h3.id = 'blocks-section-heading';
  h3.className = 'blocks__section-title';
  h3.textContent = '① ブロック一覧';
  header.appendChild(h3);

  const summary = doc.createElement('span');
  summary.className = 'blocks__summary';
  summary.textContent = `${draft.blocks.length} / ${MAX_BLOCKS} ブロック`;
  header.appendChild(summary);

  section.appendChild(header);

  const hint = doc.createElement('p');
  hint.className = 'blocks__section-hint';
  hint.textContent =
    '各ブロックの「ブロック名」と「説明」を確認・修正してください。説明が具体的なほど AI が良い検索語を提案できます。';
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
  badge.textContent = block.aiGenerated ? '🤖 AI 生成' : '✏️ ユーザー編集';
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
      '削除',
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
      title: 'ブロック名',
      hint: '例: Population / Intervention / Outcome',
      value: block.blockLabel,
      placeholder: '例: Population',
      kind: 'input',
      inputClass: 'blocks__label-input',
      ariaLabel: `ブロック ${index + 1} のラベル`,
      onInput: (v) => mutateDraft(store, (d) => updateBlock(d, index, { blockLabel: v })),
    })
  );

  body.appendChild(
    buildLabeledInput(doc, {
      className: 'blocks__field blocks__field--note',
      title: 'メモ',
      hint: '任意。検索式には使われません',
      value: block.note,
      placeholder: '例: 高齢の定義は 65 歳で固定',
      kind: 'textarea',
      inputClass: 'blocks__note',
      ariaLabel: `ブロック ${index + 1} のノート`,
      onInput: (v) => mutateDraft(store, (d) => updateBlock(d, index, { note: v })),
    })
  );

  body.appendChild(
    buildLabeledInput(doc, {
      className: 'blocks__field blocks__field--desc',
      title: '説明',
      hint: 'このブロックで拾いたい概念を 1〜3 文で',
      value: block.description,
      placeholder: '例: 65 歳以上の慢性心不全患者。NYHA II〜IV。',
      kind: 'textarea',
      inputClass: 'blocks__desc',
      ariaLabel: `ブロック ${index + 1} の説明`,
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
  addBtn.textContent = '＋ ブロックを追加';
  addBtn.disabled = draft.blocks.length >= MAX_BLOCKS;
  addBtn.addEventListener('click', () => mutateDraft(store, addBlock));
  wrap.appendChild(addBtn);

  if (draft.blocks.length >= MAX_BLOCKS) {
    const note = doc.createElement('span');
    note.className = 'blocks__add-row-note';
    note.textContent = `ブロックは最大 ${MAX_BLOCKS} 個までです`;
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
  legend.textContent = '② 結合式 (combination_expression)';
  fieldset.appendChild(legend);

  const hint = doc.createElement('p');
  hint.className = 'blocks__section-hint';
  hint.textContent =
    'ブロック同士をどう組み合わせて検索するかを決めます。通常はすべて AND で問題ありません。';
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
  previewLabel.textContent = '最終プレビュー:';
  const previewCode = doc.createElement('code');
  previewCode.textContent = finalExpr || '(空)';
  preview.appendChild(previewLabel);
  preview.appendChild(previewCode);
  fieldset.appendChild(preview);

  const inputWrap = doc.createElement('label');
  inputWrap.className = 'blocks__combination-edit';
  const inputTitle = doc.createElement('span');
  inputTitle.className = 'blocks__field-title';
  inputTitle.textContent = '結合式を編集';
  inputWrap.appendChild(inputTitle);
  const inputHint = doc.createElement('span');
  inputHint.className = 'blocks__field-hint';
  inputHint.textContent = '例: #1 AND #2 ・ (#1 OR #2) AND #3 ・ 使える記号: AND / OR / NOT / ( )';
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
      ? '✓ 構文 OK'
      : `⚠ ${validation.errors.length} 件のエラーがあります`;
  fieldset.appendChild(status);

  const errorList = doc.createElement('ul');
  errorList.className = 'blocks__combination-errors';
  for (const err of validation.errors) {
    const li = doc.createElement('li');
    li.textContent = formatCombinationError(err);
    errorList.appendChild(li);
  }
  fieldset.appendChild(errorList);

  const actions = doc.createElement('div');
  actions.className = 'blocks__combination-actions';
  const resetBtn = doc.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'blocks__btn-secondary';
  resetBtn.textContent = '全 AND に戻す';
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

  const header = doc.createElement('div');
  header.className = 'blocks__filter-selector-header';

  const title = doc.createElement('span');
  title.className = 'blocks__field-title';
  title.textContent = '検索フィルター';
  header.appendChild(title);

  const hint = doc.createElement('span');
  hint.className = 'blocks__field-hint';
  hint.textContent =
    '検索式生成後に AND で結合されるフィルターを選択してください。';
  header.appendChild(hint);

  section.appendChild(header);

  const list = doc.createElement('ul');
  list.className = 'blocks__filter-list';
  list.setAttribute('aria-label', '利用可能な検索フィルター');

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
    nameEl.textContent = def.label;
    labelEl.appendChild(nameEl);

    li.appendChild(labelEl);

    const descEl = doc.createElement('p');
    descEl.className = 'blocks__filter-item-desc';
    descEl.id = `filter-desc-${def.id}`;
    descEl.textContent = def.description;
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
  summary.textContent = `ブロック数: ${draft.blocks.length} / ${MAX_BLOCKS} ・ 結合式: ${
    hasErrors ? '⚠ エラー有り' : '✓ OK'
  }`;
  wrap.appendChild(summary);

  const buttons = doc.createElement('div');
  buttons.className = 'blocks__actions-buttons';

  const draftBtn = doc.createElement('button');
  draftBtn.type = 'button';
  draftBtn.className = 'blocks__btn-secondary';
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
  buttons.appendChild(draftBtn);

  const approveBtn = doc.createElement('button');
  approveBtn.type = 'button';
  approveBtn.className = 'blocks__btn-primary';
  approveBtn.textContent = '承認してシード論文へ →';
  approveBtn.disabled = hasErrors;
  if (hasErrors) {
    approveBtn.title = '結合式のエラーを解消してください';
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
    reason.textContent = '⚠ 結合式のエラーを解消すると承認できます';
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
