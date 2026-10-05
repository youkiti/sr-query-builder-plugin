/** @jest-environment node */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, originalBaseline, originalFormulaOutcome, reconcileWithBench } from './baseline';
import { loadReviews, loadSummaries } from './bench';
import { fixture, pmids, record, review, writeLines } from './testFixtures';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'p2f-baseline-')); fixture(dir); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); jest.restoreAllMocks(); process.exitCode = 0; });
test('原著式の捕捉と、各記録値・両ティアの macro 再現率を照合する', () => {
  const rows = loadReviews(dir);
  const summaries = loadSummaries(dir);
  expect(originalFormulaOutcome(rows[0]!)).toEqual({ status: 'measured', hits: 200, capturedPmids: [pmids[0]] });
  expect(reconcileWithBench(rows, summaries).count).toBe(0);
  rows[0]!.n_included_pmids++;
  rows[0]!.n_included_studies++;
  rows[0]!.included_studies_retrieved++;
  rows[0]!.included_recall = 0;
  rows[0]!.included_study_recall = 0;
  summaries['cc-by'].study_macro_recall = 0;
  summaries['cc-by-nc'].pmid_macro_recall = 0;
  expect(reconcileWithBench(rows, summaries)).toMatchObject({ count: 7, fields: expect.arrayContaining([
    'n_included_pmids', 'n_included_studies', 'included_studies_retrieved', 'included_recall', 'included_study_recall',
    'study_macro_recall', 'pmid_macro_recall']) });
});
test('評価可能な捕捉だけで採点し、全滅レビューを外し、記録欠落を拒否する', () => {
  const rows = loadReviews(dir);
  const records = new Map(rows.map((row) => [row.pmcid, { ...record(row), withinCutoff: row.tier === 'cc-by' ? [pmids[1]!] : [] }]));
  expect(originalBaseline(rows, records)).toMatchObject({ excludedReviews: { noEvaluableStudy: 1, originalSearchEmpty: 0 }, summary: { reviews: 1, studyRecall: 0, medianHits: 200 } });
  expect(() => originalBaseline(rows, new Map())).toThrow('記録がありません');
});
test('CLI は件数と集計だけを出し、不一致で終了コードを設定する', () => {
  const stdout = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
  const rows = loadReviews(dir);
  writeLines(join(dir, 'evaluable.jsonl'), rows.map((row) => record(row)));
  main(dir, dir);
  const text = stdout.mock.calls.map(([value]) => String(value)).join('');
  expect(text).toContain('一致');
  expect(text).toContain('"reviews":2');
  for (const row of rows) expect(text).not.toContain(row.pmcid);
  fixture(dir, [{ ...review(), included_recall: 0 }]);
  main(dir, dir);
  expect(process.exitCode).toBe(1);
});
test('許容差以内の差は不一致にしない', () => {
  const rows = loadReviews(dir);
  rows[0]!.included_recall += 1e-10;
  expect(reconcileWithBench(rows, loadSummaries(dir)).count).toBe(0);
});

test('原著式0件と評価不能の除外理由を分け、両方なら評価不能を優先する', () => {
  const rows = [review(1), { ...review(2), n_records: 0 }, { ...review(3), n_records: 0 }];
  const records = new Map(rows.map((row, i) => [row.pmcid, { ...record(row), withinCutoff: i === 2 ? [] : pmids }]));
  expect(originalBaseline(rows, records)).toMatchObject({ summary: { reviews: 1 }, excludedReviews: { noEvaluableStudy: 1, originalSearchEmpty: 1 } });
});
