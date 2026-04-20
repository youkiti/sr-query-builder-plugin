import { INITIAL_STATE, type AppState } from '../store';
import { createEditView } from './editView';

function buildContainer(): HTMLElement {
  const doc = document.implementation.createHTMLDocument('test');
  const div = doc.createElement('div');
  doc.body.appendChild(div);
  return div;
}

const stateReady: AppState = {
  ...INITIAL_STATE,
  project: { projectId: 'p', spreadsheetId: 's', driveFolderId: 'd', title: 'T' },
  currentFormulaVersionId: 'v1',
  currentFormulaMarkdown: '## PubMed/MEDLINE\n\n```\n#1 x\n```\n',
};

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('createEditView', () => {
  test('プロジェクト未選択時は警告のみ', () => {
    const view = createEditView();
    const container = buildContainer();
    view(container, { state: INITIAL_STATE, navigate: jest.fn() });
    expect(container.querySelector('.view__placeholder')?.textContent).toContain('プロジェクト');
    expect(container.querySelector('.edit__formula')).toBeNull();
  });

  test('検索式未読込時は /draft 誘導', () => {
    const view = createEditView();
    const container = buildContainer();
    view(container, {
      state: { ...stateReady, currentFormulaMarkdown: null },
      navigate: jest.fn(),
    });
    expect(container.querySelector('.view__placeholder')?.textContent).toContain('/draft');
    expect(container.querySelector('.edit__formula')).toBeNull();
  });

  test('現在の markdown を textarea に読み込む', () => {
    const view = createEditView();
    const container = buildContainer();
    view(container, { state: stateReady, navigate: jest.fn() });
    const textarea = container.querySelector<HTMLTextAreaElement>('.edit__formula');
    expect(textarea?.value).toContain('#1 x');
  });

  test('保存ボタン押下で onSave が呼ばれ、status を更新', async () => {
    const onSave = jest
      .fn()
      .mockResolvedValue({ versionId: 'new-id', parentVersionId: 'v1' });
    const view = createEditView({ onSave });
    const container = buildContainer();
    view(container, { state: stateReady, navigate: jest.fn() });
    const textarea = container.querySelector<HTMLTextAreaElement>('.edit__formula')!;
    textarea.value = '## PubMed/MEDLINE\n\n```\n#1 new\n```\n';
    const noteInput = container.querySelector<HTMLInputElement>('.edit__note-input')!;
    noteInput.value = 'メモ';
    const saveBtn = container.querySelector<HTMLButtonElement>('.edit__actions button')!;
    saveBtn.click();
    await flushAsync();
    await flushAsync();
    expect(onSave).toHaveBeenCalledWith({
      formulaMd: '## PubMed/MEDLINE\n\n```\n#1 new\n```\n',
      note: 'メモ',
    });
    expect(container.querySelector('.edit__status')?.textContent).toContain('new-id');
    expect(saveBtn.disabled).toBe(false);
  });

  test('onSave が reject したらエラー表示', async () => {
    const onSave = jest.fn().mockRejectedValue(new Error('boom'));
    const view = createEditView({ onSave });
    const container = buildContainer();
    view(container, { state: stateReady, navigate: jest.fn() });
    const saveBtn = container.querySelector<HTMLButtonElement>('.edit__actions button')!;
    saveBtn.click();
    await flushAsync();
    await flushAsync();
    expect(container.querySelector('.edit__error')?.textContent).toBe('boom');
    expect(container.querySelector('.edit__status')?.textContent).toBe('');
  });

  test('Error 以外も String 化される', async () => {
    const onSave = jest.fn().mockRejectedValue('rare');
    const view = createEditView({ onSave });
    const container = buildContainer();
    view(container, { state: stateReady, navigate: jest.fn() });
    const saveBtn = container.querySelector<HTMLButtonElement>('.edit__actions button')!;
    saveBtn.click();
    await flushAsync();
    await flushAsync();
    expect(container.querySelector('.edit__error')?.textContent).toBe('rare');
  });

  test('onSave 未指定でもクリックで例外にならない', () => {
    const view = createEditView();
    const container = buildContainer();
    view(container, { state: stateReady, navigate: jest.fn() });
    const saveBtn = container.querySelector<HTMLButtonElement>('.edit__actions button')!;
    expect(() => saveBtn.click()).not.toThrow();
  });
});
