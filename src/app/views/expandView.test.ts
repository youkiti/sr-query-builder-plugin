import type { BoundaryCasesResult, ValidationSummary } from '@/app/services';
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

function pressKey(target: HTMLElement, key: string): void {
  const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  target.dispatchEvent(ev);
}

function buildValidationSummary(overrides: Partial<ValidationSummary> = {}): ValidationSummary {
  return {
    lineHits: [],
    finalQuery: {
      finalQuery: '#1',
      totalHits: 100,
      captureRate: 0.8,
      capturedPmids: ['111', '222', '333', '444'],
      missedPmids: ['555'],
    },
    finalQueryError: null,
    mesh: [],
    meshFrequency: [],
    meshError: null,
    eligibleSeedCount: 5,
    totalSeedCount: 6,
    loggedValidationIds: [],
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

  test('候補取得後にフォーカス対象 li へ scrollIntoView が呼ばれる', async () => {
    const scrollSpy = jest.fn();
    const proto = HTMLElement.prototype as unknown as {
      scrollIntoView?: (...args: unknown[]) => void;
    };
    const original = proto.scrollIntoView;
    proto.scrollIntoView = scrollSpy;
    try {
      const onFetch = jest.fn().mockResolvedValue(sampleResult());
      const view = createExpandView({ onFetch });
      const container = buildContainer();
      view(container, { state: stateReady, navigate: jest.fn() });
      container.querySelector<HTMLButtonElement>('.expand__actions button')!.click();
      await flushAsync();
      await flushAsync();
      expect(scrollSpy).toHaveBeenCalledWith({ block: 'nearest' });
    } finally {
      if (original === undefined) {
        delete proto.scrollIntoView;
      } else {
        proto.scrollIntoView = original;
      }
    }
  });

  test('"i" キーでフォーカス中の候補を include 判定できる', async () => {
    const onFetch = jest.fn().mockResolvedValue(sampleResult());
    const onDecide = jest.fn().mockResolvedValue({ seed: {} });
    const view = createExpandView({ onFetch, onDecide });
    const container = buildContainer();
    view(container, { state: stateReady, navigate: jest.fn() });
    container.querySelector<HTMLButtonElement>('.expand__actions button')!.click();
    await flushAsync();
    await flushAsync();
    const list = container.querySelector<HTMLElement>('.expand__candidates')!;
    pressKey(list, 'i');
    await flushAsync();
    await flushAsync();
    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(onDecide.mock.calls[0]![0]).toMatchObject({ pmid: '111', decision: 'include' });
  });

  test('保存中に同じショートカットを連打しても onDecide は 1 回しか呼ばれない', async () => {
    const onFetch = jest.fn().mockResolvedValue(sampleResult());
    type EmptySeedResult = { seed: Record<string, never> };
    let resolveDecision: ((value: EmptySeedResult) => void) | null = null;
    const onDecide = jest.fn().mockImplementation(
      () =>
        new Promise<EmptySeedResult>((resolve) => {
          resolveDecision = resolve;
        })
    );
    const view = createExpandView({ onFetch, onDecide });
    const container = buildContainer();
    view(container, { state: stateReady, navigate: jest.fn() });
    container.querySelector<HTMLButtonElement>('.expand__actions button')!.click();
    await flushAsync();
    await flushAsync();
    const list = container.querySelector<HTMLElement>('.expand__candidates')!;
    pressKey(list, 'i');
    pressKey(list, 'i');
    expect(onDecide).toHaveBeenCalledTimes(1);
    resolveDecision!({ seed: {} });
    await flushAsync();
    await flushAsync();
    expect(container.querySelector('.expand__candidate-status')?.textContent).toContain('保存しました');
  });

  test('"e" / "m" キーも対応する判定をトリガする', async () => {
    const onFetch = jest.fn().mockResolvedValue(sampleResult());
    const onDecide = jest.fn().mockResolvedValue({ seed: {} });
    const view = createExpandView({ onFetch, onDecide });
    const container = buildContainer();
    view(container, { state: stateReady, navigate: jest.fn() });
    container.querySelector<HTMLButtonElement>('.expand__actions button')!.click();
    await flushAsync();
    await flushAsync();
    const list = container.querySelector<HTMLElement>('.expand__candidates')!;
    pressKey(list, 'e');
    await flushAsync();
    await flushAsync();
    expect(onDecide.mock.calls[0]![0].decision).toBe('exclude');
    // 既に判定済みなのでフォーカスを次に進めて maybe
    pressKey(list, 'n');
    pressKey(list, 'm');
    await flushAsync();
    await flushAsync();
    expect(onDecide.mock.calls[1]![0].decision).toBe('maybe');
    expect(onDecide.mock.calls[1]![0].pmid).toBe('222');
  });

  test('"n" / "ArrowRight" は次の未判定候補へ、判定済みはスキップする', async () => {
    const onFetch = jest.fn().mockResolvedValue(sampleResult());
    const onDecide = jest.fn().mockResolvedValue({ seed: {} });
    const view = createExpandView({ onFetch, onDecide });
    const container = buildContainer();
    view(container, { state: stateReady, navigate: jest.fn() });
    container.querySelector<HTMLButtonElement>('.expand__actions button')!.click();
    await flushAsync();
    await flushAsync();
    const items = container.querySelectorAll<HTMLElement>('.expand__candidate');
    // 最初は 1 件目がフォーカス
    expect(items[0]?.classList.contains('expand__candidate--focused')).toBe(true);
    const list = container.querySelector<HTMLElement>('.expand__candidates')!;
    pressKey(list, 'ArrowRight');
    expect(items[1]?.classList.contains('expand__candidate--focused')).toBe(true);
    pressKey(list, 'n');
    // 循環して 1 件目に戻る（未判定なので）
    expect(items[0]?.classList.contains('expand__candidate--focused')).toBe(true);
  });

  test('"p" / "ArrowLeft" は端で止まる', async () => {
    const onFetch = jest.fn().mockResolvedValue(sampleResult());
    const view = createExpandView({ onFetch });
    const container = buildContainer();
    view(container, { state: stateReady, navigate: jest.fn() });
    container.querySelector<HTMLButtonElement>('.expand__actions button')!.click();
    await flushAsync();
    await flushAsync();
    const items = container.querySelectorAll<HTMLElement>('.expand__candidate');
    const list = container.querySelector<HTMLElement>('.expand__candidates')!;
    pressKey(list, 'ArrowLeft');
    // 0 から左は 0 のまま
    expect(items[0]?.classList.contains('expand__candidate--focused')).toBe(true);
    pressKey(list, 'ArrowRight');
    pressKey(list, 'p');
    expect(items[0]?.classList.contains('expand__candidate--focused')).toBe(true);
  });

  test('未対応キー / 候補未取得時のキー入力は無視される', async () => {
    const onFetch = jest.fn().mockResolvedValue(sampleResult());
    const onDecide = jest.fn();
    const view = createExpandView({ onFetch, onDecide });
    const container = buildContainer();
    view(container, { state: stateReady, navigate: jest.fn() });
    const list = container.querySelector<HTMLElement>('.expand__candidates')!;
    // まだ取得していない状態
    pressKey(list, 'i');
    expect(onDecide).not.toHaveBeenCalled();
    container.querySelector<HTMLButtonElement>('.expand__actions button')!.click();
    await flushAsync();
    await flushAsync();
    // 未対応キー
    pressKey(list, 'x');
    expect(onDecide).not.toHaveBeenCalled();
  });

  test('全候補を判定し終えると onRoundComplete が呼ばれ、捕捉率を表示する', async () => {
    const onFetch = jest.fn().mockResolvedValue(sampleResult());
    const onDecide = jest.fn().mockResolvedValue({ seed: {} });
    const onRoundComplete = jest.fn().mockResolvedValue(buildValidationSummary());
    const view = createExpandView({ onFetch, onDecide, onRoundComplete });
    const container = buildContainer();
    view(container, { state: stateReady, navigate: jest.fn() });
    container.querySelector<HTMLButtonElement>('.expand__actions button')!.click();
    await flushAsync();
    await flushAsync();
    const list = container.querySelector<HTMLElement>('.expand__candidates')!;
    pressKey(list, 'i');
    await flushAsync();
    await flushAsync();
    pressKey(list, 'n');
    pressKey(list, 'i');
    await flushAsync();
    await flushAsync();
    expect(onRoundComplete).toHaveBeenCalledTimes(1);
    const summary = container.querySelector('.expand__round-summary');
    expect(summary?.textContent).toContain('80.0%');
    expect(summary?.textContent).toContain('4/5');
    expect(summary?.textContent).toContain('5 / 6');
  });

  test('判定済みの候補に "i" を再度押しても onDecide は呼ばれない', async () => {
    const onFetch = jest.fn().mockResolvedValue(sampleResult({ candidates: sampleResult().candidates.slice(0, 1) }));
    const onDecide = jest.fn().mockResolvedValue({ seed: {} });
    const view = createExpandView({ onFetch, onDecide });
    const container = buildContainer();
    view(container, { state: stateReady, navigate: jest.fn() });
    container.querySelector<HTMLButtonElement>('.expand__actions button')!.click();
    await flushAsync();
    await flushAsync();
    const list = container.querySelector<HTMLElement>('.expand__candidates')!;
    pressKey(list, 'i');
    await flushAsync();
    await flushAsync();
    expect(onDecide).toHaveBeenCalledTimes(1);
    pressKey(list, 'i');
    await flushAsync();
    await flushAsync();
    expect(onDecide).toHaveBeenCalledTimes(1);
  });

  test('全候補判定済みの状態で "n" を押してもエラーにならない', async () => {
    const onFetch = jest.fn().mockResolvedValue(sampleResult({ candidates: sampleResult().candidates.slice(0, 1) }));
    const onDecide = jest.fn().mockResolvedValue({ seed: {} });
    const onRoundComplete = jest.fn().mockResolvedValue(buildValidationSummary());
    const view = createExpandView({ onFetch, onDecide, onRoundComplete });
    const container = buildContainer();
    view(container, { state: stateReady, navigate: jest.fn() });
    container.querySelector<HTMLButtonElement>('.expand__actions button')!.click();
    await flushAsync();
    await flushAsync();
    const list = container.querySelector<HTMLElement>('.expand__candidates')!;
    pressKey(list, 'i');
    await flushAsync();
    await flushAsync();
    expect(() => pressKey(list, 'n')).not.toThrow();
  });

  test('onRoundComplete 未指定の場合は手動 /validate 誘導の案内を表示', async () => {
    const onFetch = jest.fn().mockResolvedValue(sampleResult({ candidates: sampleResult().candidates.slice(0, 1) }));
    const onDecide = jest.fn().mockResolvedValue({ seed: {} });
    const view = createExpandView({ onFetch, onDecide });
    const container = buildContainer();
    view(container, { state: stateReady, navigate: jest.fn() });
    container.querySelector<HTMLButtonElement>('.expand__actions button')!.click();
    await flushAsync();
    await flushAsync();
    const list = container.querySelector<HTMLElement>('.expand__candidates')!;
    pressKey(list, 'i');
    await flushAsync();
    await flushAsync();
    expect(container.querySelector('.expand__round-note')?.textContent).toContain('/validate');
  });

  test('onRoundComplete が reject したらエラーを表示', async () => {
    const onFetch = jest.fn().mockResolvedValue(sampleResult({ candidates: sampleResult().candidates.slice(0, 1) }));
    const onDecide = jest.fn().mockResolvedValue({ seed: {} });
    const onRoundComplete = jest.fn().mockRejectedValue(new Error('quota'));
    const view = createExpandView({ onFetch, onDecide, onRoundComplete });
    const container = buildContainer();
    view(container, { state: stateReady, navigate: jest.fn() });
    container.querySelector<HTMLButtonElement>('.expand__actions button')!.click();
    await flushAsync();
    await flushAsync();
    const list = container.querySelector<HTMLElement>('.expand__candidates')!;
    pressKey(list, 'i');
    await flushAsync();
    await flushAsync();
    const error = container.querySelector('.expand__round-error');
    expect(error?.textContent).toContain('quota');
  });

  test('onRoundComplete reject の Error 以外も String 化される', async () => {
    const onFetch = jest.fn().mockResolvedValue(sampleResult({ candidates: sampleResult().candidates.slice(0, 1) }));
    const onDecide = jest.fn().mockResolvedValue({ seed: {} });
    const onRoundComplete = jest.fn().mockRejectedValue('rare');
    const view = createExpandView({ onFetch, onDecide, onRoundComplete });
    const container = buildContainer();
    view(container, { state: stateReady, navigate: jest.fn() });
    container.querySelector<HTMLButtonElement>('.expand__actions button')!.click();
    await flushAsync();
    await flushAsync();
    const list = container.querySelector<HTMLElement>('.expand__candidates')!;
    pressKey(list, 'i');
    await flushAsync();
    await flushAsync();
    expect(container.querySelector('.expand__round-error')?.textContent).toContain('rare');
  });

  test('summary に finalQueryError がある場合はその旨を表示', async () => {
    const onFetch = jest.fn().mockResolvedValue(sampleResult({ candidates: sampleResult().candidates.slice(0, 1) }));
    const onDecide = jest.fn().mockResolvedValue({ seed: {} });
    const onRoundComplete = jest
      .fn()
      .mockResolvedValue(buildValidationSummary({ finalQueryError: 'NCBI down' }));
    const view = createExpandView({ onFetch, onDecide, onRoundComplete });
    const container = buildContainer();
    view(container, { state: stateReady, navigate: jest.fn() });
    container.querySelector<HTMLButtonElement>('.expand__actions button')!.click();
    await flushAsync();
    await flushAsync();
    const list = container.querySelector<HTMLElement>('.expand__candidates')!;
    pressKey(list, 'i');
    await flushAsync();
    await flushAsync();
    const summary = container.querySelector('.expand__round-summary');
    expect(summary?.textContent).toContain('final_query 取得に失敗');
    expect(summary?.textContent).toContain('NCBI down');
  });

  test('有効 seed が 0 件のときは「計算不能」と表示', async () => {
    const onFetch = jest.fn().mockResolvedValue(sampleResult({ candidates: sampleResult().candidates.slice(0, 1) }));
    const onDecide = jest.fn().mockResolvedValue({ seed: {} });
    const onRoundComplete = jest.fn().mockResolvedValue(
      buildValidationSummary({
        finalQuery: {
          finalQuery: '#1',
          totalHits: 0,
          captureRate: 0,
          capturedPmids: [],
          missedPmids: [],
        },
      })
    );
    const view = createExpandView({ onFetch, onDecide, onRoundComplete });
    const container = buildContainer();
    view(container, { state: stateReady, navigate: jest.fn() });
    container.querySelector<HTMLButtonElement>('.expand__actions button')!.click();
    await flushAsync();
    await flushAsync();
    const list = container.querySelector<HTMLElement>('.expand__candidates')!;
    pressKey(list, 'i');
    await flushAsync();
    await flushAsync();
    expect(container.querySelector('.expand__round-summary')?.textContent).toContain('計算不能');
  });

  test('再度「境界事例を取得」を押すと round 表示が初期化される', async () => {
    const onFetch = jest
      .fn()
      .mockResolvedValueOnce(sampleResult({ candidates: sampleResult().candidates.slice(0, 1) }))
      .mockResolvedValueOnce(sampleResult({ candidates: sampleResult().candidates.slice(0, 1) }));
    const onDecide = jest.fn().mockResolvedValue({ seed: {} });
    const onRoundComplete = jest.fn().mockResolvedValue(buildValidationSummary());
    const view = createExpandView({ onFetch, onDecide, onRoundComplete });
    const container = buildContainer();
    view(container, { state: stateReady, navigate: jest.fn() });
    const fetchBtn = container.querySelector<HTMLButtonElement>('.expand__actions button')!;
    fetchBtn.click();
    await flushAsync();
    await flushAsync();
    const list = container.querySelector<HTMLElement>('.expand__candidates')!;
    pressKey(list, 'i');
    await flushAsync();
    await flushAsync();
    expect(container.querySelector('.expand__round-summary')).not.toBeNull();
    fetchBtn.click();
    await flushAsync();
    await flushAsync();
    // 新しいラウンドではまだ round summary は表示されない
    expect(container.querySelector('.expand__round-summary')).toBeNull();
  });
});
