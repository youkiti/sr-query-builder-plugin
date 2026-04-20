import type { SaveEditedFormulaInput, SaveEditedFormulaResult } from '@/app/services';
import { ROUTE_LABELS } from '../router';
import type { RenderView } from './types';

/**
 * 検索式手編集画面（#/edit）。
 *
 * - 現在の currentFormulaMarkdown をテキストエリアに読み込み、ユーザーが自由に書き換え
 * - 「新バージョンとして保存」で editService.saveEditedFormula を呼び出し
 * - 保存が成功したら store が自動で currentFormulaVersionId / Markdown を差し替える
 *
 * 実ロジック（onSave）は bootstrap で editService をラップして渡す。
 */

export interface EditViewCallbacks {
  onSave?: (input: SaveEditedFormulaInput) => Promise<SaveEditedFormulaResult>;
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

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
