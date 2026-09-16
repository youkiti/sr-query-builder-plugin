import { createDraftView, type DraftViewCallbacks } from './draftView';
import { createQueryOptimizationInputIdentity } from '../services/queryOptimizationCheckpointService';
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
function setup(callbacks: DraftViewCallbacks = {}) {
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
  const view = createDraftView(callbacks);
  const render = () => view(container, { state, navigate: jest.fn() });
  return { state, container, render };
}
beforeEach(() => jest.useFakeTimers({ now: 1000 }));

test.each(['success', 'failure', 'absent'] as const)('削除影響の書誌リンク後に注釈 %s を表示する', (status) => {
  const f = setup();
  const impact: NonNullable<OptimizationTrial['impact']> = { lostHits: 4, gainedHits: 0, error: null,
    inspected: ['1', '2', '3', '4'].map((pmid) => ({ pmid, title: '書誌', year: 2024 })) };
  if (status !== 'absent') impact.annotation = { status, annotatedAt: '', requestedPmids: ['1', '2', '3', '4'],
    error: status === 'failure' ? '期限切れ' : null, items: status === 'failure' ? [] : [
      { pmid: '1', judgement: 'likely_eligible', reason: '組入基準と一致する。' },
      { pmid: '2', judgement: 'unclear', reason: '情報が足りない。' },
      { pmid: '3', judgement: 'likely_ineligible', reason: '<script>除外基準と一致する。</script>' },
    ] };
  f.state.queryOptimizationRun!.trials[0]!.impact = impact;
  f.render();
  if (status === 'success') {
    for (const label of ['適格らしい（組入基準と一致する。）', '判断不能（情報が足りない。）', '非適格らしい（<script>除外基準と一致する。</script>）']) {
      expect(f.container.textContent).toContain(` — AI: ${label}`);
    }
    expect(f.container.querySelector('script')).toBeNull();
    const link = Array.from(f.container.querySelectorAll('a')).find((a) => a.textContent?.startsWith('PMID 1（'))!;
    expect(link.nextSibling!.textContent).toContain(' — AI:');
  } else if (status === 'failure') expect(f.container.textContent).toContain('AI の参考注釈を取得できませんでした（期限切れ）');
  else expect(f.container.textContent).not.toContain('AI:');
});

test('情報取得の件数と、その文脈を読んだ判断を別の履歴行に表示する', () => {
  const f = setup();
  f.state.queryOptimizationRun!.trials = [
    { ...trial('request'), kind: 'information', after: null, informationResult: { requested: 3, obtained: 1 } },
    { ...trial('decision'), informedBy: { candidateId: 'request', requested: 3, obtained: 1 } },
  ];
  f.render();
  const rows = f.container.querySelectorAll('.optimization__history li');
  expect(rows).toHaveLength(2);
  expect(rows[0]!.textContent).toContain('情報要求 — 前後件数:');
  expect(rows[0]!.textContent).toContain('情報要求 request: 文脈へ反映 1 / 要求 3 件');
  expect(rows[1]!.textContent).toContain('試行1 — 前後件数:');
  expect(rows[1]!.textContent).toContain('情報要求 request で得た文脈 1/3 件を読んだうえでの判断');
});

test('捕捉表の列・行見出しと捕捉・未捕捉・未測定を表示する', () => {
  const f = setup();
  f.state.queryOptimizationRun!.trials[0]!.after!.seedCapture = { seedPmids: ['11', '22'], rows: [
    { blockId: '1', capturedPmids: ['11'], error: null },
    { blockId: '2', capturedPmids: null, error: 'HTTP 414' },
  ] };
  f.render();
  const table = f.container.querySelector('table[aria-label="シード × ブロック捕捉表"]')!;
  expect(table.parentElement!.className).toBe('optimization__capture-table');
  expect(Array.from(table.querySelectorAll('th[scope="col"]')).map((th) => th.textContent)).toEqual(['シード PMID', '#1', '#2']);
  expect(Array.from(table.querySelectorAll('th[scope="row"]')).map((th) => th.textContent)).toEqual(['11', '22']);
  expect(Array.from(table.querySelectorAll('td')).map((td) => td.textContent)).toEqual(['○', '未測定', '×', '未測定']);
});

test('捕捉表のない試行を未計測と表示する', () => {
  const f = setup();
  f.render();
  expect(f.container.textContent).toContain('捕捉表は未計測');
  expect(f.container.querySelector('table[aria-label="シード × ブロック捕捉表"]')).toBeNull();
});
afterEach(() => { document.body.innerHTML = ''; jest.useRealTimers(); jest.restoreAllMocks(); });

test.each([150, null])('保留の削除影響 %s と書誌を表示し未測定を 0 にしない', (lostHits) => {
  const f = setup();
  Object.assign(f.state.queryOptimizationRun!.trials[0]!, { held: true, impact: {
    lostHits, gainedHits: 0, error: lostHits === null ? 'HTTP 414' : null,
    inspected: lostHits === null ? [] : [{ pmid: '901', title: '研究1', year: 2024 }, { pmid: '902', title: '研究2', year: 2023 }],
  } });
  f.render();
  const history = f.container.querySelector('.optimization__history')!;
  expect(history.textContent).toContain('/ 保留:');
  const group = Array.from(history.querySelectorAll('section')).find((item) => item.querySelector('h4')?.textContent === '削除影響')!;
  expect(group.textContent).toContain(`失う集合: ${lostHits ?? '未測定'} 件`);
  expect(group.textContent).toContain(`確認した書誌: ${lostHits === null ? 0 : 2} 件`);
  expect(group.querySelectorAll('a')).toHaveLength(lostHits === null ? 0 : 2);
  if (lostHits !== null) {
    const link = group.querySelector('a')!;
    expect(link.href).toBe(buildPubmedSearchUrl('901[uid]'));
    expect(link.textContent).toBe('PMID 901（2024）研究1');
    expect(link.target).toBe('_blank');
    expect(link.rel).toBe('noopener noreferrer');
  } else expect(group.textContent).toContain('実測・取得の失敗: HTTP 414');
});

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

test('変更詳細、ツリー、書誌リンク、語の単独件数と固有寄与を表示する', () => {
  const f = setup();
  f.state.queryOptimizationRun!.trials[0]!.before!.terms = [
    { blockId: '1', query: 'old[tiab]', hits: 50, delta: 9, finalContribution: 3 },
  ];
  f.render();
  const details = f.container.querySelector('.optimization__history details')!;
  expect(Array.from(details.querySelectorAll('h4')).map((h) => h.textContent)).toEqual(['MeSH', 'フリーワード', 'シード', 'シード × ブロック捕捉表', '削除影響', 'API 待機']);
  expect(details.textContent).toContain('差集合は実測していません');
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

function resumable(callbacks: DraftViewCallbacks = {}) {
  const f = setup(callbacks);
  f.state.queryOptimizationRun = null;
  f.state.protocolDraft = { frameworkType: 'pico', researchQuestion: 'RQ', inclusionCriteria: '組入', exclusionCriteria: '除外',
    studyDesign: '', sourceType: 'manual', sourceFilename: null, rawTextRef: null, rawTextPreview: '', rawTextInline: '' };
  f.state.protocolDraftPersisted = true;
  f.state.queryOptimizationSetup = { projectId: 'p', status: 'ready', maxHits: '10', maxIterations: '5', seedCount: 2,
    seedPmids: ['11', '22'], error: null, checkpoint: {
      projectId: 'p', runId: 'old', savedAt: '2026-09-10', maxHits: 10, trials: [], status: 'interrupted', needsRevalidation: true,
      resume: { bestFormula: { blocks: [{ id: '1', expression: 'best[tiab]', isCombination: false }], combinationExpression: null },
        inputIdentity: createQueryOptimizationInputIdentity(f.state.protocolDraft, f.state.blocksDraft!, ['11', '22'], 10),
        limits: { apiCalls: 200, elapsedMs: 600000, evaluatedTrials: 5 },
        consumed: { apiCalls: 120, elapsedMs: 300000, evaluatedTrials: 2 }, previousRejectedTrials: [] },
    } };
  return f;
}

test('中断記録だけに再測定と残予算を示し、既存の開始コールバックへ再開 run を渡す', () => {
  const onOptimize = jest.fn().mockResolvedValue(undefined);
  const f = resumable({ onOptimize });
  f.state.currentFormulaMarkdown = '手編集した現在式は一致条件に含めない';
  f.render();
  const restored = f.container.querySelector('.optimization__restored')!;
  expect(restored.textContent).toContain('再検証は済んでいません');
  expect(restored.textContent).toContain('件数・シード捕捉をすべて測り直します');
  expect(restored.textContent).toContain('通信 80 回 / 時間 300 秒 / 評価試行 3 回');
  const button = restored.querySelector<HTMLButtonElement>('.optimization__resume')!;
  button.click();
  button.click();
  expect(onOptimize).toHaveBeenCalledTimes(1);
  expect(onOptimize).toHaveBeenCalledWith({ maxHits: 10, maxIterations: 5 }, 'old');
  const checkpoint = f.state.queryOptimizationSetup!.checkpoint!;
  f.state.queryOptimizationSetup!.checkpoint = { ...checkpoint, status: 'completed',
    completion: { status: 'needs_review', stopReason: 'iteration_limit', unmetReasons: [] } };
  f.render();
  expect(f.container.querySelector('.optimization__resume')).toBeNull();
  expect(f.container.querySelector('.optimization__restored')!.textContent).not.toContain('再開');
});

test.each(['apiCalls', 'elapsedMs', 'evaluatedTrials'] as const)('%s を使い切った記録では再開ボタンを表示しない', (key) => {
  const f = resumable();
  const data = f.state.queryOptimizationSetup!.checkpoint!.resume!;
  data.consumed[key] = data.limits[key];
  f.render();
  expect(f.container.querySelector('.optimization__resume')).toBeNull();
  expect(f.container.textContent).toContain('予算を使い切っている');
});

test.each(['criteria', 'blocks', 'seeds', 'maxHits', 'unapproved', 'legacy'] as const)('入力変更や記録不足 %s を理由付きで非表示にする', (kind) => {
  const f = resumable();
  if (kind === 'criteria') f.state.protocolDraft!.researchQuestion = '変更';
  if (kind === 'blocks') f.state.blocksDraft!.blocks[0]!.description = '変更';
  if (kind === 'seeds') f.state.queryOptimizationSetup!.seedPmids = ['11'];
  if (kind === 'maxHits') f.state.queryOptimizationSetup!.maxHits = '11';
  if (kind === 'unapproved') f.state.protocolDraftPersisted = false;
  if (kind === 'legacy') delete f.state.queryOptimizationSetup!.checkpoint!.resume;
  f.render();
  expect(f.container.querySelector('.optimization__resume')).toBeNull();
  expect(f.container.querySelector('.optimization__restored')!.textContent).toMatch(/変わっている|確認できません|記録がありません/);
});

test('目安件数の入力中にも再開可否を更新し、フォーカスを維持する', () => {
  const f = resumable({ onOptimize: jest.fn() });
  f.render();
  const input = f.container.querySelector<HTMLInputElement>('.optimization__setup input')!;
  input.focus();
  input.value = '11';
  input.dispatchEvent(new Event('input'));
  expect(f.container.querySelector('.optimization__resume')).toBeNull();
  expect(document.activeElement).toBe(input);
  input.value = '10';
  input.dispatchEvent(new Event('input'));
  expect(f.container.querySelector('.optimization__resume')).not.toBeNull();
  expect(f.container.querySelectorAll('.optimization__restored')).toHaveLength(1);
});

test('再開した run の最初の試行が届くまでは復元ログを読める', () => {
  const f = resumable();
  f.state.queryOptimizationRun = { ...setup().state.queryOptimizationRun!, trials: [], runId: 'new-run' };
  f.render();
  expect(f.container.querySelector('.optimization__restored')!.textContent).toContain('再検証は済んでいません');
  expect(f.container.querySelector('.optimization__resume')).toBeNull();
  f.state.queryOptimizationRun.trials = [trial('initial')];
  f.render();
  expect(f.container.querySelector('.optimization__restored')).toBeNull();
});

test.each([150, null, undefined])('復元した削除影響 %s は保留と欠測を区別する', (lostHits) => {
  const f = setup();
  const candidate = f.state.queryOptimizationRun!.trials[0]!;
  f.state.queryOptimizationRun = null;
  f.state.queryOptimizationSetup = { projectId: 'p', status: 'ready', maxHits: '10', maxIterations: '5', seedCount: 2, error: null,
    checkpoint: { projectId: 'p', runId: 'old', savedAt: '2026-09-10', maxHits: 10, status: 'interrupted', needsRevalidation: true,
      trials: [{ candidateId: candidate.candidateId, formula: candidate.formula, totalHits: 50, capturedSeedCount: 2,
        accepted: false, held: true, lostHits, reason: '要確認', fingerprint: 'f' }] },
  };
  f.render();
  const restored = f.container.querySelector('.optimization__restored')!;
  expect(restored.textContent).toContain('保留: 要確認');
  if (lostHits === undefined) expect(restored.textContent).not.toContain('/ 失う');
  else expect(restored.textContent).toContain(`/ 失う ${lostHits ?? '未測定'} 件`);
});


test.each(['all', 'retrieved_subset', undefined] as const)('履歴に抽出方法 %s と種を表示する', (method) => {
  const f = setup();
  f.state.queryOptimizationRun!.trials[0]!.impact = { lostHits: 150, gainedHits: 0, inspected: [], error: null,
    ...(method ? { sample: { method, seed: 123, populationCount: 150, retrievedCount: 100,
      pmids: ['901'], sampledAt: '2026-09-15T00:00:00Z' } } : {}) };
  f.render();
  expect(f.container.textContent).toContain(`抽出方法: ${method ?? '旧データ'}`);
  expect(f.container.textContent).toContain(`種: ${method ? '123' : '記録なし'}`);
  if (method === 'retrieved_subset') expect(f.container.textContent).toContain('集合全体からの無作為抽出ではありません');
});
