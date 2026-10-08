/** @jest-environment node */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from './spread';
import type { ScoredRun } from './metrics';
import { runPath } from './runDir';
import { splitReviews } from './split';
import type { RunRuntime } from './startRuns';
import { fixture, record, review, writeJson, writeLines } from './testFixtures';

const score = (studyRecall: number, hits: number, extra: Partial<ScoredRun> = {}): ScoredRun => ({ status: 'scored', studyRecall, hits,
  pmidRecall: studyRecall, missedStudies: 1 - studyRecall, allCaptured: studyRecall === 1, precision: 0, f7: 0, failed: false, failure: null, ...extra });
function setup(count = 2, runsPerReview = 3, sameDate = false) {
  const root = mkdtempSync(join(tmpdir(), 'p2f-spread-'));
  const all = Array.from({ length: 20 }, (_, i) => review(i + 1));
  const selected = all.filter((row) => splitReviews(all).get(row.pmcid) === 'development').slice(0, count);
  selected.forEach((row, i) => { row.cutoffDate = row.cutoff_date = sameDate ? '2020-01-31' : i === 0 ? '2021-01-31' : '2019-01-31'; });
  fixture(root, [...all].reverse());
  const casesDir = join(root, 'cases');
  writeLines(join(casesDir, 'evaluable.jsonl'), all.map((row) => record(row)));
  writeJson(join(casesDir, 'subsets.json'), { smoke: selected.map((row) => row.pmcid) });
  const runtime: RunRuntime = { casesDir, reportsDir: join(root, 'reports'), env: { COCHRANE_BENCH_DIR: root },
    now: () => new Date('2026-01-03T00:00:00Z'), stdout: jest.fn(), stderr: jest.fn(), sleep: async () => undefined,
    fetchImpl: jest.fn(async () => { throw new Error('想定外の通信'); }) };
  const args = ['--runs', join(root, 'runs'), '--version', 'v0', '--subset', 'smoke', '--runs-per-review', String(runsPerReview)];
  const dir = (r: number, i: number) => runPath(join(root, 'runs'), 'v0', selected[r]!.pmcid, i + 1);
  const save = (r: number, i: number, value: unknown, measurements = 0, submissions = 0) => {
    writeJson(join(dir(r, i), 'score.json'), { ...(value as object), submission: null, submitAttempts: 0, measuredAt: '2026-01-01T00:00:00Z' });
    writeJson(join(dir(r, i), 'budget.json'), { measurements, submissions });
  };
  for (let r = 0; r < count; r++) for (let i = 0; i < runsPerReview; i++) save(r, i, score(1, 10));
  const reportPath = join(runtime.reportsDir!, 'spread-v0-smoke.json');
  const report = () => { expect(main(args, runtime)).toBe(0); return JSON.parse(readFileSync(reportPath, 'utf8')); };
  return { runtime, args, dir, save, reportPath, report };
}

test('二レビュー三実行の母標準偏差・件数・道具使用・検索日別集計を出す', () => {
  const s = setup();
  [0, 0.5, 1].forEach((recall, i) => s.save(0, i, score(recall, [10, 100, 200] [i]!), [0, 2, 4][i]!, i));
  [10000, 50000, 60000].forEach((hits, i) => s.save(1, i, score(1, hits), [0, 6, 8][i]!, i + 3));
  const result = s.report(), sd = Math.sqrt(1 / 6);
  expect(result).toMatchObject({ version: 'v0', subset: 'smoke', reviews: 2, runsPerReview: 3, generatedAt: '2026-01-03T00:00:00.000Z', runs: 6, failedRuns: 0 });
  expect(result.recallSpread.reviews).toBe(2);
  expect(result.recallSpread.mean).toBeCloseTo(sd / 2);
  expect(result.recallSpread.median).toBeCloseTo(sd / 2);
  expect(result.recallSpread.max).toBeCloseTo(sd);
  expect(result.hitsRange).toEqual({ reviews: 2, median: 13, max: 20, over10x: 1 });
  expect(result.largeHits).toEqual({ runs: 6, over10000: 2, over50000: 1 });
  expect(result.toolUse).toEqual({ measurements: { median: 3, max: 8, zero: 2 }, submissions: { median: 2.5, max: 5 } });
  expect(result.byCutoff).toEqual({ splitDate: '2021-01-31', older: { reviews: 1, allCapturedRate: 1, studyRecall: 1 }, newer: { reviews: 1, allCapturedRate: 1 / 3, studyRecall: 0.5 } });
  expect((s.runtime.stdout as jest.Mock).mock.calls[0]![0]).toBe(readFileSync(s.reportPath, 'utf8'));
  expect(readFileSync(s.reportPath, 'utf8')).not.toMatch(/pmcid|PMC\d+|query|pmid/i);
  expect(s.runtime.fetchImpl).not.toHaveBeenCalled();
});

test.each(['zero_hits', 'invalid_submission', 'no_submission'] as const)('失敗の%sは再現率に含め件数から除く', (failure) => {
  const s = setup(1);
  s.save(0, 0, score(0, 60000, { failed: true, failure }));
  s.save(0, 1, score(1, 10)); s.save(0, 2, score(1, 100));
  const result = s.report();
  expect(result.failedRuns).toBe(1);
  expect(result.recallSpread.mean).toBeCloseTo(Math.sqrt(2 / 9));
  expect(result.hitsRange).toEqual({ reviews: 1, median: 10, max: 10, over10x: 0 });
  expect(result.largeHits).toEqual({ runs: 2, over10000: 0, over50000: 0 });
  expect(result.byCutoff).toBeNull();
});

test.each([null, '不正', 0, -1])('非数値・非正値の件数を除き二本未満のレビューを比に含めない（%j）', (hits) => {
  const s = setup(1);
  s.save(0, 0, { ...score(1, 10), hits }); s.save(0, 1, score(1, 0));
  const result = s.report();
  expect(result.failedRuns).toBe(0);
  expect(result.largeHits.runs).toBe(1);
  expect(result.hitsRange).toEqual({ reviews: 0, median: null, max: null, over10x: 0 });
});

test.each(['不明', '破損', '不一致'])('採点記録が%sなら未採点として停止しレポートを書かない', (kind) => {
  const s = setup(1);
  if (kind === '不明') s.save(0, 0, { status: 'unknown', error: '合成の不明' });
  else if (kind === '破損') writeFileSync(join(s.dir(0, 0), 'score.json'), '{');
  else writeLines(join(s.dir(0, 0), 'tool-log.jsonl'), [{ command: 'submit' }]);
  expect(() => main(s.args, s.runtime)).toThrow('採点記録の不足 0 件、未採点 1 件');
  expect(existsSync(s.reportPath)).toBe(false);
  expect(s.runtime.stdout).not.toHaveBeenCalled();
});

test('採点記録が不足するとレポートを書かない', () => {
  const s = setup(1);
  expect(() => main([...s.args.slice(0, -1), '4'], s.runtime)).toThrow('採点記録の不足 1 件、未採点 0 件');
  expect(existsSync(s.reportPath)).toBe(false);
});

test('一本の実行では揺れと件数比を null にする', () => {
  const s = setup(1, 1), result = s.report();
  expect(result.recallSpread).toBeNull(); expect(result.hitsRange).toBeNull(); expect(result.byCutoff).toBeNull();
});

test('同じ検索日は識別子順で分割し奇数件なら後半を一件多くする', () => {
  const s = setup(3, 1, true);
  s.save(0, 0, score(0, 10)); s.save(1, 0, score(0.5, 10)); s.save(2, 0, score(1, 10));
  expect(s.report().byCutoff).toEqual({ splitDate: '2020-01-31', older: { reviews: 1, allCapturedRate: 0, studyRecall: 0 }, newer: { reviews: 2, allCapturedRate: 0.5, studyRecall: 0.75 } });
});
