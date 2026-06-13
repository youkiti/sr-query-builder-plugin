import { INITIAL_STATE, type AppState, type BlocksDraft, type DraftRunState } from '../store';
import { createDraftView, formatDraftProgress } from './draftView';
import type { DraftProgress } from '@/app/services';

function buildContainer(): HTMLElement {
  const doc = document.implementation.createHTMLDocument('test');
  const div = doc.createElement('div');
  doc.body.appendChild(div);
  return div;
}

function blocksDraft(): BlocksDraft {
  return {
    blocks: [{ blockLabel: 'P', description: 'p', aiGenerated: true, note: '' }],
    combinationExpression: '#1',
  };
}

function stateReady(extra: Partial<AppState> = {}): AppState {
  return {
    ...INITIAL_STATE,
    project: { projectId: 'p', spreadsheetId: 's', driveFolderId: 'd', title: 'T' },
    blocksDraft: blocksDraft(),
    ...extra,
  };
}

function runningState(progressLabel = 'MeSH を提案中（ブロック 1/2）'): DraftRunState {
  return { status: 'running', progressLabel, startedAtMs: Date.now() - 65_000, error: null };
}

describe('createDraftView', () => {
  test('プロジェクト未選択時は警告のみ', () => {
    const view = createDraftView();
    const container = buildContainer();
    view(container, { state: INITIAL_STATE, navigate: jest.fn() });
    expect(container.querySelector('.view__placeholder')?.textContent).toContain('プロジェクト');
    expect(container.querySelector('button')).toBeNull();
  });

  test('blocksDraft 未設定時はブロック承認誘導', () => {
    const view = createDraftView();
    const container = buildContainer();
    view(container, {
      state: { ...INITIAL_STATE, project: stateReady().project },
      navigate: jest.fn(),
    });
    expect(container.querySelector('.view__placeholder')?.textContent).toContain('ブロック');
  });

  test('既存の markdown があればブロック単位で表示し、ボタンは「再生成」', () => {
    const view = createDraftView();
    const container = buildContainer();
    view(container, {
      state: stateReady({
        currentFormulaMarkdown: '## PubMed/MEDLINE\n\n```\n#1 x[Mesh]\n```\n',
        currentFormulaVersionId: 'v-123',
      }),
      navigate: jest.fn(),
    });
    const formula = container.querySelector('.draft__formula');
    expect(formula).not.toBeNull();
    expect(container.querySelector('.draft__block-id')?.textContent).toBe('#1');
    // MeSH 語は専用 span で色分けされる
    expect(container.querySelector('.draft__term--mesh')?.textContent).toBe('x[Mesh]');
    expect(container.querySelector('.draft__info')?.textContent).toContain('v-123');
    expect(container.querySelector('button')?.textContent).toBe('再生成する');
  });

  test('結合行は combination スタイルで描画される', () => {
    const view = createDraftView();
    const container = buildContainer();
    view(container, {
      state: stateReady({
        currentFormulaMarkdown:
          '## PubMed/MEDLINE\n\n```\n#1 a[Mesh] OR "b"[tiab]\n#2 c[Mesh]\n#3 #1 AND #2\n```\n',
      }),
      navigate: jest.fn(),
    });
    const blocks = container.querySelectorAll('.draft__block');
    expect(blocks).toHaveLength(3);
    expect(container.querySelectorAll('.draft__block--combination')).toHaveLength(1);
    // フリーワード語も色分けされる
    expect(container.querySelector('.draft__term--freeword')?.textContent).toBe('"b"[tiab]');
  });

  test('パース不能な markdown は生テキストの pre にフォールバック', () => {
    const view = createDraftView();
    const container = buildContainer();
    view(container, {
      state: stateReady({ currentFormulaMarkdown: 'これは検索式ではない' }),
      navigate: jest.fn(),
    });
    expect(container.querySelector('pre.draft__formula--raw')?.textContent).toContain(
      'これは検索式ではない'
    );
  });

  test('markdown が無ければボタンは「生成する」', () => {
    const view = createDraftView();
    const container = buildContainer();
    view(container, { state: stateReady(), navigate: jest.fn() });
    expect(container.querySelector('button')?.textContent).toBe('生成する');
    expect(container.querySelector('.draft__formula')).toBeNull();
  });

  test('現在 version が null のときは "(未保存)" を表示', () => {
    const view = createDraftView();
    const container = buildContainer();
    view(container, {
      state: stateReady({ currentFormulaMarkdown: '## PubMed\n\n```\n#1 x\n```' }),
      navigate: jest.fn(),
    });
    expect(container.querySelector('.draft__info')?.textContent).toContain('(未保存)');
  });

  test('生成クリックで onGenerate が呼ばれる', () => {
    const onGenerate = jest.fn().mockResolvedValue(undefined);
    const view = createDraftView({ onGenerate });
    const container = buildContainer();
    view(container, { state: stateReady(), navigate: jest.fn() });
    container.querySelector('button')!.click();
    expect(onGenerate).toHaveBeenCalledTimes(1);
  });

  test('クリック直後はボタンがローカルに無効化される（再描画前の二重クリック保険）', () => {
    const onGenerate = jest.fn().mockResolvedValue(undefined);
    const view = createDraftView({ onGenerate });
    const container = buildContainer();
    view(container, { state: stateReady(), navigate: jest.fn() });
    const btn = container.querySelector('button') as HTMLButtonElement;
    btn.click();
    expect(btn.disabled).toBe(true);
    btn.click();
    expect(onGenerate).toHaveBeenCalledTimes(1);
  });

  test('draftRun=running 中はボタンが無効で「生成中…」表記、進捗と経過時間を表示', () => {
    const view = createDraftView({ onGenerate: jest.fn() });
    const container = buildContainer();
    view(container, { state: stateReady({ draftRun: runningState() }), navigate: jest.fn() });
    const btn = container.querySelector('button') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toBe('生成中…');
    const statusText = container.querySelector('.draft__status')?.textContent ?? '';
    expect(statusText).toContain('MeSH を提案中（ブロック 1/2）');
    expect(statusText).toMatch(/経過 1分\d+秒/);
  });

  test('running 中はクリックしても onGenerate を呼ばない', () => {
    const onGenerate = jest.fn();
    const view = createDraftView({ onGenerate });
    const container = buildContainer();
    view(container, { state: stateReady({ draftRun: runningState() }), navigate: jest.fn() });
    container.querySelector('button')!.click();
    expect(onGenerate).not.toHaveBeenCalled();
  });

  test('経過 60 秒未満は「N秒」表記', () => {
    const view = createDraftView();
    const container = buildContainer();
    view(container, {
      state: stateReady({
        draftRun: { status: 'running', progressLabel: '開始します…', startedAtMs: Date.now() - 5_000, error: null },
      }),
      navigate: jest.fn(),
    });
    expect(container.querySelector('.draft__status')?.textContent).toMatch(/経過 \d秒/);
  });

  test('draftRun=error はエラーボックスに表示し、ボタンは再度押せる', () => {
    const onGenerate = jest.fn().mockResolvedValue(undefined);
    const view = createDraftView({ onGenerate });
    const container = buildContainer();
    view(container, {
      state: stateReady({
        draftRun: {
          status: 'error',
          progressLabel: '',
          startedAtMs: Date.now(),
          error: 'Gemini API failed: HTTP 503',
        },
      }),
      navigate: jest.fn(),
    });
    const errorText = container.querySelector('.draft__error')?.textContent ?? '';
    expect(errorText).toContain('生成に失敗しました');
    expect(errorText).toContain('HTTP 503');
    const btn = container.querySelector('button') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    btn.click();
    expect(onGenerate).toHaveBeenCalledTimes(1);
  });

  test('draftRun=error で error が null でも文言を出す', () => {
    const view = createDraftView();
    const container = buildContainer();
    view(container, {
      state: stateReady({
        draftRun: { status: 'error', progressLabel: '', startedAtMs: Date.now(), error: null },
      }),
      navigate: jest.fn(),
    });
    expect(container.querySelector('.draft__error')?.textContent).toContain('不明なエラー');
  });

  test('onGenerate 未指定でもクリックで例外にならない', () => {
    const view = createDraftView();
    const container = buildContainer();
    view(container, { state: stateReady(), navigate: jest.fn() });
    expect(() => container.querySelector('button')!.click()).not.toThrow();
  });
});

describe('formatDraftProgress', () => {
  test('blockIndex 付きステップは「ブロック N/M」カウンタを出す', () => {
    expect(
      formatDraftProgress({ step: 'mesh-suggester', blockIndex: 0, blockCount: 3 })
    ).toContain('1/3');
  });

  test('blockIndex 無しステップはカウンタを出さない', () => {
    expect(formatDraftProgress({ step: 'filter-designer', blockCount: 2 })).not.toContain('/');
  });

  test('全ステップにラベルがある', () => {
    const steps: DraftProgress['step'][] = [
      'block-designer',
      'mesh-suggester',
      'freeword-designer',
      'filter-designer',
      'assemble',
      'save',
      'done',
    ];
    for (const step of steps) {
      expect(formatDraftProgress({ step, blockCount: 1 })).toBeTruthy();
    }
  });
});
