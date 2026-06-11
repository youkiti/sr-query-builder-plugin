import {
  INITIAL_STATE,
  createStore,
  type AppState,
  type BlocksDraft,
  type ProtocolDraft,
} from '../store';
import { createBlocksView } from './blocksView';

function protocolOf(overrides: Partial<ProtocolDraft> = {}): ProtocolDraft {
  return {
    frameworkType: 'pico',
    researchQuestion: 'RQ',
    inclusionCriteria: '',
    exclusionCriteria: '',
    studyDesign: '',
    sourceType: 'manual',
    sourceFilename: null,
    rawTextRef: null,
    rawTextPreview: '',
    rawTextInline: null,
    ...overrides,
  };
}

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

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
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

  test('構文エラーがあると「承認してシード論文へ」が disabled になる', () => {
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
    // エラー時は status バッジ・承認ブロック理由・アクションサマリがエラーを示す
    expect(container.querySelector('.blocks__combination-status--error')?.textContent).toContain(
      '件のエラー'
    );
    expect(container.querySelector('.blocks__approve-reason')?.textContent).toContain('解消');
    expect(container.querySelector('.blocks__actions-summary')?.textContent).toContain('⚠');
  });

  test('構文 OK のときは「✓ 構文 OK」ステータスと警告無しでアクションが表示される', () => {
    const store = createStore({ ...withProject(), blocksDraft: draftOf(2, '#1 AND #2') });
    const view = createBlocksView(store);
    const container = buildContainer();
    view(container, { state: store.getState(), navigate: jest.fn() });
    expect(container.querySelector('.blocks__combination-status--ok')?.textContent).toContain(
      '構文 OK'
    );
    expect(container.querySelector('.blocks__approve-reason')).toBeNull();
    expect(container.querySelector('.blocks__actions-summary')?.textContent).toContain('✓ OK');
  });

  test('画面冒頭にガイド文とステッパー（3 ステップ）が表示される', () => {
    const store = createStore({ ...withProject(), blocksDraft: draftOf(2, '#1 AND #2') });
    const view = createBlocksView(store);
    const container = buildContainer();
    view(container, { state: store.getState(), navigate: jest.fn() });
    expect(container.querySelector('.blocks__lede')?.textContent).toContain('検索ブロック');
    const steps = container.querySelectorAll('.blocks__step');
    expect(steps).toHaveLength(3);
    expect(steps[0]?.textContent).toContain('ブロックを確認');
    expect(steps[1]?.textContent).toContain('結合式');
    expect(steps[2]?.textContent).toContain('承認');
  });

  test('各ブロックにラベル/メモ/説明の見出しと説明テキストが出る', () => {
    const store = createStore({ ...withProject(), blocksDraft: draftOf(1, '#1') });
    const view = createBlocksView(store);
    const container = buildContainer();
    view(container, { state: store.getState(), navigate: jest.fn() });
    const titles = Array.from(container.querySelectorAll('.blocks__field-title')).map(
      (n) => n.textContent
    );
    expect(titles).toEqual(expect.arrayContaining(['ブロック名', 'メモ', '説明', '結合式を編集']));
  });

  test('先頭ブロックの ↑ と末尾ブロックの ↓ は disabled', () => {
    const store = createStore({ ...withProject(), blocksDraft: draftOf(2, '#1 AND #2') });
    const view = createBlocksView(store);
    const container = buildContainer();
    view(container, { state: store.getState(), navigate: jest.fn() });
    const ups = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).filter(
      (b) => b.textContent === '↑'
    );
    const downs = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).filter(
      (b) => b.textContent === '↓'
    );
    expect(ups[0]?.disabled).toBe(true); // 先頭 ↑
    expect(ups[1]?.disabled).toBe(false);
    expect(downs[0]?.disabled).toBe(false);
    expect(downs[1]?.disabled).toBe(true); // 末尾 ↓
  });

  test('結合式エラーメッセージは「N 文字目:」形式で表示される', () => {
    const store = createStore({
      ...withProject(),
      blocksDraft: draftOf(2, '#99 AND #2'),
    });
    const view = createBlocksView(store);
    const container = buildContainer();
    view(container, { state: store.getState(), navigate: jest.fn() });
    const errorItems = Array.from(
      container.querySelectorAll<HTMLLIElement>('.blocks__combination-errors li')
    );
    expect(errorItems.length).toBeGreaterThan(0);
    expect(errorItems[0]?.textContent).toMatch(/^\d+ 文字目: /);
  });

  test('「下書きとして保存」「承認してシード論文へ」で callback が呼ばれる', () => {
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

  test('save callback が非同期の間は action button が pending になり、完了後に戻る', async () => {
    let resolveSave: (() => void) | undefined;
    const onSaveDraft = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        })
    );
    const store = createStore({ ...withProject(), blocksDraft: draftOf(2, '#1 AND #2') });
    const view = createBlocksView(store, { onSaveDraft });
    const container = buildContainer();
    view(container, { state: store.getState(), navigate: jest.fn() });
    const saveBtn = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent === '下書きとして保存'
    )!;
    const approveBtn = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent?.startsWith('承認して')
    )!;
    saveBtn.click();
    expect(saveBtn.disabled).toBe(true);
    expect(approveBtn.disabled).toBe(true);
    resolveSave?.();
    await flushAsync();
    expect(saveBtn.disabled).toBe(false);
    expect(approveBtn.disabled).toBe(false);
  });

  test('approve callback が同期的に throw した場合はエラー表示される', () => {
    const onApprove = jest.fn(() => {
      throw new Error('sync approve failed');
    });
    const store = createStore({ ...withProject(), blocksDraft: draftOf(2, '#1 AND #2') });
    const view = createBlocksView(store, { onApprove });
    const container = buildContainer();
    view(container, { state: store.getState(), navigate: jest.fn() });
    const approveBtn = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent?.startsWith('承認して')
    )!;
    approveBtn.click();
    expect(container.querySelector('#blocks-error')?.textContent).toBe('sync approve failed');
  });

  test('approve callback が非同期に reject した場合はエラー表示される', async () => {
    const onApprove = jest.fn().mockRejectedValue(new Error('approve failed'));
    const store = createStore({ ...withProject(), blocksDraft: draftOf(2, '#1 AND #2') });
    const view = createBlocksView(store, { onApprove });
    const container = buildContainer();
    view(container, { state: store.getState(), navigate: jest.fn() });
    const approveBtn = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent?.startsWith('承認して')
    )!;
    approveBtn.click();
    await flushAsync();
    expect(container.querySelector('#blocks-error')?.textContent).toBe('approve failed');
  });

  test('Error 以外の例外も String 化して表示する', async () => {
    const onApprove = jest.fn().mockRejectedValue('rare approve failure');
    const store = createStore({ ...withProject(), blocksDraft: draftOf(2, '#1 AND #2') });
    const view = createBlocksView(store, { onApprove });
    const container = buildContainer();
    view(container, { state: store.getState(), navigate: jest.fn() });
    const approveBtn = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent?.startsWith('承認して')
    )!;
    approveBtn.click();
    await flushAsync();
    expect(container.querySelector('#blocks-error')?.textContent).toBe('rare approve failure');
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

  test('study_design=RCT のとき #RCTfilter の自動付与プレビューが表示される', () => {
    const store = createStore({
      ...withProject(),
      blocksDraft: draftOf(2, '#1 AND #2'),
      protocolDraft: protocolOf({ studyDesign: 'RCT' }),
    });
    const view = createBlocksView(store);
    const container = buildContainer();
    view(container, { state: store.getState(), navigate: jest.fn() });
    const final = container.querySelector('.blocks__autofilter-final');
    expect(final?.textContent).toBe('検索式生成後: #1 AND #2 AND #RCTfilter');
    const items = container.querySelectorAll('.blocks__autofilter-list li');
    expect(items).toHaveLength(1);
    expect(items[0]?.textContent).toContain('RCTfilter');
  });

  test('study_design が RCT 以外なら自動付与プレビューを出さない', () => {
    const store = createStore({
      ...withProject(),
      blocksDraft: draftOf(2, '#1 AND #2'),
      protocolDraft: protocolOf({ studyDesign: 'observational' }),
    });
    const view = createBlocksView(store);
    const container = buildContainer();
    view(container, { state: store.getState(), navigate: jest.fn() });
    expect(container.querySelector('.blocks__autofilter')).toBeNull();
  });

  test('protocolDraft が無ければ自動付与プレビューを出さない', () => {
    const store = createStore({
      ...withProject(),
      blocksDraft: draftOf(2, '#1 AND #2'),
      protocolDraft: null,
    });
    const view = createBlocksView(store);
    const container = buildContainer();
    view(container, { state: store.getState(), navigate: jest.fn() });
    expect(container.querySelector('.blocks__autofilter')).toBeNull();
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
