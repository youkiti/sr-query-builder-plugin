import { createDraftView } from './draftView';
import { INITIAL_STATE, type AppState } from '../store';
import type { OptimizationMeasurement, OptimizationMeshNode, OptimizationTrial } from '@/features/formula/skills/optimizeQuery';
import { buildPubmedSearchUrl } from '@/lib/ncbi/pubmedUrl';

const measurement = (totalHits: number, capturedPmids: string[]): OptimizationMeasurement => ({
  id: 'm', fingerprint: 'f', measuredAt: '2026-09-11', totalHits, capturedPmids,
  missedPmids: ['11', '22'].filter((pmid) => !capturedPmids.includes(pmid)), blocks: [],
});
const trial = (id = 'candidate-1'): OptimizationTrial => ({
  candidateId: id, kind: 'proposal', formula: { blocks: [], combinationExpression: null },
  before: measurement(100, ['11', '22']), after: measurement(5, ['11']), accepted: false,
  reason: 'シード1件を失う', rationale: '基準外の広い語を置換',
  changes: { targetBlockId: '1', addedTerms: ['new[tiab]'], removedTerms: ['old[tiab]'], replacedTerms: [{ before: '"Parent"[Mesh]', after: '"Child"[Mesh]' }] },
  apiEvents: [{ source: 'PubMed', status: 'rate_limit' }, { source: 'PubMed', status: 'retry' }, { source: 'MeSH', status: 'failure' }],
});
const meshContext: OptimizationMeshNode[] = [
  { id: 'D1', descriptor: 'Parent', label: 'Parent', treeNumbers: ['C01'], parentIds: [], childIds: ['D2'], explode: true, note: '直下のみ取得' },
  { id: 'D2', descriptor: 'Child', label: 'Child', treeNumbers: ['C01.001'], parentIds: ['D1'], childIds: [], explode: false, note: '子は未取得' },
];
function setup() {
  const state: AppState = { ...INITIAL_STATE,
    project: { projectId: 'p', spreadsheetId: 's', driveFolderId: 'd', title: '研究' },
    blocksDraft: { blocks: [{ blockLabel: '疾患', description: '', note: '', aiGenerated: false }], combinationExpression: '#1' },
    queryOptimizationRun: { projectId: 'p', runId: 'r', status: 'running', maxHits: 10, maxIterations: 5,
      seedCount: 2, startedAtMs: 1000, finishedAtMs: null, progress: { step: 'adjusting', iterations: 3,
        evaluatedTrials: 1, bestTotalHits: 100, bestCapturedSeedCount: 2, trial: null },
      trials: [trial()], meshContext, stopRequested: false, result: null, error: null },
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const view = createDraftView();
  const render = () => view(container, { state, navigate: jest.fn() });
  return { state, container, render };
}
beforeEach(() => jest.useFakeTimers({ now: 1000 }));
afterEach(() => { document.body.innerHTML = ''; jest.useRealTimers(); jest.restoreAllMocks(); });

test('却下試行をライブ表示し、候補の前後値と最良値を分離する', () => {
  const f = setup();
  const focus = jest.spyOn(HTMLElement.prototype, 'focus');
  f.render();
  const history = f.container.querySelector('.optimization__history')!;
  expect(history.textContent).toContain('100 件 → 5 件 / シード: 2/2件 → 1/2件 / 却下: シード1件を失う');
  expect(f.container.querySelector('.optimization__metrics')!.textContent).toContain('最良候補の件数: 100 件');
  expect(f.container.querySelector('.optimization__metrics')!.textContent).toContain('試行回数: 1 / 最大 5');
  expect(history.closest('[aria-live=polite]')).toBeNull();
  expect(f.container.querySelector('.optimization__metrics')!.getAttribute('aria-live')).toBe('off');
  expect(f.container.querySelector('progress')).toBeNull();
  expect(history.querySelector('details')!.open).toBe(false);
  expect(focus).not.toHaveBeenCalled();
});

test('4種類の変更詳細、ツリー、書誌リンク、語の単独件数と固有寄与を表示する', () => {
  const f = setup();
  f.state.queryOptimizationRun!.trials[0]!.before!.terms = [
    { blockId: '1', query: 'old[tiab]', hits: 50, delta: 9, finalContribution: 3 },
  ];
  f.render();
  const details = f.container.querySelector('.optimization__history details')!;
  expect(Array.from(details.querySelectorAll('h4')).map((h) => h.textContent)).toEqual(['MeSH', 'フリーワード', 'シード', 'API 待機']);
  expect(details.textContent).toContain('Parent → Child');
  expect(details.textContent).toContain('C01.001 / explode: なし / 子は未取得');
  expect(details.textContent).toContain('単独件数（変更前 → 変更後）: 50 件 → 未測定');
  expect(details.textContent).toContain('最終式での固有寄与（変更前 → 変更後）: 3 件 → 未測定');
  expect(details.textContent).toContain('失ったため戻したシード');
  expect(details.querySelector<HTMLAnchorElement>('a')!.href).toBe(buildPubmedSearchUrl('22[uid]'));
  for (const text of ['レート調整中', '再試行中', '取得失敗', '基準外の広い語を置換']) expect(details.textContent).toContain(text);
});

test('run の文脈から関連する親子の情報を表示し、無関係な枝を試行へ混入させない', () => {
  const f = setup();
  const run = f.state.queryOptimizationRun!;
  run.meshContext = [...meshContext, { id: 'D9', descriptor: 'Unrelated', label: '無関係な枝', treeNumbers: ['C09'],
    parentIds: [], childIds: [], explode: true, note: '別の変更用' }];
  run.trials[0]!.before!.terms = [{ blockId: '1', query: '"Parent"[Mesh]', hits: 55, delta: null }];
  run.trials[0]!.after!.terms = [{ blockId: '1', query: '"Child"[Mesh]', hits: 10, delta: null }];
  f.render();
  const details = f.container.querySelector('.optimization__history details')!;
  for (const text of ['Parent → Child', 'C01 / explode: あり / 直下のみ取得',
    'C01.001 / explode: なし / 子は未取得', '55 件 → 10 件', '最終式の前後件数: 100 件 → 5 件',
    '根拠（AI の説明）: 基準外の広い語を置換']) expect(details.textContent).toContain(text);
  expect(details.textContent).not.toContain('無関係な枝');
  expect(run.trials[0]).not.toHaveProperty('meshContext');
});

test('情報要求の tree number を参照し、後から取得した子も開いている詳細へ反映する', () => {
  const f = setup();
  const run = f.state.queryOptimizationRun!;
  run.meshContext = [meshContext[0]!];
  run.trials = [{ ...trial('request'), kind: 'information', changes: undefined, after: null,
    meshRequests: [{ descriptor: '', treeNumber: 'C01' }] }];
  f.render();
  const details = f.container.querySelector<HTMLDetailsElement>('.optimization__history details')!;
  details.open = true;
  const summary = details.querySelector('summary')!;
  summary.focus();
  expect(details.textContent).toContain('親子関係は未取得');
  run.meshContext = [...meshContext];
  f.render();
  expect(f.container.querySelector('.optimization__history details')).toBe(details);
  expect(details.open).toBe(true);
  expect(document.activeElement).toBe(summary);
  expect(details.textContent).toContain('Parent → Child');
  expect(details.textContent).toContain('C01.001 / explode: なし / 子は未取得');
});

test('行種別と試行数は candidateId の文字列ではなく kind で判定する', () => {
  const f = setup();
  const run = f.state.queryOptimizationRun!;
  run.progress.evaluatedTrials = undefined;
  run.trials = [
    { ...trial('first'), kind: 'initial', changes: undefined },
    { ...trial('candidate-100'), kind: 'information', changes: undefined, meshRequests: [] },
    { ...trial('initial'), kind: 'proposal' },
    { ...trial('check'), kind: 'final', changes: undefined },
  ];
  f.render();
  const rows = Array.from(f.container.querySelectorAll('.optimization__history li > p:first-child'));
  expect(rows.map((row) => row.textContent!.split(' — ')[0])).toEqual(['初期式', '情報要求', '試行1', '最終再検証']);
  expect(f.container.querySelector('.optimization__metrics')!.textContent).toContain('試行回数: 1 / 最大 5');
});

test('構文却下・情報要求・測定失敗を実測ゼロで補完しない', () => {
  const f = setup();
  f.state.queryOptimizationRun!.trials = [
    { ...trial(), after: null },
    { ...trial('candidate-2'), after: null, kind: 'information', changes: undefined },
    { ...trial('candidate-3'), after: { ...measurement(0, []), totalHits: null, capturedPmids: null } },
  ];
  f.render();
  const rows = f.container.querySelectorAll('.optimization__history li > p:first-child');
  expect(rows).toHaveLength(3);
  for (const row of Array.from(rows)) expect(row.textContent).toContain('100 件 → 未測定');
  expect(rows[1]!.textContent).toContain('情報要求');
  expect(rows[2]!.textContent).toContain('試行2');
  expect(f.container.querySelector('.optimization__history')!.textContent).not.toContain('→ 0 件');
});

test('AI がタグを省略した変更語は一意に対応する実測語だけを表示する', () => {
  const f = setup();
  const candidate = f.state.queryOptimizationRun!.trials[0]!;
  candidate.changes!.replacedTerms = [{ before: 'Parent', after: 'Child' }];
  candidate.changes!.removedTerms = ['old'];
  candidate.before!.terms = [
    { blockId: '1', query: '"Parent"[Mesh]', hits: 55, delta: null },
    { blockId: '1', query: 'old[tiab]', hits: 7, delta: 1 },
    { blockId: '1', query: 'old[tw]', hits: 8, delta: 2 },
  ];
  candidate.after!.terms = [{ blockId: '1', query: '"Child"[Mesh]', hits: 10, delta: null }];
  f.render();
  const groups = f.container.querySelectorAll('.optimization__history details section');
  expect(groups[0]!.textContent).toContain('修正: Parent → Child');
  expect(groups[0]!.textContent).toContain('55 件 → 10 件');
  expect(groups[1]!.textContent).toContain('削除: old');
  expect(groups[1]!.textContent).toContain('単独件数（変更前 → 変更後）: 未測定 → 未測定');
});

test('過去を読んでいる間は位置と詳細の開閉を維持し、最下部へ戻すと新規行を追従する', () => {
  const f = setup();
  f.render();
  const scroll = f.container.querySelector<HTMLElement>('.optimization__history-scroll')!;
  let height = 1000;
  Object.defineProperties(scroll, { scrollHeight: { get: () => height }, clientHeight: { value: 200 } });
  scroll.scrollTop = 100;
  scroll.dispatchEvent(new Event('scroll'));
  scroll.querySelector('details')!.open = true;
  f.state.queryOptimizationRun!.trials.push(trial('candidate-2'));
  f.render();
  expect(f.container.querySelector('.optimization__history-scroll')).toBe(scroll);
  expect(scroll.scrollTop).toBe(100);
  expect(scroll.querySelector('details')!.open).toBe(true);
  scroll.scrollTop = 800;
  scroll.dispatchEvent(new Event('scroll'));
  height = 1200;
  f.state.queryOptimizationRun!.trials.push(trial('candidate-3'));
  f.render();
  expect(scroll.scrollTop).toBe(1200);
  const before = scroll.scrollTop;
  f.render();
  expect(scroll.scrollTop).toBe(before);
});

test('固定作業の N/M と取得できた実行費用だけを表示する', () => {
  const f = setup();
  f.state.queryOptimizationRun!.progress.task = { kind: 'terms', completed: 18, total: 24 };
  f.render();
  expect(f.container.textContent).toContain('語別件数 18/24語');
  expect(f.container.textContent).not.toContain('概算 AI 費用');
  f.state.queryOptimizationRun!.costUsd = 0.0123;
  f.state.queryOptimizationRun!.progress.task = { kind: 'seeds', completed: 2, total: 2 };
  f.render();
  expect(f.container.textContent).toContain('シード確認 2/2件');
  expect(f.container.textContent).toContain('$0.0123');
});

test('進捗更新でも履歴内のフォーカスと通知ノードを保持し、同じ通知文を書き直さない', () => {
  const f = setup();
  f.render();
  const summary = f.container.querySelector<HTMLElement>('.optimization__history summary')!;
  summary.focus();
  const announcement = f.container.querySelector('.optimization__announcement')!;
  const text = announcement.firstChild;
  f.state.queryOptimizationRun!.progress.task = { kind: 'terms', completed: 1, total: 2 };
  f.render();
  expect(document.activeElement).toBe(summary);
  expect(f.container.querySelector('.optimization__announcement')).toBe(announcement);
  expect(announcement.firstChild).toBe(text);
  const stop = f.container.querySelector<HTMLButtonElement>('.optimization__stop')!;
  stop.focus();
  f.state.queryOptimizationRun!.trials.push(trial('candidate-2'));
  f.render();
  expect(document.activeElement).toBe(stop);
  expect(announcement.textContent).toContain('履歴 2件');
});

test.each(['interrupted', 'completed'] as const)('復元した %s は実行状態にせず、再開や再検証済みを示さない', (status) => {
  const f = setup();
  f.state.queryOptimizationRun = null;
  f.state.queryOptimizationSetup = { projectId: 'p', status: 'ready', maxHits: '10', maxIterations: '5', seedCount: 2, error: null,
    checkpoint: { projectId: 'p', runId: 'old', savedAt: '2026-09-10', maxHits: 10, trials: [], status, needsRevalidation: true,
      completion: { status: 'achieved', stopReason: 'conditions_met', unmetReasons: [] } },
  };
  f.render();
  expect(f.container.textContent).toContain(status === 'interrupted' ? '処理は中断しています' : 'この実行は終了しています');
  expect(f.container.textContent).toContain('再検証は済んでいません');
  expect(f.container.textContent).not.toContain('再開');
  expect(f.container.querySelector('.optimization__status')).toBeNull();
  f.state.queryOptimizationSetup.projectId = 'other';
  f.render();
  expect(f.container.querySelector('.optimization__restored')).toBeNull();
});
