import type { BoundaryCasesResult } from '@/app/services';
import { INITIAL_STATE, type AppState } from '../store';
import { createExpandView } from './expandView';

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

function sampleResult(overrides: Partial<BoundaryCasesResult> = {}): BoundaryCasesResult {
  return {
    candidates: [
      { pmid: '111', title: 'Paper A', year: 2020, reason: 'subset' },
      { pmid: '222', title: null, year: null, reason: '' },
    ],
    totalHits: 500,
    evaluatedCount: 20,
    ...overrides,
  };
}

describe('createExpandView', () => {
  test('プロジェクト未選択時は警告のみ', () => {
    const view = createExpandView();
    const container = buildContainer();
    view(container, { state: INITIAL_STATE, navigate: jest.fn() });
    expect(container.querySelector('.view__placeholder')?.textContent).toContain('プロジェクト');
    expect(container.querySelector('.expand__actions')).toBeNull();
  });

  test('検索式未生成時は /draft 誘導', () => {
    const view = createExpandView();
    const container = buildContainer();
    view(container, {
      state: { ...stateReady, currentFormulaMarkdown: null },
      navigate: jest.fn(),
    });
    expect(container.querySelector('.view__placeholder')?.textContent).toContain('/draft');
  });

  test('取得ボタンで onFetch が呼ばれ、候補一覧と判定ボタンが描画される', async () => {
    const onFetch = jest.fn().mockResolvedValue(sampleResult());
    const view = createExpandView({ onFetch });
    const container = buildContainer();
    view(container, { state: stateReady, navigate: jest.fn() });
    const btn = container.querySelector<HTMLButtonElement>('.expand__actions button')!;
    btn.click();
    await flushAsync();
    await flushAsync();
    expect(onFetch).toHaveBeenCalled();
    const items = container.querySelectorAll('.expand__candidate');
    expect(items).toHaveLength(2);
    expect(container.querySelector('.expand__status')?.textContent).toContain('2 件');
    // 1 つ目は title あり、理由あり
    expect(items[0]?.querySelector('.expand__candidate-meta')?.textContent).toContain('Paper A');
    expect(items[0]?.querySelector('.expand__candidate-reason')?.textContent).toContain('subset');
    // 2 つ目は title null → (no title)、reason '' → (無し)
    expect(items[1]?.querySelector('.expand__candidate-meta')?.textContent).toContain('(no title)');
    expect(items[1]?.querySelector('.expand__candidate-reason')?.textContent).toContain('(無し)');
    // 各候補には 3 つの判定ボタン
    expect(items[0]?.querySelectorAll('button')).toHaveLength(3);
  });

  test('include ボタンで onDecide が呼ばれ、decided クラスが付く', async () => {
    const onFetch = jest.fn().mockResolvedValue(sampleResult());
    const onDecide = jest.fn().mockResolvedValue({ seed: {} });
    const view = createExpandView({ onFetch, onDecide });
    const container = buildContainer();
    view(container, { state: stateReady, navigate: jest.fn() });
    const btn = container.querySelector<HTMLButtonElement>('.expand__actions button')!;
    btn.click();
    await flushAsync();
    await flushAsync();
    const item = container.querySelector<HTMLElement>('.expand__candidate')!;
    const includeBtn = item.querySelector<HTMLButtonElement>('button[data-decision=include]')!;
    includeBtn.click();
    await flushAsync();
    await flushAsync();
    expect(onDecide).toHaveBeenCalledWith({
      pmid: '111',
      title: 'Paper A',
      year: 2020,
      decision: 'include',
      reason: 'subset',
    });
    expect(item.classList.contains('expand__candidate--decided')).toBe(true);
    expect(item.querySelector('.expand__candidate-status')?.textContent).toContain('include');
  });

  test('onDecide が reject したら status を更新し、ボタンを再度有効化', async () => {
    const onFetch = jest.fn().mockResolvedValue(sampleResult({ candidates: sampleResult().candidates.slice(0, 1) }));
    const onDecide = jest.fn().mockRejectedValue(new Error('boom'));
    const view = createExpandView({ onFetch, onDecide });
    const container = buildContainer();
    view(container, { state: stateReady, navigate: jest.fn() });
    container.querySelector<HTMLButtonElement>('.expand__actions button')!.click();
    await flushAsync();
    await flushAsync();
    const item = container.querySelector<HTMLElement>('.expand__candidate')!;
    const includeBtn = item.querySelector<HTMLButtonElement>('button[data-decision=include]')!;
    includeBtn.click();
    await flushAsync();
    await flushAsync();
    expect(item.querySelector('.expand__candidate-status')?.textContent).toContain('失敗');
    expect(includeBtn.disabled).toBe(false);
  });

  test('onFetch が reject したらエラー表示', async () => {
    const onFetch = jest.fn().mockRejectedValue(new Error('boom'));
    const view = createExpandView({ onFetch });
    const container = buildContainer();
    view(container, { state: stateReady, navigate: jest.fn() });
    container.querySelector<HTMLButtonElement>('.expand__actions button')!.click();
    await flushAsync();
    await flushAsync();
    expect(container.querySelector('.expand__error')?.textContent).toBe('boom');
    expect(container.querySelector('.expand__status')?.textContent).toBe('');
  });

  test('onFetch 未指定でもクリックで例外にならない', () => {
    const view = createExpandView();
    const container = buildContainer();
    view(container, { state: stateReady, navigate: jest.fn() });
    const btn = container.querySelector<HTMLButtonElement>('.expand__actions button')!;
    expect(() => btn.click()).not.toThrow();
  });

  test('onDecide 未指定でもクリックで例外にならない', async () => {
    const onFetch = jest.fn().mockResolvedValue(sampleResult());
    const view = createExpandView({ onFetch });
    const container = buildContainer();
    view(container, { state: stateReady, navigate: jest.fn() });
    container.querySelector<HTMLButtonElement>('.expand__actions button')!.click();
    await flushAsync();
    await flushAsync();
    const includeBtn = container.querySelector<HTMLButtonElement>(
      'button[data-decision=include]'
    )!;
    expect(() => includeBtn.click()).not.toThrow();
  });

  test('Error 以外の onFetch 例外も String 化される', async () => {
    const onFetch = jest.fn().mockRejectedValue('rare');
    const view = createExpandView({ onFetch });
    const container = buildContainer();
    view(container, { state: stateReady, navigate: jest.fn() });
    container.querySelector<HTMLButtonElement>('.expand__actions button')!.click();
    await flushAsync();
    await flushAsync();
    expect(container.querySelector('.expand__error')?.textContent).toBe('rare');
  });

  test('Error 以外の onDecide 例外も String 化される', async () => {
    const onFetch = jest.fn().mockResolvedValue(sampleResult({ candidates: sampleResult().candidates.slice(0, 1) }));
    const onDecide = jest.fn().mockRejectedValue('rare');
    const view = createExpandView({ onFetch, onDecide });
    const container = buildContainer();
    view(container, { state: stateReady, navigate: jest.fn() });
    container.querySelector<HTMLButtonElement>('.expand__actions button')!.click();
    await flushAsync();
    await flushAsync();
    const includeBtn = container.querySelector<HTMLButtonElement>(
      'button[data-decision=include]'
    )!;
    includeBtn.click();
    await flushAsync();
    await flushAsync();
    expect(container.querySelector('.expand__candidate-status')?.textContent).toContain('rare');
  });
});
