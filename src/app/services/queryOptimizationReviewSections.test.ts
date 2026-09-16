import { buildOptimizationReviewSections, countLostSampleAnnotations, evaluateHeldCandidateAdoptionGate,
  formatUnconfirmedEligibleUpperBound, HELD_CANDIDATE_ADOPTION_LOST_HITS_THRESHOLD, HELD_CANDIDATE_ADOPTION_MAX_LOST_HITS,
  unconfirmedEligibleUpperBound } from './queryOptimizationReviewSections';
import type { OptimizationOutsideCheckState, QueryOptimizationRunState } from '../store';
import type { OptimizationTrial } from '@/features/formula/skills/optimizeQuery';

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
test('回帰1: 保留後に最良候補が回収したシードは標本全件 exclude でも失えない', () => {
  const run = deletionFixture();
  const trial = run.trials[0]!;
  trial.after = { ...run.result!.best!.measurement, capturedPmids: ['1'] };
  run.result!.best!.measurement.capturedPmids = ['1', '999'];
  trial.impact!.lostHits = 200;
  const gate = evaluateHeldCandidateAdoptionGate(trial, run.outsideCheck!.decisions,
    { bestCapturedPmids: run.result!.best!.measurement.capturedPmids });
  expect(gate.allowed).toBe(false);
  expect(gate.reason).toContain('999');
});

test('回帰3: 抽出20件のうち書誌1件だけを exclude にしても採用できない', () => {
  const run = deletionFixture();
  const trial = run.trials[0]!;
  trial.after = run.result!.best!.measurement;
  trial.impact!.lostHits = 200;
  trial.impact!.inspected = [{ pmid: '2', title: '研究', year: 2000 }];
  trial.impact!.sample = { method: 'all', seed: 1, populationCount: 200, retrievedCount: 200,
    pmids: Array.from({ length: 20 }, (_, index) => String(index + 2)), sampledAt: '' };
  const gate = evaluateHeldCandidateAdoptionGate(trial, run.outsideCheck!.decisions,
    { bestCapturedPmids: run.result!.best!.measurement.capturedPmids });
  expect(gate.allowed).toBe(false);
  expect(gate.reason).toContain('書誌');
  expect(gate.reason).toContain('19 件');
  expect(gate.sampledCount).toBe(1);
});

test.each(['best', 'held', 'after'] as const)('捕捉集合が未測定なら比較不能として採用できない: %s', (missing) => {
  const run = deletionFixture();
  const trial = run.trials[0]!;
  if (missing === 'best') run.result!.best!.measurement.capturedPmids = null;
  else if (missing === 'held') trial.after = { ...trial.after!, capturedPmids: null };
  else trial.after = null;
  const gate = evaluateHeldCandidateAdoptionGate(trial, run.outsideCheck!.decisions,
    { bestCapturedPmids: run.result!.best!.measurement.capturedPmids });
  expect(gate.allowed).toBe(false);
  expect(gate.reason).toContain('比較できません');
});
const section = (run: QueryOptimizationRunState, key: string) => buildOptimizationReviewSections(run).sections.find((item) => item.key === key)!;

test.each(['success', 'failure'] as const)('参考注釈 %s は件数だけを表示し、区分と採用ゲートを変えない', (status) => {
  const run = deletionFixture();
  const trial = run.trials[0]!;
  const options = { bestCapturedPmids: run.result!.best!.measurement.capturedPmids };
  const gate = evaluateHeldCandidateAdoptionGate(trial, run.outsideCheck!.decisions, options);
  const state = section(run, 'deletion_impact').state;
  const annotation = { status, annotatedAt: '2026-09-16T00:00:00Z', requestedPmids: ['2', '3', '4', '5'],
    items: [
      { pmid: '2', judgement: 'likely_eligible' as const, reason: '参考理由。' },
      { pmid: '3', judgement: 'unclear' as const, reason: '参考理由。' },
      { pmid: '4', judgement: 'likely_ineligible' as const, reason: '参考理由。' },
    ], error: status === 'failure' ? '期限切れ' : null };
  trial.impact!.annotation = annotation;
  expect(countLostSampleAnnotations(annotation)).toEqual({ likelyEligible: 1, unclear: 1, likelyIneligible: 1, unannotated: 1 });
  expect(evaluateHeldCandidateAdoptionGate(trial, run.outsideCheck!.decisions, options)).toEqual(gate);
  const deletion = section(run, 'deletion_impact');
  expect(deletion.state).toBe(state);
  expect(deletion.lines.join('\n')).toContain(status === 'success'
    ? '標本 4 件中 適格らしい 1 件・判断不能 1 件・非適格らしい 1 件・未注釈 1 件'
    : 'AI の参考注釈を取得できませんでした（期限切れ）。人の判定には影響しません。');
  expect(deletion.lines.join('\n')).not.toContain('参考理由');
});

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
    before: null, after: run.result!.best!.measurement, accepted: false, held: true, rationale: '', reason: '', apiEvents: [],
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

describe('保留候補ごとの採用ゲート（issue #172）', () => {
  test('既定の閾値は 100 件', () => {
    expect(HELD_CANDIDATE_ADOPTION_LOST_HITS_THRESHOLD).toBe(100);
  });

  test('失う集合が閾値以下でも全件確認していなければ押せず、理由に残件数を出す', () => {
    const run = deletionFixture();
    const trial = run.trials[0]!;
    trial.impact!.lostHits = 50; // 取得・判定済みは 2 件のまま。
    const gate = evaluateHeldCandidateAdoptionGate(trial, run.outsideCheck?.decisions, { bestCapturedPmids: run.result!.best!.measurement.capturedPmids });
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain('あと 48 件の確認が必要');
  });

  test('失う集合が閾値以下でも全件取得だけでは押せず、全件 exclude 保存後に押せる', () => {
    const run = deletionFixture();
    const trial = run.trials[0]!;
    trial.impact!.lostHits = 2;
    const decisions = run.outsideCheck!.decisions;
    run.outsideCheck!.decisions = {};
    const gate = evaluateHeldCandidateAdoptionGate(trial, run.outsideCheck?.decisions, { bestCapturedPmids: run.result!.best!.measurement.capturedPmids });
    expect(gate).toEqual({ allowed: false, judgedCount: 0, sampledCount: 2, exceedsMaxLostHits: false,
      reason: expect.stringContaining('あと 2 件の確認が必要') });
    expect(evaluateHeldCandidateAdoptionGate(trial, { '2': decisions['2']! }, { bestCapturedPmids: run.result!.best!.measurement.capturedPmids })).toMatchObject({
      allowed: false, judgedCount: 1, reason: expect.stringContaining('あと 1 件の確認が必要'),
    });
    expect(evaluateHeldCandidateAdoptionGate(trial, decisions, { bestCapturedPmids: run.result!.best!.measurement.capturedPmids })).toEqual({
      allowed: true, judgedCount: 2, sampledCount: 2, exceedsMaxLostHits: false, reason: null,
    });
  });

  describe.each([2, 100, 101])('失う集合 %i 件での判定内容', (lostHits) => {
    test.each(['saved', 'saving', 'error'] as const)('include が 1 件でもあれば保存状態 %s によらず採用できず PMID を示す', (status) => {
      const run = deletionFixture();
      const trial = run.trials[0]!;
      trial.impact!.lostHits = lostHits;
      run.outsideCheck!.decisions['3'] = { decision: 'include', status, error: null };
      expect(evaluateHeldCandidateAdoptionGate(trial, run.outsideCheck?.decisions, { bestCapturedPmids: run.result!.best!.measurement.capturedPmids })).toEqual({
        allowed: false, judgedCount: 1, sampledCount: 2, exceedsMaxLostHits: false, reason: expect.stringContaining('PMID: 3'),
      });
    });

    test('保存済み maybe は未確認として残る', () => {
      const run = deletionFixture();
      const trial = run.trials[0]!;
      trial.impact!.lostHits = lostHits;
      run.outsideCheck!.decisions['3']!.decision = 'maybe';
      const gate = evaluateHeldCandidateAdoptionGate(trial, run.outsideCheck?.decisions, { bestCapturedPmids: run.result!.best!.measurement.capturedPmids });
      expect(gate).toMatchObject({ allowed: false, judgedCount: 1, sampledCount: 2 });
      expect(gate.reason).toContain(lostHits <= 100 ? `あと ${lostHits - 1} 件の確認が必要` : 'あと 1 件の判定が必要');
    });

    test.each(['saving', 'error'] as const)('exclude の保存状態 %s は判定済みに数えない', (status) => {
      const run = deletionFixture();
      const trial = run.trials[0]!;
      trial.impact!.lostHits = lostHits;
      run.outsideCheck!.decisions['3']!.status = status;
      expect(evaluateHeldCandidateAdoptionGate(trial, run.outsideCheck?.decisions, { bestCapturedPmids: run.result!.best!.measurement.capturedPmids })).toMatchObject({
        allowed: false, judgedCount: 1, sampledCount: 2,
      });
    });
  });

  test('失う集合が閾値超過でも、標本を全件判定済みなら押せる（残りは未確認のまま）', () => {
    const run = deletionFixture();
    const trial = run.trials[0]!;
    trial.impact!.lostHits = 200; // 閾値超過。inspected は標本 2 件で全件 exclude 保存済み
    const gate = evaluateHeldCandidateAdoptionGate(trial, run.outsideCheck?.decisions, { bestCapturedPmids: run.result!.best!.measurement.capturedPmids });
    expect(gate).toEqual({ allowed: true, judgedCount: 2, sampledCount: 2, exceedsMaxLostHits: false, reason: null });
  });

  test('失う集合が閾値超過で標本が未判定なら押せず、判定不足・全体未確認の両方を理由に出す', () => {
    const run = deletionFixture();
    const trial = run.trials[0]!;
    trial.impact!.lostHits = 200;
    delete run.outsideCheck!.decisions['3'];
    const gate = evaluateHeldCandidateAdoptionGate(trial, run.outsideCheck?.decisions, { bestCapturedPmids: run.result!.best!.measurement.capturedPmids });
    expect(gate.allowed).toBe(false);
    expect(gate.judgedCount).toBe(1);
    expect(gate.reason).toContain('あと 1 件の判定が必要');
    expect(gate.reason).toContain('残り 199 件が未確認');
  });

  test('差集合が未測定・失敗のときは押せない', () => {
    const run = deletionFixture();
    const trial = run.trials[0]!;
    trial.impact!.lostHits = null;
    expect(evaluateHeldCandidateAdoptionGate(trial, run.outsideCheck?.decisions, { bestCapturedPmids: run.result!.best!.measurement.capturedPmids }).allowed).toBe(false);
    trial.impact = { lostHits: 5, gainedHits: 0, inspected: [], error: '差集合の測定失敗' };
    expect(evaluateHeldCandidateAdoptionGate(trial, run.outsideCheck?.decisions, { bestCapturedPmids: run.result!.best!.measurement.capturedPmids }).allowed).toBe(false);
  });

  test('held でない試行は常に押せない（失う集合が閾値以下で全件確認済みでも）', () => {
    const run = deletionFixture();
    const trial = { ...run.trials[0]!, held: false };
    expect(evaluateHeldCandidateAdoptionGate(trial, run.outsideCheck?.decisions, { bestCapturedPmids: run.result!.best!.measurement.capturedPmids }).allowed).toBe(false);
  });

  test('既存の deletion.state（4 区分の判定）はゲートの影響を受けない', () => {
    const run = deletionFixture();
    // 判定はすべて exclude 保存済みのまま、失う集合だけ標本を超える件数にする。
    // #165 のロジック（inspected.length >= lostHits を全保留候補で満たすことを要求）が
    // そのまま働き、ゲート（このテストでは標本を全件判定済みなので押せる）とは独立に
    // 「decided（残件あり）」になる。
    run.trials[0]!.impact!.lostHits = 200;
    const gate = evaluateHeldCandidateAdoptionGate(run.trials[0]!, run.outsideCheck?.decisions, { bestCapturedPmids: run.result!.best!.measurement.capturedPmids });
    expect(gate.allowed).toBe(true);
    expect(section(run, 'deletion_impact').state).toBe('decided');
  });
});

describe('保留候補ごとの採用不可上限（issue #172）', () => {
  test('既定の上限は 1,000 件', () => {
    expect(HELD_CANDIDATE_ADOPTION_MAX_LOST_HITS).toBe(1000);
  });

  test('失う 1,001 件は標本を全件 exclude 保存済みでも採用できない', () => {
    const run = deletionFixture();
    const trial = run.trials[0]!;
    trial.impact!.lostHits = 1001;
    const gate = evaluateHeldCandidateAdoptionGate(trial, run.outsideCheck!.decisions,
      { bestCapturedPmids: run.result!.best!.measurement.capturedPmids });
    expect(gate.allowed).toBe(false);
    expect(gate.exceedsMaxLostHits).toBe(true);
    expect(gate.reason).toContain('1,001');
    expect(gate.reason).toContain('1,000');
  });

  test('失う 1,000 件ちょうどは標本を全件 exclude 保存済みなら採用できる', () => {
    const run = deletionFixture();
    const trial = run.trials[0]!;
    trial.impact!.lostHits = 1000;
    const gate = evaluateHeldCandidateAdoptionGate(trial, run.outsideCheck!.decisions,
      { bestCapturedPmids: run.result!.best!.measurement.capturedPmids });
    expect(gate.allowed).toBe(true);
    expect(gate.exceedsMaxLostHits).toBe(false);
  });

  test('include の判定があっても、失う 1,001 件なら件数上限の理由が優先して返る', () => {
    const run = deletionFixture();
    const trial = run.trials[0]!;
    trial.impact!.lostHits = 1001;
    run.outsideCheck!.decisions['3'] = { decision: 'include', status: 'saved', error: null };
    const gate = evaluateHeldCandidateAdoptionGate(trial, run.outsideCheck!.decisions,
      { bestCapturedPmids: run.result!.best!.measurement.capturedPmids });
    expect(gate.allowed).toBe(false);
    expect(gate.exceedsMaxLostHits).toBe(true);
    expect(gate.reason).not.toContain('PMID: 3');
  });
});

describe('否定できない適格文献の上限（issue #172）', () => {
  test.each([
    [10800, 20, 1501],
    [150, 20, 19],
    [1000, 20, 137],
    [566, 20, 77],
    [100, 100, 0],
    [5, 0, null],
    [106, 20, 13],
    [21, 20, 0],
    [200, 2, 154],
  ] as const)('lostHits=%i, sampleSize=%i => %s', (lostHits, sampleSize, expected) => {
    expect(unconfirmedEligibleUpperBound(lostHits, sampleSize)).toBe(expected);
  });

  function heldTrial(overrides: Partial<OptimizationTrial> = {}): OptimizationTrial {
    return { kind: 'proposal', candidateId: 'candidate-1', formula: fixture().result!.best!.formula,
      before: null, after: null, accepted: false, held: true, rationale: '', reason: '', apiEvents: [],
      impact: { lostHits: 150, gainedHits: 0, error: null,
        inspected: Array.from({ length: 20 }, (_, i) => ({ pmid: String(i + 2), title: null, year: null })),
        sample: { method: 'all', seed: 1, populationCount: 150, retrievedCount: 150,
          pmids: Array.from({ length: 20 }, (_, i) => String(i + 2)), sampledAt: '' } },
      ...overrides };
  }

  test('通常の抽出（method: all）は件数と上限を文で示す', () => {
    const text = formatUnconfirmedEligibleUpperBound(heldTrial());
    expect(text).toBe('標本 20 件をすべて exclude と判定しても、残り 130 件に適格文献が最大 19 件（片側 95% 上限）含まれる可能性を否定できません。');
  });

  test('retrieved_subset は集合全体の上限ではない旨を追記する', () => {
    const trial = heldTrial({ impact: { lostHits: 150, gainedHits: 0, error: null,
      inspected: Array.from({ length: 20 }, (_, i) => ({ pmid: String(i + 2), title: null, year: null })),
      sample: { method: 'retrieved_subset', seed: 1, populationCount: 150, retrievedCount: 100,
        pmids: Array.from({ length: 20 }, (_, i) => String(i + 2)), sampledAt: '' } } });
    const text = formatUnconfirmedEligibleUpperBound(trial);
    expect(text).toContain('標本 20 件をすべて exclude と判定しても');
    expect(text).toContain('（取得できた 100 件からの抽出のため、集合全体に対する上限ではありません）');
  });

  test('標本が失う集合以上（上限 0 件）なら null', () => {
    const trial = heldTrial({ impact: { lostHits: 20, gainedHits: 0, error: null,
      inspected: Array.from({ length: 20 }, (_, i) => ({ pmid: String(i + 2), title: null, year: null })) } });
    expect(formatUnconfirmedEligibleUpperBound(trial)).toBeNull();
  });

  test('lostHits が未測定（null）なら null', () => {
    const trial = heldTrial({ impact: { lostHits: null, gainedHits: 0, error: null, inspected: [] } });
    expect(formatUnconfirmedEligibleUpperBound(trial)).toBeNull();
  });
});

test('削除影響の確認区分に上限の行が出て、deletion.state は上限の有無で変わらない', () => {
  const run = deletionFixture();
  const trial = run.trials[0]!;
  trial.impact!.lostHits = 150;
  trial.impact!.inspected = Array.from({ length: 20 }, (_, i) => ({ pmid: String(i + 2), title: null, year: null }));
  trial.impact!.sample = { method: 'all', seed: 1, populationCount: 150, retrievedCount: 150,
    pmids: Array.from({ length: 20 }, (_, i) => String(i + 2)), sampledAt: '' };
  run.outsideCheck!.candidates = trial.impact!.inspected.map((paper) => ({
    pmid: paper.pmid, title: null, year: null, abstract: null, source: 'lost' as const, heldCandidateId: 'candidate-1', reason: '' }));
  run.outsideCheck!.decisions = Object.fromEntries(trial.impact!.inspected.map((paper) =>
    [paper.pmid, { decision: 'exclude' as const, status: 'saved' as const, error: null }]));
  const withBound = buildOptimizationReviewSections(run);
  expect(withBound.sections[3]!.state).toBe('decided');
  expect(withBound.sections[3]!.lines.join('\n')).toContain('標本 20 件をすべて exclude と判定しても');
  // sample.pmids（抽出母集団）を lostHits と同数まで広げると上限は 0 になり表示されなくなるが、
  // state の判定は inspected.length（20 件固定）を使うため変わらない。
  trial.impact!.sample!.pmids = Array.from({ length: 150 }, (_, i) => String(i + 2));
  const withoutBound = buildOptimizationReviewSections(run);
  expect(withoutBound.sections[3]!.lines.join('\n')).not.toContain('片側 95% 上限');
  expect(withoutBound.sections[3]!.state).toBe('decided');
});

test.each([false, true])('中間手の採用は既知文献の捕捉区分に残し、最終結果の捕捉状態を維持する: 回収済み=%s', (recovered) => {
  const run = fixture();
  const best = run.result!.best!;
  best.evaluation.seedPmids = ['1', '2'];
  best.evaluation.finalQuery.capturedPmids = recovered ? ['1', '2'] : ['1'];
  best.evaluation.finalQuery.missedPmids = recovered ? [] : ['2'];
  const reason = 'ブロック #1 のシード捕捉が 1 件から 2 件に増えました（最終式の捕捉数は変わらない中間手を採用）';
  const intermediate = { kind: 'proposal' as const, candidateId: 'candidate-1', formula: best.formula,
    before: { ...best.measurement, capturedPmids: ['1'], missedPmids: ['2'] },
    after: { ...best.measurement, capturedPmids: ['1'], missedPmids: ['2'] },
    accepted: true, reason, rationale: '', apiEvents: [] };
  run.trials = [intermediate, { ...intermediate, candidateId: 'rejected', accepted: false },
    { ...intermediate, candidateId: 'recovered', after: { ...intermediate.after, capturedPmids: ['1', '2'], missedPmids: [] } }];
  const review = buildOptimizationReviewSections(run);
  expect(review.sections).toHaveLength(4);
  expect(review.sections[0].state).toBe(recovered ? 'confirmed' : 'unmet');
  expect(review.sections[0].lines.filter((line) => line.startsWith('中間手'))).toEqual([`中間手 candidate-1: ${reason}`]);
  expect(review.sections.slice(1).every((item) => item.lines.every((line) => !line.includes('中間手')))).toBe(true);
});


test.each(['lost_search', 'lost_fetch', 'gained_search'] as const)('採用ゲートは失敗した通信 %s を区別する', (measurement) => {
  const run = deletionFixture();
  const trial = run.trials[0]!;
  trial.impact!.lostHits = 2;
  trial.impact!.error = '通信失敗';
  trial.impact!.failedMeasurements = [measurement];
  const gate = evaluateHeldCandidateAdoptionGate(trial, run.outsideCheck!.decisions, { bestCapturedPmids: run.result!.best!.measurement.capturedPmids });
  expect(gate.allowed).toBe(measurement === 'gained_search');
  if (measurement === 'lost_fetch') expect(gate.reason).toContain('書誌を取得');
  if (measurement === 'lost_search') expect(gate.reason).toContain('失う集合を実測');
});
