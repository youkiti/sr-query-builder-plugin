import { INITIAL_STATE, type AppState } from '../store';
import { createProtocolView, renderProtocolView } from './protocolView';

function buildContainer(): HTMLElement {
  const doc = document.implementation.createHTMLDocument('test');
  const div = doc.createElement('div');
  doc.body.appendChild(div);
  return div;
}

const stateWithProject: AppState = {
  ...INITIAL_STATE,
  project: { projectId: 'p', spreadsheetId: 's', driveFolderId: 'd', title: 'T' },
};

describe('renderProtocolView (callback 無し)', () => {
  test('プロジェクト未選択時は警告だけ表示する', () => {
    const container = buildContainer();
    renderProtocolView(container, { state: INITIAL_STATE, navigate: jest.fn() });
    expect(container.querySelector('.protocol__warning')?.textContent).toBe(
      '先にプロジェクトを選択してください。'
    );
    expect(container.querySelector('form')).toBeNull();
  });

  test('プロジェクトがあればフォームを描画する', () => {
    const container = buildContainer();
    renderProtocolView(container, { state: stateWithProject, navigate: jest.fn() });
    expect(container.querySelector('form')).not.toBeNull();
    expect(container.querySelectorAll('input[type=radio]')).toHaveLength(3);
    expect(container.querySelectorAll('textarea')).toHaveLength(4);
    expect(container.querySelector('input[type=file]')?.getAttribute('accept')).toBe(
      '.md,.markdown,.docx'
    );
  });

  test('manual ラジオが既定で checked', () => {
    const container = buildContainer();
    renderProtocolView(container, { state: stateWithProject, navigate: jest.fn() });
    const manual = container.querySelector<HTMLInputElement>('input[value=manual]');
    expect(manual?.checked).toBe(true);
  });

  test('submit イベントは preventDefault され、ページ遷移しない', () => {
    const container = buildContainer();
    renderProtocolView(container, { state: stateWithProject, navigate: jest.fn() });
    const form = container.querySelector('form')!;
    const ev = new Event('submit', { cancelable: true });
    form.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  test('再レンダで重複しない', () => {
    const container = buildContainer();
    const ctx = { state: INITIAL_STATE, navigate: jest.fn() };
    renderProtocolView(container, ctx);
    renderProtocolView(container, ctx);
    expect(container.querySelectorAll('h2')).toHaveLength(1);
  });
});

describe('createProtocolView - manual モード', () => {
  test('送信で onSubmit が手入力フィールドつきで呼ばれる', () => {
    const onSubmit = jest.fn();
    const view = createProtocolView({ onSubmit });
    const container = buildContainer();
    view(container, { state: stateWithProject, navigate: jest.fn() });
    setText(container, 'rq', 'My RQ');
    setText(container, 'inclusion', 'inc');
    setText(container, 'exclusion', 'exc');
    setText(container, 'inline', '本文');
    container.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceType: 'manual',
        researchQuestion: 'My RQ',
        inclusionCriteria: 'inc',
        exclusionCriteria: 'exc',
        inlineText: '本文',
      })
    );
    expect(container.querySelector('#protocol-error')?.textContent).toBe('');
  });

  test('callback が無くても例外にならない', () => {
    const view = createProtocolView();
    const container = buildContainer();
    view(container, { state: stateWithProject, navigate: jest.fn() });
    expect(() =>
      container.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }))
    ).not.toThrow();
  });
});

describe('createProtocolView - markdown モード', () => {
  test('ファイル選択ありで MarkdownFileInput を渡し、text() で本文を取得できる', async () => {
    const onSubmit = jest.fn();
    const view = createProtocolView({ onSubmit });
    const container = buildContainer();
    view(container, { state: stateWithProject, navigate: jest.fn() });
    selectSourceType(container, 'markdown');
    attachFile(container, makeFakeFile('protocol.md', '# md'));
    container.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(onSubmit).toHaveBeenCalled();
    const passed = onSubmit.mock.calls[0][0] as {
      markdownFile?: { name: string; text: () => Promise<string> };
    };
    expect(passed.markdownFile?.name).toBe('protocol.md');
    await expect(passed.markdownFile?.text()).resolves.toBe('# md');
  });

  test('ファイル未選択ならエラー表示 + onSubmit 未呼び出し', () => {
    const onSubmit = jest.fn();
    const view = createProtocolView({ onSubmit });
    const container = buildContainer();
    view(container, { state: stateWithProject, navigate: jest.fn() });
    selectSourceType(container, 'markdown');
    container.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(container.querySelector('#protocol-error')?.textContent).toContain('markdown');
  });
});

describe('createProtocolView - docx モード', () => {
  test('ファイル選択ありで DocxFileInput を渡し、arrayBuffer() で取得できる', async () => {
    const onSubmit = jest.fn();
    const view = createProtocolView({ onSubmit });
    const container = buildContainer();
    view(container, { state: stateWithProject, navigate: jest.fn() });
    selectSourceType(container, 'docx');
    const buf = new ArrayBuffer(3);
    attachFile(container, makeFakeFile('p.docx', '', buf));
    container.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(onSubmit).toHaveBeenCalled();
    const passed = onSubmit.mock.calls[0][0] as {
      docxFile?: { name: string; arrayBuffer: () => Promise<ArrayBuffer> };
    };
    expect(passed.docxFile?.name).toBe('p.docx');
    await expect(passed.docxFile?.arrayBuffer()).resolves.toBe(buf);
  });
});

describe('createProtocolView - docx ファイル未選択', () => {
  test('ファイル未選択ならエラー', () => {
    const onSubmit = jest.fn();
    const view = createProtocolView({ onSubmit });
    const container = buildContainer();
    view(container, { state: stateWithProject, navigate: jest.fn() });
    selectSourceType(container, 'docx');
    container.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(container.querySelector('#protocol-error')?.textContent).toContain('.docx');
  });
});

describe('createProtocolView - エラー表示', () => {
  test('onSubmit が同期的に throw した場合もエラーボックスに表示される', () => {
    const onSubmit = jest.fn(() => {
      throw new Error('boom');
    });
    const view = createProtocolView({ onSubmit });
    const container = buildContainer();
    view(container, { state: stateWithProject, navigate: jest.fn() });
    container.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(container.querySelector('#protocol-error')?.textContent).toBe('boom');
  });

  test('Error 以外の例外も String 化される', () => {
    const onSubmit = jest.fn(() => {
      throw 'rare';
    });
    const view = createProtocolView({ onSubmit });
    const container = buildContainer();
    view(container, { state: stateWithProject, navigate: jest.fn() });
    container.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(container.querySelector('#protocol-error')?.textContent).toBe('rare');
  });
});

function setText(container: HTMLElement, id: string, value: string): void {
  const textarea = container.querySelector<HTMLTextAreaElement>(`textarea#${id}`)!;
  textarea.value = value;
}

function selectSourceType(container: HTMLElement, value: 'manual' | 'markdown' | 'docx'): void {
  const radio = container.querySelector<HTMLInputElement>(
    `input[name=sourceType][value=${value}]`
  )!;
  radio.checked = true;
}

function attachFile(container: HTMLElement, file: unknown): void {
  const input = container.querySelector<HTMLInputElement>('input[type=file]')!;
  Object.defineProperty(input, 'files', {
    value: [file],
    configurable: true,
  });
}

/**
 * jsdom の File は text() / arrayBuffer() を実装していないので、
 * 必要メソッドだけ持ったフェイクオブジェクトを使う。
 */
function makeFakeFile(name: string, text: string, buffer: ArrayBuffer = new ArrayBuffer(0)): {
  name: string;
  text: () => Promise<string>;
  arrayBuffer: () => Promise<ArrayBuffer>;
} {
  return {
    name,
    text: async () => text,
    arrayBuffer: async () => buffer,
  };
}
