import { renderOptimizationReview } from './queryOptimizationReview';
import { createDraftView } from './draftView';
import { INITIAL_STATE, type QueryOptimizationRunState } from '../store';
import { parsePubmedFormulaMd } from '@/lib/search-formula-md';

function run(status: 'achieved' | 'needs_review' | 'stopped' | 'error'): QueryOptimizationRunState {
  const initial = parsePubmedFormulaMd('## PubMed/MEDLINE\n```\n#1 a[tiab] OR b[tiab]\n```');
  const formula = parsePubmedFormulaMd('## PubMed/MEDLINE\n```\n#1 a[tiab]\n```');
  const measurement = { id: 'm', fingerprint: 'fp', measuredAt: '2026-09-11', totalHits: 12,
    capturedPmids: ['1'], missedPmids: [], blocks: [] };
  return { status: 'ready', projectId: 'p', runId: 'r', maxHits: 20, maxIterations: 2,
    seedCount: 1, startedAtMs: 0, finishedAtMs: 1, stopRequested: false, error: null, meshContext: [],
    progress: { step: 'review', iterations: 1, bestTotalHits: 12, bestCapturedSeedCount: 1, trial: null },
    trials: [{ kind: 'initial', candidateId: 'initial', formula: initial, accepted: true,
      before: null, after: measurement, reason: '初期実測', rationale: '', apiEvents: [] }],
    result: { status, stopReason: 'conditions_met', unmetReasons: ['残った確認事項'], trials: [], iterations: 1, apiCalls: 1, elapsedMs: 1,
      best: { formula, measurement, evaluation: { status: 'success', fingerprint: 'fp', measuredAt: '2026-09-11',
        lineHits: [], seedPmids: ['1'], finalQuery: { status: 'success', error: null, finalQuery: 'a[tiab]',
          totalHits: 12, captureRate: 1, capturedPmids: ['1'], missedPmids: [] } } } },
  };
}
const actions = { adopt: jest.fn(async () => {}), edit: jest.fn() };
beforeEach(() => { jest.clearAllMocks(); });

test.each([['achieved', '条件達成'], ['needs_review', '要確認'], ['stopped', '停止'], ['error', 'エラー']] as const)(
  '%s を %s と区別し、最終式・上限・既知シード・正味の変更と懸念を出す', (status, label) => {
    const container = document.createElement('div');
    renderOptimizationReview(container, run(status), actions);
    expect(container.querySelector('h3')?.textContent).toBe(`最終レビュー：${label}`);
    expect(container.querySelector('pre')?.textContent).toContain('#1 a[tiab]');
    expect(container.textContent).toContain('最大件数 20 件に対して実測 12 件（上限以下）');
    expect(container.textContent).toContain('既知シード 1/1 件捕捉');
    expect(container.textContent).toContain('未知の適格研究の網羅性を保証するものではありません');
    expect(container.textContent).toContain('#1: a[tiab] OR b[tiab] → a[tiab]');
    expect(container.textContent).toContain('残った確認事項');
    expect(container.querySelector('details')).toBeNull();
  }
);

test('実測候補がないエラーでは保存・編集を無効化し、未測定を 0 にしない', () => {
  const current = run('error');
  current.result = null;
  current.status = 'error';
  current.error = '初期式の準備に失敗';
  const container = document.createElement('div');
  renderOptimizationReview(container, current, actions);
  expect(container.textContent).toContain('実測 未測定');
  expect(container.textContent).toContain('初期式の準備に失敗');
  expect(Array.from(container.querySelectorAll('button')).every((button) => button.disabled)).toBe(true);
});

test.each(['saving', 'saved', 'error'] as const)('保存状態 %s をライブ行に保持し、操作を制御する', (status) => {
  const current = run('achieved');
  current.save = { formulaVersionId: 'r', status, error: status === 'error' ? '保存失敗' : null };
  const container = document.createElement('div');
  renderOptimizationReview(container, current, actions);
  expect(container.querySelector('button')?.disabled).toBe(status !== 'error');
  expect(container.querySelector('.optimization__save-status')?.getAttribute('aria-live')).toBe('polite');
  expect(container.querySelector('.optimization__save-error')?.textContent).toBe(status === 'error' ? '保存失敗' : '');
});

test('最終レビューと保存の再描画で既存の履歴 DOM・詳細の開閉を保持する', () => {
  const render = createDraftView();
  const current = run('achieved');
  const state = { ...INITIAL_STATE, project: { projectId: 'p', spreadsheetId: 's', driveFolderId: 'd', title: '研究' },
    blocksDraft: { blocks: [{ blockLabel: '疾患', description: '', aiGenerated: false, note: '' }], combinationExpression: '#1' },
    queryOptimizationRun: current };
  const container = document.createElement('div');
  const context = { state, navigate: jest.fn() };
  render(container, context);
  const history = container.querySelector('.optimization__history');
  const details = history!.querySelector('details')!;
  details.open = true;
  current.save = { formulaVersionId: 'r', status: 'saved', error: null };
  render(container, context);
  expect(container.querySelector('.optimization__history')).toBe(history);
  expect(details.open).toBe(true);
  expect(container.querySelectorAll('.optimization__review')).toHaveLength(1);
  expect(container.querySelector('.optimization__save-status')?.textContent).toContain('保存しました');
});
