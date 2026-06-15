/**
 * 編集画面（#/edit）の「ブロック式そのものを編集面にする」インタラクティブ描画。
 *
 * ブロック式を operand 単位のチップに割り、フリーワードは ✕ で削除・クリックで語をその場編集、
 * MeSH は ✕ で削除しつつ語は MeSH ブラウザへのリンクのまま（descriptor の整合は
 * インスペクタの MeSH ツリー側で担保するため、ここでは自由入力させない）。末尾に「＋ 語を追加」。
 *
 * 演算子・括弧（glue）は地のテキストとして描き、見た目は読み取り表示（renderExpressionInto）と
 * 揃える。各操作は handlers 経由でブロック式の差し替えに流し、コミット後は呼び出し側が
 * ブロック一覧ごと再描画する前提（このモジュールは 1 回の描画ぶんだけを組む）。
 */

import { MESH_BROWSER_BASE, tokenizeOperands } from './formulaDisplay';
import { listOperands, type OperandInfo } from './operandEdit';

export interface EditableBlockHandlers {
  /** index 位置の句を削除する */
  onRemove: (index: number) => void;
  /** index 位置の句の語を newTerm へ差し替える（タグは保持） */
  onEditTerm: (index: number, newTerm: string) => void;
  /** フリーワード（tiab）を末尾に追加する */
  onAddFreeword: (term: string) => void;
}

/**
 * expr を編集可能なチップ列として parent に描画する。
 * 連結したテキスト内容は元式と概ね一致する（チップは term+tag を表示）ので、
 * textContent ベースの確認も大きくは崩れない。
 */
export function renderEditableBlockInto(
  parent: HTMLElement,
  expr: string,
  handlers: EditableBlockHandlers
): void {
  const doc = parent.ownerDocument;
  parent.classList.add('edit__block-chips');

  // operand の index → 情報。glue 描画のために tokenizeOperands を直接走査する。
  const infoByIndex = new Map<number, OperandInfo>();
  for (const info of listOperands(expr)) {
    infoByIndex.set(info.index, info);
  }

  tokenizeOperands(expr).forEach((token, index) => {
    if (!token.isOperand) {
      // 演算子・括弧は地のテキスト（読み取り表示と同じ見た目）。
      parent.appendChild(doc.createTextNode(token.text));
      return;
    }
    const info = infoByIndex.get(index);
    if (info) {
      parent.appendChild(buildChip(doc, info, handlers));
    }
  });

  parent.appendChild(buildAddControl(doc, handlers));
}

/** 1 operand のチップ（語 + ✕ 削除）。 */
function buildChip(
  doc: Document,
  info: OperandInfo,
  handlers: EditableBlockHandlers
): HTMLElement {
  const chip = doc.createElement('span');
  chip.className = `edit__chip edit__chip--${info.kind} draft__term draft__term--${info.kind === 'other' ? 'plain' : info.kind}`;
  chip.setAttribute('data-operand-index', String(info.index));

  if (info.kind === 'mesh') {
    // MeSH は語を MeSH ブラウザへのリンクのまま（自由入力はさせない）。
    const link = doc.createElement('a');
    link.className = 'edit__chip-term edit__chip-term--mesh';
    link.href = `${MESH_BROWSER_BASE}${encodeURIComponent(info.term)}`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.title = 'MeSH ブラウザで開く（語の付け替えはインスペクタの MeSH ツリーから）';
    link.textContent = info.text;
    chip.appendChild(link);
  } else if (info.kind === 'freeword') {
    // フリーワードはクリックで語をその場編集（タグは保持）。
    const termBtn = doc.createElement('button');
    termBtn.type = 'button';
    termBtn.className = 'edit__chip-term edit__chip-term--editable';
    termBtn.textContent = info.text;
    termBtn.title = 'クリックで語を編集';
    termBtn.addEventListener('click', () => beginInlineEdit(doc, chip, termBtn, info, handlers));
    chip.appendChild(termBtn);
  } else {
    // 複合句（ネスト群）は安全のため自由入力させず、削除のみ可能にする（語は静的表示）。
    const span = doc.createElement('span');
    span.className = 'edit__chip-term edit__chip-term--static';
    span.textContent = info.text;
    span.title = 'まとまった句です。語の編集は「詳細編集（生テキスト）」から行えます';
    chip.appendChild(span);
  }

  const remove = doc.createElement('button');
  remove.type = 'button';
  remove.className = 'edit__chip-remove';
  remove.textContent = '×';
  remove.setAttribute('aria-label', `「${info.term}」を削除`);
  remove.title = 'この語を削除';
  remove.addEventListener('click', () => handlers.onRemove(info.index));
  chip.appendChild(remove);

  return chip;
}

/** フリーワードチップを、語だけを編集する <input> に差し替える（Enter/blur で確定、Esc で取消）。 */
function beginInlineEdit(
  doc: Document,
  chip: HTMLElement,
  termBtn: HTMLButtonElement,
  info: OperandInfo,
  handlers: EditableBlockHandlers
): void {
  const input = doc.createElement('input');
  input.type = 'text';
  input.className = 'edit__chip-input';
  input.value = info.term;
  input.setAttribute('aria-label', `「${info.term}」を編集`);

  let done = false;
  const commit = (): void => {
    if (done) {
      return;
    }
    done = true;
    const next = input.value.trim();
    // 変化が無ければ何もしない（再描画も走らせない）。
    if (next === info.term.trim()) {
      input.replaceWith(termBtn);
      return;
    }
    handlers.onEditTerm(info.index, next);
  };
  const cancel = (): void => {
    if (done) {
      return;
    }
    done = true;
    input.replaceWith(termBtn);
  };

  input.addEventListener('keydown', (ev: KeyboardEvent) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      commit();
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      cancel();
    }
  });
  input.addEventListener('blur', () => commit());

  termBtn.replaceWith(input);
  input.focus();
  input.select();
}

/** 末尾の「＋ 語を追加」。クリックで <input> を出し、Enter/blur で tiab 句を追加する。 */
function buildAddControl(doc: Document, handlers: EditableBlockHandlers): HTMLElement {
  const wrap = doc.createElement('span');
  wrap.className = 'edit__chip-add';

  const btn = doc.createElement('button');
  btn.type = 'button';
  btn.className = 'edit__chip-add-btn';
  btn.textContent = '＋ 語を追加';
  btn.title = 'フリーワード（tiab）を OR で追加';
  wrap.appendChild(btn);

  btn.addEventListener('click', () => {
    const input = doc.createElement('input');
    input.type = 'text';
    input.className = 'edit__chip-add-input';
    input.placeholder = '例: asthma*';
    input.setAttribute('aria-label', 'フリーワードを追加');

    let done = false;
    const commit = (): void => {
      if (done) {
        return;
      }
      done = true;
      const term = input.value.trim();
      if (term === '') {
        input.replaceWith(btn);
        return;
      }
      handlers.onAddFreeword(term);
    };
    const cancel = (): void => {
      if (done) {
        return;
      }
      done = true;
      input.replaceWith(btn);
    };
    input.addEventListener('keydown', (ev: KeyboardEvent) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        commit();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        cancel();
      }
    });
    input.addEventListener('blur', () => commit());

    btn.replaceWith(input);
    input.focus();
  });

  return wrap;
}
