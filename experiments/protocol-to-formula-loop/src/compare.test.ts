/** @jest-environment node */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { comparePaired, main, parseCompareOptions } from './compare';
import type { ReviewRuns, ScoredRun } from './metrics';
import type { RunRuntime } from './startRuns';
import { fixture, record, review, writeJson, writeLines } from './testFixtures';
import { splitReviews } from './split';

const score = (recall = 1, hits = 100, extra: Partial<ScoredRun> = {}): ScoredRun => ({ status: 'scored', hits,
  studyRecall: recall, pmidRecall: recall, missedStudies: (1 - recall) * 10, allCaptured: recall === 1,
  precision: 0, f7: 0, failed: false, failure: null, ...extra });
const row = (index: number, runs: ScoredRun[], tier: ReviewRuns['tier'] = 'cc-by'): ReviewRuns => ({ pmcid: review(index).pmcid, tier, runs });
const compare = (base: ReviewRuns[], candidate: ReviewRuns[]) => comparePaired(base, candidate, { resamples: 200, seed: 7 });

test('全捕捉で絞らない件数比の中央値を全体とティア別に示す', () => {
  const base = [row(1, [score(0.5, 100)]), row(2, [score(1, 200)]), row(3, [score(0.5, 100)], 'cc-by-nc')];
  const candidate = [row(1, [score(0.5, 50)]), row(2, [score(1, 400)]), row(3, [score(0.5, 100)], 'cc-by-nc')];
  const result = compare(base, candidate);
  expect(result.hitsRatioAll).toEqual({ reviews: 3, median: 1 });
  expect(result.tiers['cc-by'].hitsRatioAll).toEqual({ reviews: 2, median: 1.25 });
  expect(result.tiers['cc-by-nc'].hitsRatioAll).toEqual({ reviews: 1, median: 1 });
  expect(result.hitsRatio).toMatchObject({ reviews: 1, ratio: 2 });
  const failed = [row(1, [score(0, 0, { failed: true, failure: 'zero_hits' })])];
  expect(compare(failed, failed).hitsRatioAll).toEqual({ reviews: 0, median: null });
  expect(compare(base.slice(0, 1), failed).hitsRatioAll).toEqual({ reviews: 0, median: null });
  expect(compare([row(1, [score(0.5, 0)])], [row(1, [score(0.5, 10)])]).hitsRatioAll).toEqual({ reviews: 0, median: null });
});

test('レビュー内の平均を先に取り、失敗を件数から除き、レビューを等しく重み付けする', () => {
  const base = [row(1, [score(1, 100), score(0, 0, { failed: true, failure: 'zero_hits' })]), row(2, [score(1, 400)])];
  const candidate = [row(2, [score(1, 200)]), row(1, [score(1, 80), score(1, 120)])];
  const result = compare(base, candidate);
  expect(result.allCapturedRate).toEqual({ base: 0.75, candidate: 1, difference: 0.25 });
  expect(result.studyRecall.base).toBe(0.75);
  expect(result.missedStudies.base).toBe(5);
  expect(result.failureRate.base).toBe(0.25);
  expect(result.medianHits).toEqual({ base: 250, candidate: 150 });
  expect(result.hitsRatio.reviews).toBe(1);
  expect(result.hitsRatio.ratio).toBeCloseTo(0.5);
});

test('件数の比はレビュー内平均どうしの比の幾何平均を使う', () => {
  const result = compare([row(1, [score(1, 10), score(1, 30)]), row(2, [score(1, 100)])],
    [row(1, [score(1, 10), score(1, 10)]), row(2, [score(1, 25)])]);
  expect(result.hitsRatio.reviews).toBe(2);
  expect(result.hitsRatio.ratio).toBeCloseTo(Math.sqrt(0.5 * 0.25));
});

test('集合の不一致・空・未確定・重複・対応条件の不一致を拒否する', () => {
  const valid = [row(1, [score()])];
  expect(() => compare(valid, [row(2, [score()])])).toThrow('集合');
  expect(() => compare([], valid)).toThrow('空');
  expect(() => compare(valid, [])).toThrow('空');
  expect(() => compare(valid, [row(1, [])])).toThrow('run が空');
  const unknown: ReviewRuns[] = [{ ...valid[0]!, runs: [{ status: 'unknown', error: '合成の不明' }] }];
  expect(() => compare(unknown, valid)).toThrow('未確定');
  expect(() => compare(valid, unknown)).toThrow('未確定');
  expect(() => compare([...valid, ...valid], [...valid, ...valid])).toThrow('重複');
  expect(() => compare(valid, [row(1, [score()], 'cc-by-nc')])).toThrow('ティア');
  expect(() => compare(valid, [row(1, [score(), score()])])).toThrow('実行数');
  expect(() => comparePaired(valid, valid, { resamples: 0 })).toThrow('再抽出');
});

test('同じ種では同じ区間になり、異なる種では区間が変わる', () => {
  const base = Array.from({ length: 17 }, (_, i) => row(i + 1, [score(0.1)]));
  const candidate = base.map((r, i) => ({ ...r, runs: [score(0.12 + i * i / 400)] }));
  const first = comparePaired(base, candidate, { resamples: 151, seed: 1 });
  expect(comparePaired(base, candidate, { resamples: 151, seed: 1 })).toEqual(first);
  expect(comparePaired(base, candidate, { resamples: 151, seed: 2 }).studyRecall.confidenceInterval)
    .not.toEqual(first.studyRecall.confidenceInterval);
  expect(comparePaired([...base].reverse(), [...candidate].reverse(), { resamples: 151, seed: 1 })).toEqual(first);
});

test('差が一定なら区間もその差になり、件数の対数区間を比に戻す', () => {
  const recall = compare([row(1, [score(0.25)]), row(2, [score(0.5)])], [row(1, [score(0.5)]), row(2, [score(0.75)])]);
  expect(recall.studyRecall.confidenceInterval).toEqual([0.25, 0.25]);
  const hits = compare([row(1, [score(1, 100)]), row(2, [score(1, 200)])], [row(1, [score(1, 50)]), row(2, [score(1, 100)])]);
  expect(hits.hitsRatio.confidenceInterval![0]).toBeCloseTo(0.5);
  expect(hits.hitsRatio.confidenceInterval![1]).toBeCloseTo(0.5);
});

test.each(['再現率', '件数'])('%sの改善で採用になり両ティアの結果を持つ', (metric) => {
  const base = [row(1, [score(metric === '再現率' ? 0.5 : 1)]), row(2, [score(metric === '再現率' ? 0.5 : 1)], 'cc-by-nc')];
  const candidate = base.map((r) => ({ ...r, runs: [score(1, 50)] }));
  const result = compare(base, candidate);
  expect(result.verdict).toBe('adopt');
  expect(result.improvedBy).toEqual([metric === '再現率' ? 'recall' : 'hits']);
  expect(result.reasons.length).toBeGreaterThan(0);
  expect(result.tiers['cc-by-nc'].reviews).toBe(1);
});

test.each([
  { label: '全捕捉', change: { allCaptured: false }, condition: 'allCapturedNonDecreasing' },
  { label: '平均再現率', change: { studyRecall: 0.9 }, condition: 'recallNonDecreasing' },
  { label: '取りこぼし', change: { missedStudies: 1 }, condition: 'missedStudiesNonIncreasing' },
  { label: '失敗率', change: { failed: true, failure: 'no_submission' as const }, condition: 'failureNonIncreasing' },
])('$labelだけの悪化でも拒否し理由を残す', ({ label, change, condition }) => {
  // 各条件を独立に検証するため、一つの採点欄だけを変える合成値。
  const base = [row(1, [score()]), row(2, [score()])];
  const candidate = [row(1, [score(1, 50, change)]), row(2, [score(1, 50)])];
  const result = compare(base, candidate);
  expect(result.verdict).toBe('reject');
  expect(result.conditions).toMatchObject({ [condition]: false });
  expect(result.reasons.join('\n')).toContain(label);
  const nonWorsening = ['allCapturedNonDecreasing', 'recallNonDecreasing', 'missedStudiesNonIncreasing', 'failureNonIncreasing'] as const;
  for (const key of nonWorsening) if (key !== condition) expect(result.conditions[key]).toBe(true);
  expect(result.conditions.hitsImproved).toBe(true);
});

test('改善がなければ拒否し、全不達や全失敗では件数の比を計算しない', () => {
  const rows = [row(1, [score(0.5)]), row(2, [score(0, 0, { failed: true, failure: 'zero_hits' })])];
  const result = compare(rows, rows);
  expect(result.verdict).toBe('reject');
  expect(result.reasons.join()).toContain('改善条件');
  expect(result.hitsRatio).toEqual({ reviews: 0, ratio: null, confidenceInterval: null });
  expect(result.medianHits.base).toBe(100);
  expect(compare(rows.slice(1), rows.slice(1)).medianHits.base).toBeNull();
});

test('再現率の改善の根拠がティアで逆向きなら拒否する', () => {
  const base = Array.from({ length: 20 }, (_, i) => row(i + 1, [score(0.4)], i === 0 ? 'cc-by-nc' : 'cc-by'));
  const candidate = base.map((r, i) => ({ ...r, runs: [score(i === 0 ? 0.3 : 0.8)] }));
  const result = compare(base, candidate);
  expect(result.conditions.recallImproved).toBe(true);
  expect(result.verdict).toBe('reject');
  expect(result.reasons.join()).toContain('cc-by-nc の再現率の向きが全体と一致しません');
});

test('件数の改善の根拠がティアで逆向きなら拒否する', () => {
  const base = Array.from({ length: 20 }, (_, i) => row(i + 1, [score()], i === 0 ? 'cc-by-nc' : 'cc-by'));
  const candidate = base.map((r, i) => ({ ...r, runs: [score(1, i === 0 ? 110 : 50)] }));
  const result = compare(base, candidate);
  expect(result.conditions.hitsImproved).toBe(true);
  expect(result.verdict).toBe('reject');
  expect(result.reasons.join()).toContain('cc-by-nc の件数の向きが全体と一致しません');
});

test.each(['再現率', '件数'])('両方の改善条件を満たすとき%s側だけの方向一致でも採用する', (consistent) => {
  const base = Array.from({ length: 40 }, (_, i) => row(i + 1, [score(i < 20 ? 0.4 : 1)], i === 0 || i === 20 ? 'cc-by-nc' : 'cc-by'));
  const candidate = base.map((r, i) => ({ ...r, runs: [i < 20 ? score(i === 0 && consistent === '件数' ? 0.3 : 0.8)
    : score(1, i === 20 && consistent === '再現率' ? 110 : 50)] }));
  const result = compare(base, candidate);
  expect(result.improvedBy).toEqual(['recall', 'hits']);
  expect(result.verdict).toBe('adopt');
  expect(result.conditions.tierDirectionConsistent).toBe(true);
});

test.each(['再現率', '件数'])('%sのティアが差なしでも対象なしでも採用を妨げない', (metric) => {
  const base = Array.from({ length: 20 }, (_, i) => row(i + 1, [score(metric === '再現率' ? 0.5 : 1)], i === 0 ? 'cc-by-nc' : 'cc-by'));
  const candidate = base.map((r, i) => ({ ...r, runs: [i === 0 ? r.runs[0]! : score(1, 50)] }));
  for (const [b, c] of [[base, candidate], [base.slice(1), candidate.slice(1)]]) {
    const result = compare(b!, c!);
    expect(result.verdict).toBe('adopt');
    expect(result.reasons.join()).toContain('判定不能');
  }
});

test('丸め誤差だけの差を悪化と数えない', () => {
  const base = [row(1, [score()])];
  const candidate = [row(1, [score(1, 50, { studyRecall: 1 - 5e-13, missedStudies: 5e-13 })])];
  const result = compare(base, candidate);
  expect(result.verdict).toBe('adopt');
  expect(result.conditions.recallAndMissedNonWorsening).toBe(true);
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'p2f-compare-'));
  const rows = Array.from({ length: 10 }, (_, i) => review(i + 1));
  fixture(root, rows);
  const casesDir = join(root, 'cases');
  writeLines(join(casesDir, 'evaluable.jsonl'), rows.map((r) => record(r)));
  const selected = rows.find((r) => splitReviews(rows).get(r.pmcid) === 'development')!;
  writeJson(join(casesDir, 'subsets.json'), { smoke: [selected.pmcid], fixed: [selected.pmcid] });
  const runtime: RunRuntime = { casesDir, reportsDir: join(root, 'reports'), env: { COCHRANE_BENCH_DIR: root },
    now: () => new Date('2026-01-03T00:00:00Z'), stdout: jest.fn(), stderr: jest.fn(), sleep: async () => undefined,
    fetchImpl: jest.fn(async () => { throw new Error('想定外の通信'); }) };
  const path = (version: string, i = 1) => join(root, 'runs', version, selected.pmcid, `run-${i}`, 'score.json');
  const args = ['--runs', join(root, 'runs'), '--base', 'v0', '--candidate', 'v1', '--subset', 'smoke', '--runs-per-review', '2'];
  const save = (dates = ['2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z']) => {
    for (const version of ['v0', 'v1']) for (let i = 1; i <= 2; i++) {
      const dir = dirname(path(version, i));
      const submission = { number: 1, query: 'a[tiab]' };
      writeJson(join(dir, 'submission.json'), submission);
      writeLines(join(dir, 'tool-log.jsonl'), [{ command: 'submit' }]);
      writeJson(path(version, i), { ...score(1, version === 'v0' ? 100 : 50), measuredAt: dates[i - 1],
        submission: { number: submission.number, querySha256: createHash('sha256').update(submission.query).digest('hex') }, submitAttempts: 1 });
    }
  };
  return { runtime, args, path, save, selected };
}

test('採点ファイルの不足と未確定の件数を出し、試験群を保護する', () => {
  const s = setup();
  expect(() => main(s.args, s.runtime)).toThrow('不足 4 件');
  s.save();
  writeJson(s.path('v1'), { status: 'unknown', error: '合成の不明' });
  expect(() => main(s.args, s.runtime)).toThrow('未採点 1 件');
  writeFileSync(s.path('v0'), '{合成の破損');
  writeJson(s.path('v0', 2), null);
  expect(() => main(s.args, s.runtime)).toThrow('未採点 3 件');
  const args = s.args.map((value) => value === 'smoke' ? 'test' : value);
  expect(() => main(args, s.runtime)).toThrow('--open-test-set');
  expect(parseCompareOptions([...args, '--open-test-set']).openTestSet).toBe(true);
  expect(s.runtime.fetchImpl).not.toHaveBeenCalled();
});

test.each([
  { label: '別の式', number: 1, query: 'b[tiab]' },
  { label: '別の提出番号', number: 2, query: 'a[tiab]' },
])('採点後に$labelが提出された実行は未採点として比較を止める', ({ number, query }) => {
  const s = setup(); s.save();
  writeJson(join(dirname(s.path('v1')), 'submission.json'), { number, query });
  expect(() => main(s.args, s.runtime)).toThrow('採点記録の不足 0 件、未採点 1 件、測定日不正 0 件');
  expect(existsSync(s.runtime.reportsDir!)).toBe(false);
  expect(s.runtime.stdout).not.toHaveBeenCalled();
  expect(s.runtime.fetchImpl).not.toHaveBeenCalled();
});

test('採点後に提出試行数が増えた実行は未採点として比較を止める', () => {
  const s = setup(); s.save();
  writeLines(join(dirname(s.path('v0')), 'tool-log.jsonl'), [{ command: 'submit' }, { command: 'submit' }]);
  expect(() => main(s.args, s.runtime)).toThrow('未採点 1 件');
  expect(existsSync(s.runtime.reportsDir!)).toBe(false);
});

test.each(['submission', 'submitAttempts'])('採点記録に%sがない旧形式は未採点として比較を止める', (field) => {
  const s = setup(); s.save();
  const saved = JSON.parse(readFileSync(s.path('v1'), 'utf8'));
  delete saved[field];
  writeJson(s.path('v1'), saved);
  expect(() => main(s.args, s.runtime)).toThrow('未採点 1 件');
  expect(existsSync(s.runtime.reportsDir!)).toBe(false);
});

test('提出番号・式・試行数が採点時と同じなら比較できる', () => {
  const s = setup(); s.save();
  expect(main(s.args, s.runtime)).toBe(0);
  const report = JSON.parse(readFileSync(join(s.runtime.reportsDir!, 'compare-v0-v1-smoke.json'), 'utf8'));
  expect(report.comparison.verdict).toBe('adopt');
  expect(s.runtime.fetchImpl).not.toHaveBeenCalled();
});

test.each([
  { dates: ['2026-01-01T00:00:00Z', '2026-01-02T01:00:00+09:00'], sameDay: true },
  { dates: ['2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'], sameDay: false },
])('UTC の測定日を集計し、同日=$sameDay の警告と匿名のレポートを出す', ({ dates, sameDay }) => {
  const s = setup(); s.save(dates);
  expect(main(s.args, s.runtime)).toBe(0);
  const reportText = readFileSync(join(s.runtime.reportsDir!, 'compare-v0-v1-smoke.json'), 'utf8');
  const report = JSON.parse(reportText);
  expect(report).toMatchObject({ base: 'v0', candidate: 'v1', subset: 'smoke', reviews: 1, runsPerReview: 2,
    generatedAt: '2026-01-03T00:00:00.000Z', sameDay, comparison: { verdict: 'adopt' } });
  expect(report.measuredDates.base).toEqual(sameDay ? ['2026-01-01'] : ['2026-01-01', '2026-01-02']);
  expect(reportText).not.toMatch(/pmcid|PMC\d+|合成レビュー/);
  const output = (s.runtime.stdout as jest.Mock).mock.calls.map((call) => call[0]).join('');
  expect(output.startsWith('警告:')).toBe(!sameDay);
  expect(output).not.toContain(s.selected.pmcid);
  expect(s.runtime.fetchImpl).not.toHaveBeenCalled();
});

test('両版が別々の単一日でも同日扱いせず、日付不正は拒否する', () => {
  const s = setup(); s.save();
  for (let i = 1; i <= 2; i++) writeJson(s.path('v1', i), { ...JSON.parse(readFileSync(s.path('v1', i), 'utf8')), measuredAt: '2026-01-02T00:00:00Z' });
  main(s.args, s.runtime);
  expect(JSON.parse(readFileSync(join(s.runtime.reportsDir!, 'compare-v0-v1-smoke.json'), 'utf8')).sameDay).toBe(false);
  writeJson(s.path('v1'), { ...JSON.parse(readFileSync(s.path('v1'), 'utf8')), measuredAt: '日付ではない' });
  expect(() => main(s.args, s.runtime)).toThrow('測定日不正 1 件');
});

test.each([
  ['--base', '../v1'], ['--base', 'v0', '--base', 'v1'], ['--base', 'v0'],
  ['--base', 'v0', '--candidate', 'v1', '--version', 'v2'],
])('不正な版の指定を拒否する（%j）', (...args) => {
  expect(() => parseCompareOptions(args)).toThrow('版');
});

test('実行数が異なる比較は明示時だけ許可し既存のレビュー内集計を保つ', () => {
  const base = [row(1, [score(0, 10), score(0.5, 20), score(1, 90)])], candidate = [row(1, [score(1, 20)])];
  expect(() => compare(base, candidate)).toThrow('実行数');
  expect(() => comparePaired(base, candidate, { allowUnequalRuns: false })).toThrow('実行数');
  const result = comparePaired(base, candidate, { allowUnequalRuns: true, resamples: 20 });
  expect(result.studyRecall).toMatchObject({ base: 0.5, candidate: 1, difference: 0.5 });
  expect(result.medianHits).toEqual({ base: 40, candidate: 20 });
  expect(result.hitsRatioAll).toEqual({ reviews: 1, median: 0.5 });
  expect(() => comparePaired(base, [row(1, [])], { allowUnequalRuns: true })).toThrow('run が空');
  expect(() => comparePaired(base, [row(1, [score()], 'cc-by-nc')], { allowUnequalRuns: true })).toThrow('ティア');
  expect(() => comparePaired(base, [row(2, [score()])], { allowUnequalRuns: true })).toThrow('集合');
});

test('候補の実行数を読み、省略時は既存の引数の形を保つ', () => {
  const s = setup();
  expect(parseCompareOptions(s.args)).toEqual({ root: dirname(dirname(dirname(dirname(s.path('v0'))))), version: 'v0', base: 'v0', candidate: 'v1', subset: 'smoke', runsPerReview: 2, openTestSet: false });
  expect(parseCompareOptions([...s.args, '--candidate-runs-per-review', '1']).candidateRunsPerReview).toBe(1);
});

test.each([[], ['0'], ['-1'], ['1.5'], ['abc'], ['9007199254740992'], ['1', '--candidate-runs-per-review', '2'], ['1', '--exclude-seeds', 'seed']])('候補の実行数の不正な指定を拒否する（%j）', (...values) => {
  const s = setup();
  expect(() => parseCompareOptions([...s.args, '--candidate-runs-per-review', ...values])).toThrow('実行引数');
});

test('基準三実行と候補一実行を読み指定された実行数をレポートに残す', () => {
  const s = setup(); s.save();
  const dir = dirname(s.path('v0', 3));
  writeJson(join(dir, 'submission.json'), { number: 1, query: 'a[tiab]' });
  writeLines(join(dir, 'tool-log.jsonl'), [{ command: 'submit' }]);
  writeJson(s.path('v0', 3), JSON.parse(readFileSync(s.path('v0'), 'utf8')));
  writeFileSync(s.path('v1', 2), '読まない記録');
  expect(main([...s.args.slice(0, -1), '3', '--candidate-runs-per-review', '1'], s.runtime)).toBe(0);
  const report = JSON.parse(readFileSync(join(s.runtime.reportsDir!, 'compare-v0-v1-smoke.json'), 'utf8'));
  expect(report).toMatchObject({ runsPerReview: 3, candidateRunsPerReview: 1, comparison: { reviews: 1 } });
  expect(s.runtime.fetchImpl).not.toHaveBeenCalled();
});

test('候補の実行数を省略したレポートに項目を追加しない', () => {
  const s = setup(); s.save(); main(s.args, s.runtime);
  expect(JSON.parse(readFileSync(join(s.runtime.reportsDir!, 'compare-v0-v1-smoke.json'), 'utf8'))).not.toHaveProperty('candidateRunsPerReview');
});
