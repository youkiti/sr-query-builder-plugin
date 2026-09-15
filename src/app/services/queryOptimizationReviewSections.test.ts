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
  expect(review.sections.map((item) => item.label)).toEqual(['既知文献の捕捉', '目安件数', '外側の確認', '削除影響の確認']);
  expect(review.sections.every((item) => item.state === 'confirmed')).toBe(true);
  expect(review.unconfirmed).toEqual([]);
  expect(review.sections[0].lines).toContain('既知シード 1/1 件捕捉');
  expect(review.sections[2].lines[0]).toContain('外側 150 件');
  expect(review.sections[2].maybeCount).toBe(0);
  for (const index of [0, 1, 3]) expect(review.sections[index]).not.toHaveProperty('maybeCount');
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
  expect(target.label).toBe('目安件数');
  expect(target.lines).toEqual([`目安件数 20 件に対して実測 ${totalHits === null ? '未測定' : `${totalHits} 件`}（${totalHits === null ? '未測定' : totalHits > 20 ? '目安超過' : '目安以下'}）`]);
});

test.each(['missing', 'running', 'skipped', 'error'] as const)('外側の確認 %s は未確認と理由を表示する', (status) => {
  const run = fixture();
  if (status === 'missing') delete run.outsideCheck;
  else { run.outsideCheck!.status = status; run.outsideCheck!.reason = status === 'running' ? null : '取得できません'; }
  expect(section(run, 'outside_check').state).toBe('unconfirmed');
  expect(section(run, 'outside_check')).not.toHaveProperty('maybeCount');
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
    const current = section(run, key);
    expect(current.state).toBe(decision === 'maybe' || source === 'lost' ? 'decided' : 'confirmed');
    expect(current.maybeCount).toBe(decision === 'maybe' ? 1 : 0);
    expect(current.lines.includes('maybe で保存した候補 1 件は未確認として残ります')).toBe(decision === 'maybe');
    expect(buildOptimizationReviewSections(run).unconfirmed.some((line) => line.startsWith(`${current.label}:`))).toBe(decision === 'maybe' || source === 'lost');
    if (source === 'lost') expect(current.lines).toContain('残り 149 件は未確認');
  }
  run.outsideCheck!.candidates.push({ ...candidate(source), pmid: '3' });
  run.outsideCheck!.decisions['3'] = { decision: 'include', status: 'saved', error: null };
  const mixed = section(run, key);
  expect(mixed.state).toBe('unmet');
  expect(mixed.maybeCount).toBe(1);
  expect(mixed.lines[mixed.lines.length - 2]).toBe('maybe で保存した候補 1 件は未確認として残ります');
  expect(mixed.lines[mixed.lines.length - 1]).toContain('保護して再調整してください');
  run.outsideCheck!.decisions['3']!.status = 'saving';
  expect(section(run, key).state).toBe('needs_decision');
  expect(section(run, key).maybeCount).toBe(1);
  run.outsideCheck!.decisions['2']!.status = 'error';
  expect(section(run, key).state).toBe('needs_decision');
  expect(section(run, key).maybeCount).toBe(0);
  expect(section(run, key).lines.join('')).not.toContain('maybe で保存した候補');
  if (source === 'lost') {
    expect(section(run, key).lines).toContain('保留候補 candidate-1: 失う集合 150 件のうち書誌を確認できたのは先頭 1 件');
    expect(section(run, key).lines).toContain('残り 149 件は未確認');
    expect(section(run, 'outside_check').state).toBe('confirmed');
    run.outsideCheck!.candidates = [];
    run.trials[0]!.impact!.error = '書誌取得失敗';
    expect(section(run, key).state).toBe('unconfirmed');
    expect(section(run, key)).not.toHaveProperty('maybeCount');
    expect(section(run, key).lines).toContain('書誌取得失敗');
    delete run.trials[0]!.impact;
    expect(section(run, key).state).toBe('unconfirmed');
    expect(section(run, key).lines.join('')).toContain('失う集合 未測定');
  }
});

function deletionFixture(): QueryOptimizationRunState {
  const run = fixture();
  run.trials = [{ kind: 'proposal', candidateId: 'candidate-1', formula: run.result!.best!.formula,
    before: null, after: null, accepted: false, held: true, rationale: '', reason: '', apiEvents: [],
    impact: { lostHits: 2, gainedHits: 0, inspected: [
      { pmid: '2', title: '研究', year: 2000 }, { pmid: '3', title: '研究', year: 2000 },
    ], error: null } }];
  run.outsideCheck!.candidates = ['2', '3'].map((pmid) => ({
    ...candidate('lost'), pmid, heldCandidateId: 'candidate-1',
  }));
  run.outsideCheck!.decisions = {
    '2': { decision: 'exclude', status: 'saved', error: null },
    '3': { decision: 'exclude', status: 'saved', error: null },
  };
  return run;
}

test('失う集合 150 件のうち書誌 1 件だけを exclude 保存しても未確認事項に残る', () => {
  const run = deletionFixture();
  run.trials[0]!.impact!.lostHits = 150;
  run.trials[0]!.impact!.inspected.pop();
  run.outsideCheck!.candidates.pop();
  delete run.outsideCheck!.decisions['3'];
  const review = buildOptimizationReviewSections(run);
  expect(review.sections[3].state).toBe('decided');
  expect(review.sections[3].maybeCount).toBe(0);
  expect(review.sections[3].lines).toContain('残り 149 件は未確認');
  expect(review.unconfirmed).toEqual([expect.stringMatching(/^削除影響の確認:.*残り 149 件は未確認/)]);
});

test.each(['exclude', 'maybe'] as const)('失う集合 2 件を全件取得し、最後の判定が %s の場合', (decision) => {
  const run = deletionFixture();
  run.outsideCheck!.decisions['3']!.decision = decision;
  const review = buildOptimizationReviewSections(run);
  expect(review.sections[3].state).toBe(decision === 'exclude' ? 'confirmed' : 'decided');
  expect(review.sections[3].maybeCount).toBe(decision === 'maybe' ? 1 : 0);
  expect(review.unconfirmed.some((line) => line.startsWith('削除影響の確認:'))).toBe(decision === 'maybe');
});

test.each([2, 3])('重複 PMID の判定候補が片方だけでも全保留試行の取得状況を確認する（後続の失う集合 %i 件）', (lostHits) => {
  const run = deletionFixture();
  const first = run.trials[0]!;
  run.trials.push({ ...first, candidateId: 'candidate-2', impact: { ...first.impact!, lostHits } });
  const review = buildOptimizationReviewSections(run);
  expect(review.sections[3].state).toBe(lostHits === 2 ? 'confirmed' : 'decided');
  expect(review.unconfirmed.some((line) => line.startsWith('削除影響の確認:'))).toBe(lostHits > 2);
});

test('登録済みシードとして判定候補に載らない PMID は全件取得時の確認を妨げない', () => {
  const run = deletionFixture();
  run.outsideCheck!.candidates.pop();
  delete run.outsideCheck!.decisions['3'];
  const review = buildOptimizationReviewSections(run);
  expect(review.sections[3].state).toBe('confirmed');
  expect(review.unconfirmed).toEqual([]);
});

test.each(['取得失敗', '未測定', '影響なし', '空のエラー'] as const)('全判定候補を exclude 保存しても影響の状態を確認する: %s', (kind) => {
  const run = deletionFixture();
  if (kind === '取得失敗') run.trials[0]!.impact!.error = '書誌取得失敗';
  if (kind === '未測定') run.trials[0]!.impact!.lostHits = null;
  if (kind === '影響なし') delete run.trials[0]!.impact;
  if (kind === '空のエラー') run.trials[0]!.impact!.error = '';
  const review = buildOptimizationReviewSections(run);
  expect(review.sections[3].state).toBe(kind === '空のエラー' ? 'confirmed' : 'decided');
  expect(review.unconfirmed.some((line) => line.startsWith('削除影響の確認:'))).toBe(kind !== '空のエラー');
  if (kind === '取得失敗') expect(review.sections[3].lines).toContain('書誌取得失敗');
});

test('保留試行があり判定候補が 0 件なら全件取得済みでも未確認事項に残る', () => {
  const run = deletionFixture();
  run.outsideCheck!.candidates = [];
  run.outsideCheck!.decisions = {};
  const review = buildOptimizationReviewSections(run);
  expect(review.sections[3].state).toBe('unconfirmed');
  expect(review.sections[3]).not.toHaveProperty('maybeCount');
  expect(review.unconfirmed).toEqual([expect.stringMatching(/^削除影響の確認:/)]);
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
  for (const item of review.sections) expect(item).not.toHaveProperty('maybeCount');
  expect(review.unconfirmed).toHaveLength(4);
  expect(JSON.stringify(review).match(/既知シードの捕捉は、/g)).toHaveLength(1);
});

test.each(['running', 'skipped', 'error'] as OptimizationOutsideCheckState['status'][])('探索 %s でも失う文献の判定を独立して扱う', (status) => {
  const run = fixture();
  run.outsideCheck!.status = status;
  expect(section(run, 'deletion_impact').state).toBe('confirmed');
});


test.each(['all', 'retrieved_subset', undefined] as const)('抽出方法 %s を表示して未確認件数を維持する', (method) => {
  const run = fixture();
  run.trials = [{ kind: 'proposal', candidateId: 'candidate-1', formula: run.result!.best!.formula,
    before: null, after: null, accepted: false, held: true, rationale: '', reason: '', apiEvents: [],
    impact: { lostHits: 150, gainedHits: 0, inspected: [{ pmid: '2', title: '研究', year: 2000 }], error: null,
      ...(method ? { sample: { method, seed: 123, populationCount: 150, retrievedCount: method === 'all' ? 150 : 100,
        pmids: ['2'], sampledAt: '2026-09-15T00:00:00Z' } } : {}) } }];
  const review = section(run, 'deletion_impact');
  const expected = method === 'all' ? '失う集合 150 件から無作為抽出した 1 件の書誌を確認'
    : method === 'retrieved_subset' ? '失う集合 150 件のうち取得できた 100 件から無作為抽出した 1 件の書誌を確認（集合全体からの無作為抽出ではありません）'
      : '失う集合 150 件のうち書誌を確認できたのは先頭 1 件';
  expect(review.lines).toContain(`保留候補 candidate-1: ${expected}`);
  expect(review.lines).toContain('残り 149 件は未確認');
  expect(review.state).not.toBe('confirmed');
});
