import { calculateMetrics, compareMetrics } from './metrics';
import type { StudyGroup } from './types';

const groups: StudyGroup[] = [
  { id: 'seed', members: [{ studyId: 'seed', pmids: ['1'] }], pmids: ['1'] },
  { id: 'alpha + beta', members: [{ studyId: 'alpha', pmids: ['2', '3'] }, { studyId: 'beta', pmids: ['3'] }], pmids: ['2', '3'] },
  { id: 'gamma', members: [{ studyId: 'gamma', pmids: ['4'] }], pmids: ['4'] },
];
const heldOut = ['alpha + beta', 'gamma'];
const measure = (ids: string[], hits: number) => calculateMetrics(groups, heldOut, ids, hits);

test('捕捉報告は gold の重複を除き PMID の数値昇順で保存する', () => {
  const pmids = ['100', '2', '10', '2'];
  const gold = [{ id: '研究', pmids, members: [{ studyId: '研究', pmids }] }];
  expect(calculateMetrics(gold, ['研究'], ['100', '10', '2', '999'], 20).capturedReports).toEqual(['2', '10', '100']);
});

test('報告の損失と獲得を数値昇順で比較し、研究単位の判定は維持する', () => {
  const before = { ...measure(['2', '3'], 20), capturedReports: ['100', '2', '10', '3'] };
  const after = { ...measure(['3'], 10), capturedReports: ['30', '4', '3'] };
  expect(compareMetrics(before, after)).toMatchObject({ lostReports: ['2', '10', '100'], gainedReports: ['4', '30'],
    lostHeldOut: [], improved: true, outcome: 'improved' });
  expect(compareMetrics(measure([], 0), measure([], 0))).toMatchObject({ lostReports: [], gainedReports: [] });
});

test.each(['before', 'after', 'both'])('報告の捕捉記録が欠けると両方の差分が欠測になる: %s', (side) => {
  const before = measure(['2'], 10); const after = measure(['3'], 10);
  if (side !== 'after') delete before.capturedReports;
  if (side !== 'before') delete after.capturedReports;
  expect(compareMetrics(before, after)).toMatchObject({ lostReports: null, gainedReports: null });
});

test('関連報告は重複除去し、各研究は所属報告 1 件以上の捕捉で数える', () => {
  expect(measure(['1', '2', '3', '3', '999'], 10)).toEqual({
    heldOutRecall: 2 / 3, allStudyRecall: 3 / 4, hits: 10,
    capturedStudies: ['seed', 'alpha', 'beta'], capturedHeldOut: ['alpha', 'beta'],
    capturedReports: ['1', '2', '3'],
    knownIncludedReportShare: 0.3, recordsPerKnownIncludedStudy: 10 / 3,
  });
});
test('0 件と捕捉 0 件を区別し、分母 0 は null', () => {
  expect(measure([], 0)).toMatchObject({ heldOutRecall: 0, knownIncludedReportShare: null, recordsPerKnownIncludedStudy: null });
  expect(measure([], 20)).toMatchObject({ heldOutRecall: 0, knownIncludedReportShare: 0, recordsPerKnownIncludedStudy: null });
  expect(calculateMetrics([], [], [], 0)).toMatchObject({ heldOutRecall: null, allStudyRecall: null });
});
test('held-out を失わず増加または hits 減少なら改善', () => {
  expect(compareMetrics(measure(['2'], 10), measure(['2', '4'], 20))).toMatchObject({ improved: true, gainedStudies: ['gamma'] });
  expect(compareMetrics(measure(['2'], 10), measure(['2'], 9)).improved).toBe(true);
  expect(compareMetrics(measure(['2'], 10), measure(['2'], 10)).outcome).toBe('unchanged');
});
test('件数減少と捕捉喪失は tradeoff、群数だけで置換を改善にしない', () => {
  expect(compareMetrics(measure(['2'], 10), measure(['4'], 9))).toMatchObject({ improved: false, outcome: 'tradeoff', lostStudies: ['alpha'], gainedStudies: ['gamma'] });
  expect(compareMetrics(measure(['2'], 10), measure([], 10)).outcome).toBe('worse');
  expect(compareMetrics(measure([], 10), measure(['1'], 10)).improved).toBe(false);
});
test('不正な件数は計測値として扱わない', () => {
  expect(() => measure([], -1)).toThrow();
  expect(() => measure(['2'], 0)).toThrow();
});


test('unique reports capture only their study; a shared report captures both studies', () => {
  expect(measure(['2'], 10)).toMatchObject({ capturedStudies: ['alpha'], capturedHeldOut: ['alpha'], heldOutRecall: 1 / 3, allStudyRecall: 1 / 4 });
  expect(measure(['3'], 10)).toMatchObject({ capturedStudies: ['alpha', 'beta'], heldOutRecall: 2 / 3, recordsPerKnownIncludedStudy: 5 });
  expect(compareMetrics(measure(['3'], 10), measure(['2'], 9))).toMatchObject({ lostStudies: ['beta'], lostHeldOut: ['beta'], outcome: 'tradeoff' });
  expect(compareMetrics(measure(['2'], 10), measure(['3'], 10))).toMatchObject({ gainedStudies: ['beta'], gainedHeldOut: ['beta'] });
});
