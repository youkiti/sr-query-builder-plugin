/** @jest-environment node */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from './compare';
import { scoreSubmission } from './metrics';
import { splitReviews } from './split';
import type { RunRuntime } from './startRuns';
import { fixture, pmids, record, review, writeJson, writeLines } from './testFixtures';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'p2f-compare-seeds-'));
  const rows = Array.from({ length: 20 }, (_, i) => review(i + 1)); fixture(root, rows);
  const selected = rows.filter((row) => splitReviews(rows).get(row.pmcid) === 'development').slice(0, 3);
  const runtime: RunRuntime = { env: { COCHRANE_BENCH_DIR: root }, casesDir: join(root, 'cases'), reportsDir: join(root, 'reports'),
    fetchImpl: jest.fn(), now: () => new Date('2026-01-01'), stdout: jest.fn(), stderr: jest.fn() };
  writeLines(join(runtime.casesDir!, 'evaluable.jsonl'), rows.map((row) => record(row)));
  writeJson(join(runtime.casesDir!, 'subsets.json'), { smoke: selected.map((row) => row.pmcid) });
  const seed = (i: number, studyIds: string[], seeds: string[]) => writeJson(join(root, '_seeds/probe', `${selected[i]!.pmcid}.json`), {
    pmids: seeds, studyIds, max: 5, selectedAt: '2026-01-01', candidatesFingerprint: '指紋',
  });
  seed(0, ['study:合成研究甲'], [pmids[1]!]); seed(1, [], []);
  seed(2, selected[2]!.studies.map((study) => study.id), [...pmids]);
  const scorePath = (version: string, i: number) => join(root, version, selected[i]!.pmcid, 'run-1/score.json');
  for (const version of ['v0', 'v1']) selected.forEach((row, i) => {
    const outcome = { status: 'measured' as const, hits: version === 'v0' ? 100 : 50, capturedPmids: pmids.slice(0, 2) };
    writeJson(scorePath(version, i), { ...scoreSubmission(row.studies, pmids, outcome), outcome,
      measuredAt: '2026-01-01', submission: null, submitAttempts: 0 });
  });
  const args = ['--runs', root, '--base', 'v0', '--candidate', 'v1', '--subset', 'smoke', '--runs-per-review', '1'];
  const report = () => JSON.parse(readFileSync(join(runtime.reportsDir!, 'compare-v0-v1-smoke-noseed-probe.json'), 'utf8'));
  return { root, runtime, args, selected, seed, scorePath, report };
}

test('シード研究を両版から除き、残る研究と共有する報告を保持し、全除外とシードなしを分ける', () => {
  const s = setup(); expect(main([...s.args, '--exclude-seeds', 'probe'], s.runtime)).toBe(0);
  const report = s.report();
  expect(report).toMatchObject({ reviews: 2, seededReviews: 1, unseededReviews: 1, droppedReviews: 1, excludeSeeds: 'probe' });
  expect(report.comparison.studyRecall.base).toBeCloseTo((1 / 3 + 1 / 2) / 2);
  expect(report.comparison.studyRecall.candidate).toBeCloseTo((1 / 3 + 1 / 2) / 2);
  expect(report.seededOnly.studyRecall).toMatchObject({ base: 1 / 3, candidate: 1 / 3 });
  expect(report.seededOnly.missedStudies).toMatchObject({ base: 2, candidate: 2 });
  expect(report.comparison.medianHits).toEqual({ base: 100, candidate: 50 });
  const output = JSON.stringify((s.runtime.stdout as jest.Mock).mock.calls);
  for (const secret of [...pmids, ...s.selected.map((row) => row.pmcid)]) expect(output).not.toContain(secret);
  expect(s.runtime.fetchImpl).not.toHaveBeenCalled();
});
test('シードにした研究の捕捉だけでは残る研究の捕捉と数えない', () => {
  const s = setup(); s.seed(0, ['study:合成研究甲', 'study:合成研究乙'], [pmids[0]!]);
  main([...s.args, '--exclude-seeds', 'probe'], s.runtime);
  expect(s.report().seededOnly.studyRecall).toMatchObject({ base: 0, candidate: 0 });
  expect(s.report().seededOnly.missedStudies).toMatchObject({ base: 2, candidate: 2 });
});
test('シードありの対象が残らないときは部分比較を空にする', () => {
  const s = setup(); s.seed(0, [], []);
  main([...s.args, '--exclude-seeds', 'probe'], s.runtime); expect(s.report().seededOnly).toBeNull();
});
test('全レビューが落ちた場合も除外数を報告する', () => {
  const s = setup(); s.selected.forEach((row, i) => s.seed(i, row.studies.map((study) => study.id), [...pmids]));
  main([...s.args, '--exclude-seeds', 'probe'], s.runtime);
  expect(s.report()).toMatchObject({ reviews: 0, droppedReviews: 3, comparison: null, seededOnly: null });
});
test('選定の不足を全体で検出する', () => {
  const s = setup(); expect(() => main([...s.args, '--exclude-seeds', 'missing'], s.runtime)).toThrow('シードの選定が 3 件不足しています');
  expect(existsSync(s.runtime.reportsDir!)).toBe(false);
});
test('保存された測定結果がなければ再採点を拒否する', () => {
  const s = setup(), path = s.scorePath('v0', 0), saved = JSON.parse(readFileSync(path, 'utf8')); delete saved.outcome; writeJson(path, saved);
  expect(() => main([...s.args, '--exclude-seeds', 'probe'], s.runtime)).toThrow('未採点 1 件');
});
test('除外対象でない不正な捕捉を黙って捨てず再採点を拒否する', () => {
  const s = setup(), path = s.scorePath('v0', 0), saved = JSON.parse(readFileSync(path, 'utf8'));
  saved.outcome.capturedPmids.push('99999999'); writeJson(path, saved);
  expect(() => main([...s.args, '--exclude-seeds', 'probe'], s.runtime)).toThrow('未採点 1 件');
});
test('除外指定がなければ従来のファイル名と集計を保つ', () => {
  const s = setup(); main(s.args, s.runtime);
  const report = JSON.parse(readFileSync(join(s.runtime.reportsDir!, 'compare-v0-v1-smoke.json'), 'utf8'));
  expect(report.reviews).toBe(3); expect(report.comparison.studyRecall.base).toBe(0.5);
  for (const key of ['excludeSeeds', 'seededOnly', 'seededReviews', 'unseededReviews', 'droppedReviews']) expect(report).not.toHaveProperty(key);
});
