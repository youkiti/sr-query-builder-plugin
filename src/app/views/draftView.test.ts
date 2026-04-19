import { INITIAL_STATE, type AppState, type BlocksDraft } from '../store';
import { createDraftView } from './draftView';
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

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
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

  test('既存の markdown があれば pre に表示し、ボタンは「再生成」', () => {
    const view = createDraftView();
    const container = buildContainer();
    view(container, {
      state: stateReady({
        currentFormulaMarkdown: '## PubMed/MEDLINE\n\n```\n#1 x\n```\n',
        currentFormulaVersionId: 'v-123',
      }),
      navigate: jest.fn(),
    });
    expect(container.querySelector('pre.draft__formula')?.textContent).toContain('PubMed');
    expect(container.querySelector('.draft__info')?.textContent).toContain('v-123');
    expect(container.querySelector('button')?.textContent).toBe('再生成する');
  });

  test('markdown が無ければボタンは「生成する」', () => {
    const view = createDraftView();
    const container = buildContainer();
    view(container, { state: stateReady(), navigate: jest.fn() });
    expect(container.querySelector('button')?.textContent).toBe('生成する');
    expect(container.querySelector('pre.draft__formula')).toBeNull();
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

  test('生成クリックで onGenerate が呼ばれ、progress がステータスに出る', async () => {
    const received: DraftProgress[] = [];
    const onGenerate = jest.fn(async (notify: (p: DraftProgress) => void) => {
      notify({ step: 'block-designer', blockIndex: 0, blockCount: 1 });
      notify({ step: 'assemble', blockCount: 1 });
      received.push({ step: 'done', blockCount: 1 });
    });
    const view = createDraftView({ onGenerate });
    const container = buildContainer();
    view(container, { state: stateReady(), navigate: jest.fn() });
    const btn = container.querySelector('button')!;
    btn.click();
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    await flushAsync();
    await flushAsync();
    expect(onGenerate).toHaveBeenCalled();
    expect(container.querySelector('.draft__status')?.textContent).toContain('完了');
    expect((btn as HTMLButtonElement).disabled).toBe(false);
    expect(received).toHaveLength(1); // 副次的な push
  });

  test('progress.blockIndex が未指定のステップではカウンタを出さない', async () => {
    const onGenerate = jest.fn(async (notify: (p: DraftProgress) => void) => {
      notify({ step: 'filter-designer', blockCount: 2 });
    });
    const view = createDraftView({ onGenerate });
    const container = buildContainer();
    view(container, { state: stateReady(), navigate: jest.fn() });
    container.querySelector('button')!.click();
    await flushAsync();
    await flushAsync();
    expect(container.querySelector('.draft__status')?.textContent).not.toContain('/');
  });

  test('onGenerate が throw したらエラーボックスに表示し、ステータスは空になる', async () => {
    const onGenerate = jest.fn().mockRejectedValue(new Error('boom'));
    const view = createDraftView({ onGenerate });
    const container = buildContainer();
    view(container, { state: stateReady(), navigate: jest.fn() });
    container.querySelector('button')!.click();
    await flushAsync();
    await flushAsync();
    expect(container.querySelector('.draft__error')?.textContent).toBe('boom');
    expect(container.querySelector('.draft__status')?.textContent).toBe('');
  });

  test('Error 以外の例外も String 化', async () => {
    const onGenerate = jest.fn().mockRejectedValue('rare');
    const view = createDraftView({ onGenerate });
    const container = buildContainer();
    view(container, { state: stateReady(), navigate: jest.fn() });
    container.querySelector('button')!.click();
    await flushAsync();
    await flushAsync();
    expect(container.querySelector('.draft__error')?.textContent).toBe('rare');
  });

  test('onGenerate 未指定でもクリックで例外にならない', () => {
    const view = createDraftView();
    const container = buildContainer();
    view(container, { state: stateReady(), navigate: jest.fn() });
    expect(() => container.querySelector('button')!.click()).not.toThrow();
  });

  test('progress の blockIndex=0 でもカウンタが出る（ブロック 1/N 表記）', async () => {
    let capturedStatus = '';
    const onGenerate = jest.fn(async (notify: (p: DraftProgress) => void) => {
      notify({ step: 'mesh-suggester', blockIndex: 0, blockCount: 3 });
      // この時点でステータスが更新されている
      capturedStatus = container.querySelector('.draft__status')?.textContent ?? '';
    });
    const view = createDraftView({ onGenerate });
    const container = buildContainer();
    view(container, { state: stateReady(), navigate: jest.fn() });
    container.querySelector('button')!.click();
    await flushAsync();
    expect(capturedStatus).toContain('1/3');
  });

  test('全ステップラベルをカバー', async () => {
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
      const onGenerate = jest.fn(async (notify: (p: DraftProgress) => void) => {
        notify({ step, blockCount: 1 });
      });
      const view = createDraftView({ onGenerate });
      const container = buildContainer();
      view(container, { state: stateReady(), navigate: jest.fn() });
      container.querySelector('button')!.click();
      await flushAsync();
      expect(container.querySelector('.draft__status')?.textContent).toBeTruthy();
    }
  });
});
