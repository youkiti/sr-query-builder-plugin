import { INITIAL_STATE, createStore, type AppState, type BlocksDraft } from '../store';
import { createBlocksView } from './blocksView';

function buildContainer(): HTMLElement {
  const doc = document.implementation.createHTMLDocument('test');
  const div = doc.createElement('div');
  doc.body.appendChild(div);
  return div;
}

function withProject(state: Partial<AppState> = {}): AppState {
  return {
    ...INITIAL_STATE,
    project: { projectId: 'p', spreadsheetId: 's', driveFolderId: 'd', title: 'T' },
    ...state,
  };
}

function draftOf(count: number, combination = '#1'): BlocksDraft {
  return {
    blocks: Array.from({ length: count }, (_, i) => ({
      blockLabel: `L${i}`,
      description: `D${i}`,
      aiGenerated: i === 0,
      note: '',
    })),
    combinationExpression: combination,
  };
}

describe('createBlocksView', () => {
  test('プロジェクト未選択時は警告だけ', () => {
    const store = createStore();
    const view = createBlocksView(store);
    const container = buildContainer();
    view(container, { state: INITIAL_STATE, navigate: jest.fn() });
    expect(container.querySelector('.view__placeholder')?.textContent).toContain('プロジェクト');
    expect(container.querySelector('ol.blocks__list')).toBeNull();
  });

  test('blocksDraft が無ければ初期ドラフト（空ブロック 1 個）を作成する', () => {
    const store = createStore({ ...withProject(), blocksDraft: null });
    const view = createBlocksView(store);
    const container = buildContainer();
    view(container, { state: store.getState(), navigate: jest.fn() });
    expect(store.getState().blocksDraft?.blocks).toHaveLength(1);
    expect(container.querySelector('ol.blocks__list')?.children).toHaveLength(1);
  });

  test('既存 blocksDraft をレンダして label 入力で更新する', () => {
    const store = createStore({ ...withProject(), blocksDraft: draftOf(2, '#1 AND #2') });
    const view = createBlocksView(store);
    const container = buildContainer();
    view(container, { state: store.getState(), navigate: jest.fn() });

    const labelInput = container.querySelectorAll<HTMLInputElement>('.blocks__label-input')[0]!;
    expect(labelInput.value).toBe('L0');
    labelInput.value = 'Population';
    labelInput.dispatchEvent(new Event('input'));
    expect(store.getState().blocksDraft?.blocks[0]?.blockLabel).toBe('Population');
    expect(store.getState().blocksDraft?.blocks[0]?.aiGenerated).toBe(false);
  });

  test('「↓」ボタンでブロックの並びが入れ替わる', () => {
    const store = createStore({ ...withProject(), blocksDraft: draftOf(2) });
    const view = createBlocksView(store);
    const container = buildContainer();
    view(container, { state: store.getState(), navigate: jest.fn() });
    const downBtn = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent === '↓'
    )!;
    downBtn.click();
    expect(store.getState().blocksDraft?.blocks.map((b) => b.blockLabel)).toEqual(['L1', 'L0']);
  });

  test('「↑」ボタンでブロックの並びが入れ替わる', () => {
    const store = createStore({ ...withProject(), blocksDraft: draftOf(2) });
    const view = createBlocksView(store);
    const container = buildContainer();
    view(container, { state: store.getState(), navigate: jest.fn() });
    // 2 つ目（index=1）の ↑ ボタン
    const upButtons = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).filter(
      (b) => b.textContent === '↑'
    );
    upButtons[1]!.click();
    expect(store.getState().blocksDraft?.blocks.map((b) => b.blockLabel)).toEqual(['L1', 'L0']);
  });

  test('「削除」ボタンで該当ブロックが消える（最後の 1 つは消えない）', () => {
    const store = createStore({ ...withProject(), blocksDraft: draftOf(2) });
    const view = createBlocksView(store);
    const container = buildContainer();
    view(container, { state: store.getState(), navigate: jest.fn() });
    const delBtn = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent === '削除'
    )!;
    delBtn.click();
    expect(store.getState().blocksDraft?.blocks).toHaveLength(1);
  });

  test('「＋ ブロックを追加」で 1 増える、最大で disabled になる', () => {
    const store = createStore({ ...withProject(), blocksDraft: draftOf(4) });
    const view = createBlocksView(store);
    const container = buildContainer();
    view(container, { state: store.getState(), navigate: jest.fn() });
    const addBtn = container.querySelector<HTMLButtonElement>('.blocks__add-row button')!;
    addBtn.click();
    expect(store.getState().blocksDraft?.blocks).toHaveLength(5);
    // 再描画して MAX に達したか確認（次回 render で disabled）
    view(container, { state: store.getState(), navigate: jest.fn() });
    expect(container.querySelector<HTMLButtonElement>('.blocks__add-row button')!.disabled).toBe(true);
  });

  test('combination_expression を変更するとライブで反映される', () => {
    const store = createStore({ ...withProject(), blocksDraft: draftOf(2, '#1 AND #2') });
    const view = createBlocksView(store);
    const container = buildContainer();
    view(container, { state: store.getState(), navigate: jest.fn() });
    const input = container.querySelector<HTMLInputElement>('.blocks__combination-input')!;
    input.value = '#1 OR #2';
    input.dispatchEvent(new Event('input'));
    expect(store.getState().blocksDraft?.combinationExpression).toBe('#1 OR #2');
  });

  test('「全 AND に戻す」で combination が再構築される', () => {
    const store = createStore({ ...withProject(), blocksDraft: draftOf(3, 'broken') });
    const view = createBlocksView(store);
    const container = buildContainer();
    view(container, { state: store.getState(), navigate: jest.fn() });
    const resetBtn = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent === '全 AND に戻す'
    )!;
    resetBtn.click();
    expect(store.getState().blocksDraft?.combinationExpression).toBe('#1 AND #2 AND #3');
  });

  test('構文エラーがあると「承認して検索式生成へ」が disabled になる', () => {
    const store = createStore({
      ...withProject(),
      blocksDraft: draftOf(2, '#99 AND #2'), // 未定義 ID
    });
    const view = createBlocksView(store);
    const container = buildContainer();
    view(container, { state: store.getState(), navigate: jest.fn() });
    const approve = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent?.startsWith('承認して')
    )!;
    expect(approve.disabled).toBe(true);
    expect(container.querySelectorAll('.blocks__combination-errors li').length).toBeGreaterThan(0);
  });

  test('「下書きとして保存」「承認して検索式生成へ」で callback が呼ばれる', () => {
    const onSaveDraft = jest.fn();
    const onApprove = jest.fn();
    const store = createStore({ ...withProject(), blocksDraft: draftOf(2, '#1 AND #2') });
    const view = createBlocksView(store, { onSaveDraft, onApprove });
    const container = buildContainer();
    view(container, { state: store.getState(), navigate: jest.fn() });
    const saveBtn = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent === '下書きとして保存'
    )!;
    saveBtn.click();
    expect(onSaveDraft).toHaveBeenCalledWith(store.getState().blocksDraft);

    const approveBtn = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent?.startsWith('承認して')
    )!;
    approveBtn.click();
    expect(onApprove).toHaveBeenCalledWith(store.getState().blocksDraft);
  });

  test('callback 未指定でもクリックで例外にならない', () => {
    const store = createStore({ ...withProject(), blocksDraft: draftOf(2, '#1 AND #2') });
    const view = createBlocksView(store);
    const container = buildContainer();
    view(container, { state: store.getState(), navigate: jest.fn() });
    const saveBtn = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent === '下書きとして保存'
    )!;
    expect(() => saveBtn.click()).not.toThrow();
  });

  test('description / note を更新すると store が更新される', () => {
    const store = createStore({ ...withProject(), blocksDraft: draftOf(2) });
    const view = createBlocksView(store);
    const container = buildContainer();
    view(container, { state: store.getState(), navigate: jest.fn() });
    const desc = container.querySelectorAll<HTMLTextAreaElement>('.blocks__desc')[0]!;
    desc.value = '新しい説明';
    desc.dispatchEvent(new Event('input'));
    const note = container.querySelectorAll<HTMLTextAreaElement>('.blocks__note')[0]!;
    note.value = 'メモ';
    note.dispatchEvent(new Event('input'));
    expect(store.getState().blocksDraft?.blocks[0]?.description).toBe('新しい説明');
    expect(store.getState().blocksDraft?.blocks[0]?.note).toBe('メモ');
  });

  test('blocksDraft が render 中に消えると mutateDraft は何もしない', () => {
    const store = createStore({ ...withProject(), blocksDraft: draftOf(2) });
    const view = createBlocksView(store);
    const container = buildContainer();
    view(container, { state: store.getState(), navigate: jest.fn() });
    // ボタンを取得した後にドラフトを消す
    const labelInput = container.querySelector<HTMLInputElement>('.blocks__label-input')!;
    store.setState((s) => ({ ...s, blocksDraft: null }));
    labelInput.value = 'X';
    expect(() => labelInput.dispatchEvent(new Event('input'))).not.toThrow();
    expect(store.getState().blocksDraft).toBeNull();
  });
});
