/** @jest-environment node */
import { aggregateVersion, scoreSubmission, type SubmissionOutcome } from './metrics';
import { pmids, review } from './testFixtures';

const score = (outcome: SubmissionOutcome) => scoreSubmission(review().studies, pmids, outcome);
test('全捕捉と共有 PMID を数え、重複 PMID は一度だけ数える', () => {
  expect(score({ status: 'measured', hits: 4, capturedPmids: [...pmids, pmids[0]!] })).toMatchObject({ studyRecall: 1,
    pmidRecall: 1, allCaptured: true, missedStudies: 0, precision: 1, f7: 1, failed: false });
  expect(score({ status: 'measured', hits: 10, capturedPmids: [pmids[0]!] })).toMatchObject({ studyRecall: 0.5, pmidRecall: 0.25, missedStudies: 2 });
});
test('F7 の2例を研究単位の再現率から計算する', () => {
  const one = [{ id: '合成研究', pmids: [pmids[0]!] }];
  const full = scoreSubmission(one, [pmids[0]!], { status: 'measured', hits: 200, capturedPmids: [pmids[0]!] });
  const half = score({ status: 'measured', hits: 100, capturedPmids: [pmids[0]!] });
  if (full.status !== 'scored' || half.status !== 'scored') throw new Error('採点されていません');
  expect(full.f7).toBeCloseTo(50 * 0.005 / (49 * 0.005 + 1), 12);
  expect(full.f7).toBeCloseTo(0.200803212851, 10);
  expect(half.f7).toBeCloseTo(50 * 0.01 * 0.5 / (49 * 0.01 + 0.5), 12);
  expect(half.f7).toBeCloseTo(0.252525252525, 10);
});
test.each<SubmissionOutcome>([{ status: 'invalid_submission', reason: '括弧不正' }, { status: 'no_submission' },
  { status: 'measured', hits: 0, capturedPmids: [] }])('提出失敗と0件は分母に残す: %j', (outcome) => {
  expect(score(outcome)).toEqual({ status: 'scored', hits: 0, studyRecall: 0, pmidRecall: 0, missedStudies: 4,
    allCaptured: false, precision: 0, f7: 0, failed: true, failure: outcome.status === 'measured' ? 'zero_hits' : outcome.status });
});
test('通信失敗は数値を持たず、未知の捕捉と件数超過は拒否する', () => {
  expect(score({ status: 'measurement_failed', error: '合成通信失敗' })).toEqual({ status: 'unknown', error: '合成通信失敗' });
  for (const outcome of [{ hits: 1, capturedPmids: ['00000099'] }, { hits: 1, capturedPmids: pmids },
    { hits: 0, capturedPmids: [pmids[0]!] }, { hits: -1, capturedPmids: [] }]) {
    expect(() => score({ status: 'measured', ...outcome })).toThrow();
  }
  expect(score({ status: 'measured', hits: 10, capturedPmids: [] })).toMatchObject({ f7: 0, failed: false });
});
test('レビュー内平均を先に取り、成功 run の平均件数の中央値とティア別を返す', () => {
  const full = score({ status: 'measured', hits: 100, capturedPmids: pmids });
  const failed = score({ status: 'no_submission' });
  const summary = aggregateVersion([
    { pmcid: 'PMC0000001', tier: 'cc-by', runs: [full, failed, failed, failed] },
    { pmcid: 'PMC0000002', tier: 'cc-by-nc', runs: [score({ status: 'measured', hits: 20, capturedPmids: pmids }), full] },
    { pmcid: 'PMC0000003', tier: 'cc-by-nc', runs: [failed] },
  ]);
  expect(summary).toMatchObject({ reviews: 3, studyRecall: 1.25 / 3, pmidRecall: 1.25 / 3, allCapturedRate: 1.25 / 3,
    failureRate: 1.75 / 3, missedStudies: 7, medianHits: 80, reviewsWithoutSuccessfulRuns: 1 });
  expect(summary.tiers['cc-by'].studyRecall).toBe(0.25);
  expect(summary.tiers['cc-by-nc'].studyRecall).toBe(0.5);
});
test('未確定と空 run は拒否し、空ティアの平均は null にする', () => {
  expect(() => aggregateVersion([{ pmcid: 'PMC0000001', tier: 'cc-by', runs: [score({ status: 'measurement_failed', error: '不明' })] }])).toThrow('1 件');
  expect(() => aggregateVersion([{ pmcid: 'PMC0000001', tier: 'cc-by', runs: [] }])).toThrow('空');
  expect(aggregateVersion([])).toMatchObject({ reviews: 0, studyRecall: null, medianHits: null });
});

test('失敗の内訳もレビュー内平均の合計として数える', () => {
  const zero = score({ status: 'measured', hits: 0, capturedPmids: [] });
  const invalid = score({ status: 'invalid_submission', reason: '合成拒否' });
  const absent = score({ status: 'no_submission' });
  const summary = aggregateVersion([{ pmcid: 'PMC0000001', tier: 'cc-by', runs: [zero, invalid, absent, absent] },
    { pmcid: 'PMC0000002', tier: 'cc-by-nc', runs: [zero] }]);
  expect(summary.failures).toEqual({ zeroHits: 1.25, invalidSubmission: 0.25, noSubmission: 0.5 });
  expect(summary.tiers['cc-by'].failures).toEqual({ zeroHits: 0.25, invalidSubmission: 0.25, noSubmission: 0.5 });
});
