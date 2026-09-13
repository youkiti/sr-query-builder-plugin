import { buildOptimizationReviewSections } from './queryOptimizationReviewSections';
import type { OptimizationOutsideCheckState, QueryOptimizationRunState } from '../store';

function fixture(): QueryOptimizationRunState {
  const formula = { blocks: [{ id: '1', expression: 'a[tiab]', isCombination: false }], combinationExpression: null };
  const measurement = { id: 'm', fingerprint: 'fp', measuredAt: '', totalHits: 10,
    capturedPmids: ['1'], missedPmids: [], blocks: [] };
  return { status: 'ready', projectId: 'p', runId: 'r', maxHits: 20, maxIterations: 2,
    seedCount: 1, startedAtMs: 0, finishedAtMs: 1, stopRequested: false, error: null, meshContext: [],
    progress: { step: 'review', iterations: 1, bestTotalHits: 10, bestCapturedSeedCount: 1, trial: null }, trials: [],
    result: { status: 'achieved', stopReason: 'conditions_met', unmetReasons: [], trials: [], iterations: 1, apiCalls: 1, elapsedMs: 1,
      best: { formula, measurement, evaluation: { status: 'success', fingerprint: 'fp', measuredAt: '', lineHits: [], seedPmids: ['1'],
        finalQuery: { status: 'success', error: null, finalQuery: 'a[tiab]', totalHits: 10, captureRate: 1, capturedPmids: ['1'], missedPmids: [] } } } },
    outsideCheck: { status: 'ready', reason: null, originalHits: 10, marginHits: 150, evaluatedCount: 20, candidates: [], decisions: {} },
  };
}
const candidate = (source: 'outside' | 'lost') => ({ pmid: '2', title: '研究', year: 2000, abstract: null, source, reason: '' });
const section = (run: QueryOptimizationRunState, key: string) => buildOptimizationReviewSections(run).sections.find((item) => item.key === key)!;

test('4 区分が確認済みなら未確認事項は空で、既知シードの限界は捕捉区分だけに出す', () => {
  const review = buildOptimizationReviewSections(fixture());
  expect(review.sections.map((item) => item.label)).toEqual(['既知文献の捕捉', '件数目標', '外側の確認', '削除影響の確認']);
  expect(review.sections.every((item) => item.state === 'confirmed')).toBe(true);
  expect(review.unconfirmed).toEqual([]);
  expect(review.sections[0].lines).toContain('既知シード 1/1 件捕捉');
  expect(review.sections[2].lines[0]).toContain('外側 150 件');
});

test.each(['zero', 'unmeasured', 'missed', 'captured'] as const)('既知シード %s の判定', (kind) => {
  const run = fixture();
  const best = run.result!.best!;
  if (kind === 'zero') best.evaluation.seedPmids = [];
  if (kind === 'unmeasured') best.evaluation.finalQuery.capturedPmids = null;
  if (kind === 'missed') { best.evaluation.finalQuery.capturedPmids = []; best.evaluation.finalQuery.missedPmids = ['1']; }
  expect(section(run, 'known_capture').state).toBe(kind === 'captured' ? 'confirmed' : kind === 'missed' ? 'unmet' : 'unconfirmed');
});

test.each([null, 21, 20, 0])('総件数 %s と上限を比較する', (totalHits) => {
  const run = fixture();
  run.result!.best!.evaluation.finalQuery.totalHits = totalHits;
  const target = section(run, 'hit_target');
  expect(target.state).toBe(totalHits === null ? 'unconfirmed' : totalHits > 20 ? 'unmet' : 'confirmed');
  expect(target.lines[0]).toContain(totalHits === null ? '未測定' : `実測 ${totalHits} 件`);
});

test.each(['missing', 'running', 'skipped', 'error'] as const)('外側の確認 %s は未確認と理由を表示する', (status) => {
  const run = fixture();
  if (status === 'missing') delete run.outsideCheck;
  else { run.outsideCheck!.status = status; run.outsideCheck!.reason = status === 'running' ? null : '取得できません'; }
  expect(section(run, 'outside_check').state).toBe('unconfirmed');
  if (status === 'error' || status === 'skipped') expect(section(run, 'outside_check').lines).toContain('取得できません');
});

test.each(['outside', 'lost'] as const)('%s の候補は保存済みだけを判定に数え、maybe を格上げしない', (source) => {
  const run = fixture();
  run.outsideCheck!.candidates = [candidate(source)];
  if (source === 'lost') run.trials = [{ kind: 'proposal', candidateId: 'candidate-1', formula: run.result!.best!.formula,
    before: null, after: null, accepted: false, held: true, rationale: '', reason: '', apiEvents: [],
    impact: { lostHits: 150, gainedHits: 0, inspected: [{ pmid: '2', title: '研究', year: 2000 }], error: null } }];
  const key = source === 'outside' ? 'outside_check' : 'deletion_impact';
  expect(section(run, key).state).toBe('needs_decision');
  for (const status of ['saving', 'error', 'saved'] as const) {
    run.outsideCheck!.decisions['2'] = { decision: 'include', status, error: null };
    expect(section(run, key).state).toBe(status === 'saved' ? 'unmet' : 'needs_decision');
  }
  for (const decision of ['exclude', 'maybe'] as const) {
    run.outsideCheck!.decisions['2'] = { decision, status: 'saved', error: null };
    expect(section(run, key).state).toBe('confirmed');
  }
  if (source === 'lost') {
    expect(section(run, key).lines).toContain('保留候補 candidate-1: 失う集合 150 件のうち書誌を確認できたのは先頭 1 件');
    expect(section(run, key).lines).toContain('残り 149 件は未確認');
    expect(section(run, 'outside_check').state).toBe('confirmed');
    run.outsideCheck!.candidates = [];
    run.trials[0]!.impact!.error = '書誌取得失敗';
    expect(section(run, key).state).toBe('unconfirmed');
    expect(section(run, key).lines).toContain('書誌取得失敗');
  }
});

test('include 保存があっても未判定が残るなら判定待ちを優先する', () => {
  const run = fixture();
  run.outsideCheck!.candidates = [candidate('outside'), { ...candidate('outside'), pmid: '3' }];
  run.outsideCheck!.decisions['2'] = { decision: 'include', status: 'saved', error: null };
  expect(section(run, 'outside_check').state).toBe('needs_decision');
  expect(section(run, 'outside_check').lines.join('')).toContain('include した文献が 1 件');
});

test('結果なしは他の状態が残っていても全区分を未確認にする', () => {
  const run = fixture();
  run.result = null;
  const review = buildOptimizationReviewSections(run);
  expect(review.sections.every((item) => item.state === 'unconfirmed')).toBe(true);
  expect(review.unconfirmed).toHaveLength(4);
  expect(JSON.stringify(review).match(/既知シードの捕捉は、/g)).toHaveLength(1);
});

test.each(['running', 'skipped', 'error'] as OptimizationOutsideCheckState['status'][])('探索 %s でも失う文献の判定を独立して扱う', (status) => {
  const run = fixture();
  run.outsideCheck!.status = status;
  expect(section(run, 'deletion_impact').state).toBe('confirmed');
});
