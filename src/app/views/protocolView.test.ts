import type { Protocol } from '@/domain/protocol';
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

  // §4.2: 手入力かつ空文字でもエラーにせず、空 inlineText で onSubmit を呼ぶ。
  // 後段の extract-protocol skill が空ドラフトを返し、ユーザーはブロックをゼロから編集する。
  test('空入力でサブミットしてもエラーにならず inlineText="" で onSubmit を呼ぶ', () => {
    const onSubmit = jest.fn();
    const view = createProtocolView({ onSubmit });
    const container = buildContainer();
    view(container, { state: stateWithProject, navigate: jest.fn() });
    container.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(onSubmit).toHaveBeenCalledWith({ sourceType: 'manual', inlineText: '' });
    expect(container.querySelector('#protocol-error')?.textContent).toBe('');
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

describe('createProtocolView - 送信中の進捗表示', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('onSubmit 実行中は spinner + 段階ラベル + 経過秒が見える', async () => {
    let resolveSubmit: () => void = () => {
      // placeholder
    };
    const onSubmit = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSubmit = resolve;
        })
    );
    const view = createProtocolView({ onSubmit });
    const container = buildContainer();
    view(container, { state: stateWithProject, navigate: jest.fn() });
    setText(container, 'inline', '本文');

    const progress = container.querySelector<HTMLElement>('#protocol-progress')!;
    expect(progress.hidden).toBe(true);

    container.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(progress.hidden).toBe(false);
    expect(progress.querySelector('.protocol__spinner')).not.toBeNull();
    expect(progress.getAttribute('aria-live')).toBe('polite');
    expect(progress.querySelector('.protocol__progress-stage')?.textContent).toContain('読み取り');
    expect(progress.querySelector('.protocol__progress-elapsed')?.textContent).toBe('0s');

    jest.advanceTimersByTime(4000);
    expect(progress.querySelector('.protocol__progress-stage')?.textContent).toContain('ブロック');
    expect(progress.querySelector('.protocol__progress-elapsed')?.textContent).toBe('4s');

    jest.advanceTimersByTime(12000);
    expect(progress.querySelector('.protocol__progress-stage')?.textContent).toContain('まだ処理中');

    resolveSubmit();
    await Promise.resolve();
    await Promise.resolve();
    expect(progress.hidden).toBe(true);
  });

  test('onSubmit が reject しても進捗表示は隠れる', async () => {
    let rejectSubmit: (err: Error) => void = () => {
      // placeholder
    };
    const onSubmit = jest.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectSubmit = reject;
        })
    );
    const view = createProtocolView({ onSubmit });
    const container = buildContainer();
    view(container, { state: stateWithProject, navigate: jest.fn() });
    setText(container, 'inline', '本文');
    container.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));

    const progress = container.querySelector<HTMLElement>('#protocol-progress')!;
    expect(progress.hidden).toBe(false);

    rejectSubmit(new Error('boom'));
    await Promise.resolve();
    await Promise.resolve();
    expect(progress.hidden).toBe(true);
    expect(container.querySelector('#protocol-error')?.textContent).toBe('boom');
  });

  test('入力バリデーション失敗時は進捗表示を出さない', () => {
    // file モードでファイル未選択にしてバリデーション失敗を起こす
    // （manual の空文字は §4.2 で許容されるため失敗ケースにならない）
    const onSubmit = jest.fn();
    const view = createProtocolView({ onSubmit });
    const container = buildContainer();
    view(container, { state: stateWithProject, navigate: jest.fn() });
    selectSourceMode(container, 'file');
    container.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    const progress = container.querySelector<HTMLElement>('#protocol-progress')!;
    expect(progress.hidden).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
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

// ---------------------------------------------------------------------------
// 再訪・改訂フロー（requirements.md §4.2）
// ---------------------------------------------------------------------------

const PROTOCOL_DRAFT: NonNullable<AppState['protocolDraft']> = {
  frameworkType: 'pico',
  researchQuestion: 'ECMO は死亡率を下げるか',
  inclusionCriteria: '成人 ICU 患者',
  exclusionCriteria: '小児',
  studyDesign: 'RCT',
  sourceType: 'manual',
  sourceFilename: null,
  rawTextRef: null,
  rawTextPreview: 'プレビュー本文',
  rawTextInline: '元のプロトコル本文',
};

const BLOCKS_DRAFT: NonNullable<AppState['blocksDraft']> = {
  blocks: [{ blockLabel: 'Population', description: 'ICU', aiGenerated: true, note: '' }],
  combinationExpression: '#1',
};

const persistedState: AppState = {
  ...stateWithProject,
  protocolDraft: PROTOCOL_DRAFT,
  protocolDraftPersisted: true,
  currentProtocolVersion: 2,
  blocksDraft: BLOCKS_DRAFT,
};

function makeProtocol(version: number, overrides: Partial<Protocol> = {}): Protocol {
  return {
    version,
    frameworkType: 'pico',
    researchQuestion: `RQ v${version}`,
    inclusionCriteria: 'inc',
    exclusionCriteria: 'exc',
    studyDesign: 'RCT',
    blockCount: 1,
    combinationExpression: '#1',
    sourceType: 'manual',
    sourceFilename: null,
    rawTextRef: null,
    rawTextPreview: `preview v${version}`,
    rawTextInline: `inline v${version}`,
    createdAt: `2026-06-0${version}T00:00:00Z`,
    createdBy: 'user@example.com',
    ...overrides,
  };
}

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('createProtocolView - 読み取り専用表示（承認済みプロトコル）', () => {
  test('persisted=true なら読み取り専用表示になり、フォームは出ない', () => {
    const container = buildContainer();
    createProtocolView()(container, { state: persistedState, navigate: jest.fn() });
    expect(container.querySelector('.protocol__readonly')).not.toBeNull();
    expect(container.querySelector('form')).toBeNull();
    expect(container.querySelector('.protocol__version-label')?.textContent).toBe(
      '確定済みプロトコル v2（最新）'
    );
  });

  test('summary に抽出済みフィールドと本文（inline）が表示される', () => {
    const container = buildContainer();
    createProtocolView()(container, { state: persistedState, navigate: jest.fn() });
    const summary = container.querySelector('.protocol__summary')!;
    expect(summary.textContent).toContain('ECMO は死亡率を下げるか');
    expect(summary.textContent).toContain('成人 ICU 患者');
    expect(summary.textContent).toContain('小児');
    expect(summary.textContent).toContain('手入力');
    expect(summary.textContent).toContain('元のプロトコル本文');
  });

  test('空フィールドは — で表示される（createdAt 無しの store draft 由来）', () => {
    const container = buildContainer();
    createProtocolView()(container, { state: persistedState, navigate: jest.fn() });
    const summary = container.querySelector('.protocol__summary')!;
    expect(summary.textContent).toContain('—');
  });

  test('ファイル由来の draft では入力形式にファイル名が併記され、本文はプレビューが出る', () => {
    const state: AppState = {
      ...persistedState,
      protocolDraft: {
        ...PROTOCOL_DRAFT,
        sourceType: 'markdown',
        sourceFilename: 'protocol.md',
        rawTextInline: null,
      },
    };
    const container = buildContainer();
    createProtocolView()(container, { state, navigate: jest.fn() });
    const summary = container.querySelector('.protocol__summary')!;
    expect(summary.textContent).toContain('Markdown ファイル（protocol.md）');
    expect(summary.textContent).toContain('プレビュー本文');
  });

  test('persisted=false で draft があればフォームへ復元し、「未保存」バッジと案内文を出す', () => {
    const state: AppState = {
      ...stateWithProject,
      protocolDraft: PROTOCOL_DRAFT,
      protocolDraftPersisted: false,
    };
    const container = buildContainer();
    createProtocolView()(container, { state, navigate: jest.fn() });
    expect(container.querySelector('.protocol__readonly')).toBeNull();
    expect(container.querySelector<HTMLTextAreaElement>('textarea#inline')?.value).toBe(
      '元のプロトコル本文'
    );
    const badge = container.querySelector('.protocol__draft-status');
    expect(badge?.textContent).toContain('未保存の下書き');
    expect(badge?.textContent).toContain('ブロック承認');
    expect(badge?.getAttribute('role')).toBe('status');
    expect(container.querySelector('.protocol__notice')?.textContent).toContain('ブロック承認');
  });

  test('draft が無ければ従来どおり空フォーム（バッジ・案内文なし）', () => {
    const container = buildContainer();
    createProtocolView()(container, { state: stateWithProject, navigate: jest.fn() });
    expect(container.querySelector<HTMLTextAreaElement>('textarea#inline')?.value).toBe('');
    expect(container.querySelector('.protocol__notice')).toBeNull();
    expect(container.querySelector('.protocol__draft-status')).toBeNull();
  });

  test('読み取り専用表示には「未保存」バッジを出さない', () => {
    const container = buildContainer();
    createProtocolView()(container, { state: persistedState, navigate: jest.fn() });
    expect(container.querySelector('.protocol__draft-status')).toBeNull();
  });

  test('改訂の編集モードには「未保存」バッジを出さない（編集中 notice が役割を担う）', () => {
    const container = buildContainer();
    createProtocolView()(container, { state: persistedState, navigate: jest.fn() });
    container.querySelector<HTMLButtonElement>('.protocol__edit')!.click();
    expect(container.querySelector('.protocol__draft-status')).toBeNull();
    expect(container.querySelector('.protocol__notice')?.textContent).toContain('編集中');
  });

  test('onListVersions 未提供ならバージョン読込ボタンは出ない', () => {
    const container = buildContainer();
    createProtocolView()(container, { state: persistedState, navigate: jest.fn() });
    expect(container.querySelector('.protocol__load-versions')).toBeNull();
  });
});

describe('createProtocolView - 編集モードと「ブロックを作り直すか」確認パネル', () => {
  function renderPersisted(callbacks: Parameters<typeof createProtocolView>[0] = {}): HTMLElement {
    const container = buildContainer();
    createProtocolView(callbacks)(container, { state: persistedState, navigate: jest.fn() });
    return container;
  }

  function enterEdit(container: HTMLElement): void {
    container.querySelector<HTMLButtonElement>('.protocol__edit')!.click();
  }

  function submitForm(container: HTMLElement): void {
    container.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
  }

  test('編集ボタンで本文プリセット済みフォームに切り替わる', () => {
    const container = renderPersisted();
    expect(container.querySelector('.protocol__edit')?.textContent).toBe(
      'このプロトコルを編集する'
    );
    enterEdit(container);
    expect(container.querySelector('.protocol__readonly')).toBeNull();
    expect(container.querySelector<HTMLTextAreaElement>('textarea#inline')?.value).toBe(
      '元のプロトコル本文'
    );
    expect(container.querySelector('.protocol__notice')?.textContent).toContain('v2 を編集中');
    expect(container.querySelector('.protocol__submit')?.textContent).toBe(
      '新しいバージョンとして保存'
    );
  });

  test('「編集をやめる」で読み取り専用表示に戻る', () => {
    const container = renderPersisted();
    enterEdit(container);
    container.querySelector<HTMLButtonElement>('.protocol__cancel')!.click();
    expect(container.querySelector('.protocol__readonly')).not.toBeNull();
    expect(container.querySelector('form')).toBeNull();
  });

  test('改訂の保存ボタンは即送信せず確認パネルを出す', () => {
    const onSubmit = jest.fn();
    const container = renderPersisted({ onSubmit });
    enterEdit(container);
    const panel = container.querySelector<HTMLElement>('.protocol__revise-confirm')!;
    expect(panel.hidden).toBe(true);
    submitForm(container);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(panel.hidden).toBe(false);
    expect(panel.textContent).toContain('検索ブロックを作り直しますか');
    expect(container.querySelector<HTMLButtonElement>('.protocol__submit')?.disabled).toBe(true);
  });

  test('確認パネルのキャンセルでパネルが閉じ、保存ボタンが復活する', () => {
    const container = renderPersisted({ onSubmit: jest.fn() });
    enterEdit(container);
    submitForm(container);
    container.querySelector<HTMLButtonElement>('.protocol__revise-cancel')!.click();
    expect(container.querySelector<HTMLElement>('.protocol__revise-confirm')?.hidden).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('.protocol__submit')?.disabled).toBe(false);
  });

  test('「作り直す」は onSubmit に編集後の入力を渡す', () => {
    const onSubmit = jest.fn();
    const container = renderPersisted({ onSubmit });
    enterEdit(container);
    setText(container, 'inline', '修正後の本文');
    submitForm(container);
    container.querySelector<HTMLButtonElement>('.protocol__revise-rebuild')!.click();
    expect(onSubmit).toHaveBeenCalledWith({ sourceType: 'manual', inlineText: '修正後の本文' });
  });

  test('「既存ブロックを維持」は onReviseKeepBlocks に編集後の入力を渡す', () => {
    const onSubmit = jest.fn();
    const onReviseKeepBlocks = jest.fn();
    const container = renderPersisted({ onSubmit, onReviseKeepBlocks });
    enterEdit(container);
    setText(container, 'inline', '修正後の本文');
    submitForm(container);
    container.querySelector<HTMLButtonElement>('.protocol__revise-keep')!.click();
    expect(onReviseKeepBlocks).toHaveBeenCalledWith({
      sourceType: 'manual',
      inlineText: '修正後の本文',
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test('blocksDraft が無いときは「既存ブロックを維持」を出さない', () => {
    const state: AppState = { ...persistedState, blocksDraft: null };
    const container = buildContainer();
    createProtocolView({ onSubmit: jest.fn(), onReviseKeepBlocks: jest.fn() })(container, {
      state,
      navigate: jest.fn(),
    });
    enterEdit(container);
    submitForm(container);
    expect(container.querySelector('.protocol__revise-keep')).toBeNull();
    expect(container.querySelector('.protocol__revise-rebuild')).not.toBeNull();
  });

  test('onReviseKeepBlocks 未提供なら「既存ブロックを維持」を出さない', () => {
    const container = renderPersisted({ onSubmit: jest.fn() });
    enterEdit(container);
    submitForm(container);
    expect(container.querySelector('.protocol__revise-keep')).toBeNull();
  });

  test('改訂時のバリデーション失敗（file 未選択）ではパネルを出さずエラーを出す', () => {
    const container = renderPersisted({ onSubmit: jest.fn() });
    enterEdit(container);
    selectSourceMode(container, 'file');
    submitForm(container);
    expect(container.querySelector<HTMLElement>('.protocol__revise-confirm')?.hidden).toBe(true);
    expect(container.querySelector('#protocol-error')?.textContent).toContain('ファイル');
  });

  test('ファイル由来（inline 無し）の編集では再入力を促す案内になる', () => {
    const state: AppState = {
      ...persistedState,
      protocolDraft: { ...PROTOCOL_DRAFT, sourceType: 'docx', rawTextInline: null },
    };
    const container = buildContainer();
    createProtocolView()(container, { state, navigate: jest.fn() });
    enterEdit(container);
    expect(container.querySelector('.protocol__notice')?.textContent).toContain('再入力');
    expect(container.querySelector<HTMLTextAreaElement>('textarea#inline')?.value).toBe('');
  });
});

describe('createProtocolView - バージョン切替', () => {
  function renderWithVersions(
    onListVersions: () => Promise<Protocol[]>
  ): HTMLElement {
    const container = buildContainer();
    createProtocolView({ onListVersions })(container, {
      state: persistedState,
      navigate: jest.fn(),
    });
    return container;
  }

  test('読込ボタン → onListVersions の結果で select が出る（version 降順・現在版を選択）', async () => {
    const container = renderWithVersions(async () => [makeProtocol(2), makeProtocol(1)]);
    container.querySelector<HTMLButtonElement>('.protocol__load-versions')!.click();
    await flushPromises();
    const select = container.querySelector<HTMLSelectElement>('#protocol-version-select')!;
    expect(select.options).toHaveLength(2);
    expect(select.options[0]?.textContent).toContain('v2');
    expect(select.value).toBe('2');
    expect(container.querySelector('.protocol__load-versions')).toBeNull();
  });

  test('過去バージョンを選ぶと読み取り専用で表示され、注意書きと編集ボタン文言が変わる', async () => {
    const container = renderWithVersions(async () => [makeProtocol(2), makeProtocol(1)]);
    container.querySelector<HTMLButtonElement>('.protocol__load-versions')!.click();
    await flushPromises();
    const select = container.querySelector<HTMLSelectElement>('#protocol-version-select')!;
    select.value = '1';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(container.querySelector('.protocol__version-label')?.textContent).toBe(
      '確定済みプロトコル v1（過去バージョン）'
    );
    expect(container.querySelector('.protocol__old-note')?.textContent).toContain(
      '最新の次のバージョンとして追記'
    );
    expect(container.querySelector('.protocol__edit')?.textContent).toBe(
      'このバージョンをベースに編集する'
    );
    expect(container.querySelector('.protocol__summary')?.textContent).toContain('RQ v1');
  });

  test('過去バージョンをベースに編集すると、その版の本文がプリセットされる', async () => {
    const container = renderWithVersions(async () => [makeProtocol(2), makeProtocol(1)]);
    container.querySelector<HTMLButtonElement>('.protocol__load-versions')!.click();
    await flushPromises();
    const select = container.querySelector<HTMLSelectElement>('#protocol-version-select')!;
    select.value = '1';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    container.querySelector<HTMLButtonElement>('.protocol__edit')!.click();
    expect(container.querySelector<HTMLTextAreaElement>('textarea#inline')?.value).toBe(
      'inline v1'
    );
    expect(container.querySelector('.protocol__notice')?.textContent).toContain('v1 を編集中');
  });

  test('onListVersions が空配列なら案内文を出す', async () => {
    const container = renderWithVersions(async () => []);
    container.querySelector<HTMLButtonElement>('.protocol__load-versions')!.click();
    await flushPromises();
    expect(container.querySelector('.protocol__versions-empty')?.textContent).toContain(
      'まだありません'
    );
  });

  test('onListVersions が失敗したらエラー表示してボタンを復活させる', async () => {
    const container = renderWithVersions(async () => {
      throw new Error('sheets down');
    });
    const load = container.querySelector<HTMLButtonElement>('.protocol__load-versions')!;
    load.click();
    expect(load.disabled).toBe(true);
    await flushPromises();
    expect(container.querySelector('#protocol-error')?.textContent).toBe('sheets down');
    expect(load.disabled).toBe(false);
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
