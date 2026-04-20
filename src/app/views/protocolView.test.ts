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

  test('プロジェクトがあればフォームを描画し、manual モードでは textarea 1 つだけ', () => {
    const container = buildContainer();
    renderProtocolView(container, { state: stateWithProject, navigate: jest.fn() });
    expect(container.querySelector('form')).not.toBeNull();
    // 入力モードは manual / file の 2 系統
    expect(container.querySelectorAll('input[type=radio]')).toHaveLength(2);
    // manual が既定: プロトコル全文用の textarea#inline だけ
    expect(container.querySelectorAll('textarea')).toHaveLength(1);
    expect(container.querySelector('textarea#inline')).not.toBeNull();
    // manual モードではファイル入力 fieldset は非表示
    const fileSection = container.querySelector('fieldset + fieldset + fieldset');
    expect(fileSection?.hasAttribute('hidden')).toBe(true);
  });

  test('manual ラジオが既定で checked', () => {
    const container = buildContainer();
    renderProtocolView(container, { state: stateWithProject, navigate: jest.fn() });
    const manual = container.querySelector<HTMLInputElement>('input[value=manual]');
    expect(manual?.checked).toBe(true);
  });

  test('file モードではファイル input が表示され、accept は .md/.markdown/.docx', () => {
    const container = buildContainer();
    renderProtocolView(container, { state: stateWithProject, navigate: jest.fn() });
    selectSourceMode(container, 'file');
    const fileInput = container.querySelector<HTMLInputElement>('input[type=file]')!;
    expect(fileInput.accept).toBe('.md,.markdown,.docx');
    const fileSection = container.querySelector('fieldset + fieldset + fieldset');
    expect(fileSection?.hasAttribute('hidden')).toBe(false);
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
  test('プロトコル全文のみを inlineText として送信する', () => {
    const onSubmit = jest.fn();
    const view = createProtocolView({ onSubmit });
    const container = buildContainer();
    view(container, { state: stateWithProject, navigate: jest.fn() });
    setText(container, 'inline', 'プロトコル全文の本文');
    container.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(onSubmit).toHaveBeenCalledWith({
      sourceType: 'manual',
      inlineText: 'プロトコル全文の本文',
    });
    expect(container.querySelector('#protocol-error')?.textContent).toBe('');
  });

  test('空入力でサブミットするとエラー + onSubmit 未呼び出し', () => {
    const onSubmit = jest.fn();
    const view = createProtocolView({ onSubmit });
    const container = buildContainer();
    view(container, { state: stateWithProject, navigate: jest.fn() });
    container.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(container.querySelector('#protocol-error')?.textContent).toContain('プロトコル');
  });

  test('callback が無くても例外にならない', () => {
    const view = createProtocolView();
    const container = buildContainer();
    view(container, { state: stateWithProject, navigate: jest.fn() });
    setText(container, 'inline', '本文');
    expect(() =>
      container.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }))
    ).not.toThrow();
  });
});

describe('createProtocolView - file モード（拡張子で判定）', () => {
  test('.md を選ぶと sourceType=markdown で markdownFile を渡す', async () => {
    const onSubmit = jest.fn();
    const view = createProtocolView({ onSubmit });
    const container = buildContainer();
    view(container, { state: stateWithProject, navigate: jest.fn() });
    selectSourceMode(container, 'file');
    attachFile(container, makeFakeFile('protocol.md', '# md'));
    container.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(onSubmit).toHaveBeenCalled();
    const passed = onSubmit.mock.calls[0][0] as {
      sourceType: string;
      markdownFile?: { name: string; text: () => Promise<string> };
    };
    expect(passed.sourceType).toBe('markdown');
    expect(passed.markdownFile?.name).toBe('protocol.md');
    await expect(passed.markdownFile?.text()).resolves.toBe('# md');
  });

  test('.markdown 拡張子も markdown と判定される', () => {
    const onSubmit = jest.fn();
    const view = createProtocolView({ onSubmit });
    const container = buildContainer();
    view(container, { state: stateWithProject, navigate: jest.fn() });
    selectSourceMode(container, 'file');
    attachFile(container, makeFakeFile('p.markdown', '# md'));
    container.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    expect((onSubmit.mock.calls[0][0] as { sourceType: string }).sourceType).toBe('markdown');
  });

  test('.docx を選ぶと sourceType=docx で docxFile を渡す', async () => {
    const onSubmit = jest.fn();
    const view = createProtocolView({ onSubmit });
    const container = buildContainer();
    view(container, { state: stateWithProject, navigate: jest.fn() });
    selectSourceMode(container, 'file');
    const buf = new ArrayBuffer(3);
    attachFile(container, makeFakeFile('p.docx', '', buf));
    container.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(onSubmit).toHaveBeenCalled();
    const passed = onSubmit.mock.calls[0][0] as {
      sourceType: string;
      docxFile?: { name: string; arrayBuffer: () => Promise<ArrayBuffer> };
    };
    expect(passed.sourceType).toBe('docx');
    expect(passed.docxFile?.name).toBe('p.docx');
    await expect(passed.docxFile?.arrayBuffer()).resolves.toBe(buf);
  });

  test('大文字拡張子（.DOCX）も許容される', () => {
    const onSubmit = jest.fn();
    const view = createProtocolView({ onSubmit });
    const container = buildContainer();
    view(container, { state: stateWithProject, navigate: jest.fn() });
    selectSourceMode(container, 'file');
    attachFile(container, makeFakeFile('P.DOCX', '', new ArrayBuffer(0)));
    container.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    expect((onSubmit.mock.calls[0][0] as { sourceType: string }).sourceType).toBe('docx');
  });

  test('ファイル未選択ならエラー表示 + onSubmit 未呼び出し', () => {
    const onSubmit = jest.fn();
    const view = createProtocolView({ onSubmit });
    const container = buildContainer();
    view(container, { state: stateWithProject, navigate: jest.fn() });
    selectSourceMode(container, 'file');
    container.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(container.querySelector('#protocol-error')?.textContent).toContain('ファイル');
  });

  test('未対応拡張子はエラー表示 + onSubmit 未呼び出し', () => {
    const onSubmit = jest.fn();
    const view = createProtocolView({ onSubmit });
    const container = buildContainer();
    view(container, { state: stateWithProject, navigate: jest.fn() });
    selectSourceMode(container, 'file');
    attachFile(container, makeFakeFile('protocol.txt', 'plain'));
    container.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(container.querySelector('#protocol-error')?.textContent).toContain('.md');
  });
});

describe('createProtocolView - エラー表示', () => {
  async function flushAsync(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  test('onSubmit が同期的に throw した場合もエラーボックスに表示される', () => {
    const onSubmit = jest.fn(() => {
      throw new Error('boom');
    });
    const view = createProtocolView({ onSubmit });
    const container = buildContainer();
    view(container, { state: stateWithProject, navigate: jest.fn() });
    setText(container, 'inline', '本文');
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
    setText(container, 'inline', '本文');
    container.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(container.querySelector('#protocol-error')?.textContent).toBe('rare');
  });

  test('onSubmit が非同期に reject した場合もエラーボックスに表示される', async () => {
    const onSubmit = jest.fn().mockRejectedValue(new Error('async boom'));
    const view = createProtocolView({ onSubmit });
    const container = buildContainer();
    view(container, { state: stateWithProject, navigate: jest.fn() });
    setText(container, 'inline', '本文');
    container.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await flushAsync();
    expect(container.querySelector('#protocol-error')?.textContent).toBe('async boom');
  });
});

function setText(container: HTMLElement, id: string, value: string): void {
  const textarea = container.querySelector<HTMLTextAreaElement>(`textarea#${id}`)!;
  textarea.value = value;
}

function selectSourceMode(container: HTMLElement, value: 'manual' | 'file'): void {
  const radio = container.querySelector<HTMLInputElement>(
    `input[name=sourceMode][value=${value}]`
  )!;
  radio.checked = true;
  radio.dispatchEvent(new Event('change', { bubbles: true }));
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
