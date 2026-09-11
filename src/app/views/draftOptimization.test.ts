import { createDraftView } from './draftView';
import { INITIAL_STATE, type AppState } from '../store';

function state(): AppState {
  return { ...INITIAL_STATE,
    project: { projectId: 'p', spreadsheetId: 's', driveFolderId: 'd', title: '研究' },
    blocksDraft: { blocks: [{ blockLabel: '疾患', description: '', note: '', aiGenerated: false }], combinationExpression: '#1' },
    protocolDraftPersisted: true,
    queryOptimizationSetup: { projectId: 'p', status: 'ready', maxHits: '123', maxIterations: '2', seedCount: 0, error: null },
    queryOptimizationRun: { status: 'running', projectId: 'p', runId: 'r', maxHits: 123, maxIterations: 2,
      seedCount: 0, startedAtMs: 1000, finishedAtMs: null, progress: { step: 'revalidating', iterations: 1,
        bestTotalHits: 140, bestCapturedSeedCount: 0, trial: null },
      trials: [], stopRequested: false, result: null, error: null },
  };
}
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); document.body.innerHTML = ''; });

test('5 指標と現在段階を表示し、進捗更新で focus を呼ばず、全体の割合を出さない', () => {
  jest.useFakeTimers({ now: 1000 });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const focus = jest.spyOn(HTMLElement.prototype, 'focus');
  const render = createDraftView();
  const current = state();
  render(container, { state: current, navigate: jest.fn() });
  expect(container.querySelectorAll('.optimization__metrics > span')).toHaveLength(5);
  expect(container.querySelector('.optimization__metrics')!.textContent).toContain('最良候補の件数: 140 件');
  expect(container.querySelector('[aria-current=step]')!.textContent).toBe('再検証');
  expect(container.querySelector('progress')).toBeNull();
  expect(container.textContent).toContain('検証対象シードがありません');
  expect(container.querySelector('.optimization__status')!.getAttribute('aria-live')).toBe('polite');
  jest.advanceTimersByTime(2000);
  expect(container.textContent).toContain('経過時間: 2秒');
  current.queryOptimizationRun!.progress.bestTotalHits = 110;
  current.queryOptimizationRun!.progress.step = 'measuring';
  render(container, { state: current, navigate: jest.fn() });
  expect(container.querySelector('[aria-current=step]')!.textContent).toBe('実測');
  expect(focus).not.toHaveBeenCalled();
  container.remove();
  jest.advanceTimersByTime(1000);
  expect(jest.getTimerCount()).toBe(0);
});

test('入力を label で包み、詳細設定に反復上限を置き、エラーを alert で表示する', () => {
  const container = document.createElement('div');
  const current = state();
  current.queryOptimizationRun!.status = 'error';
  current.queryOptimizationRun!.error = '最大件数は正の整数で指定してください。';
  createDraftView()(container, { state: current, navigate: jest.fn() });
  expect(container.querySelector('.optimization__setup label > input[type=number]')).not.toBeNull();
  expect(container.querySelector('.optimization__setup details label')!.textContent).toContain('反復上限');
  expect(container.querySelector('.optimization__setup [role=alert]')!.textContent).toContain('正の整数');
  expect(container.querySelector('.optimization__start')!.textContent).toBe('検索式を作成・自動調整する');
});

test('停止は callback を呼び、停止要求済みならボタンを無効にする', () => {
  jest.useFakeTimers();
  const container = document.createElement('div');
  const stop = jest.fn();
  const current = state();
  const render = createDraftView({ onStopOptimization: stop });
  render(container, { state: current, navigate: jest.fn() });
  container.querySelector<HTMLButtonElement>('.optimization__stop')!.click();
  expect(stop).toHaveBeenCalledTimes(1);
  current.queryOptimizationRun!.stopRequested = true;
  render(container, { state: current, navigate: jest.fn() });
  expect(container.querySelector<HTMLButtonElement>('.optimization__stop')!.disabled).toBe(true);
});
