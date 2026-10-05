/** @jest-environment node */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadParsed, loadReviews, resolveBenchDir } from './bench';
import { fixture, pmids, review, writeLines } from './testFixtures';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'p2f-bench-')); fixture(dir); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
test('両ティアを読み、共有報告の研究を併合せず、名前の無い報告を単独研究にする', () => {
  const rows = loadReviews(dir);
  expect(rows).toHaveLength(2);
  expect(rows[0]!.studies).toEqual(review().studies);
  expect(rows[0]!.includedPmids).toEqual(pmids);
  expect(loadParsed(dir, rows[0]!).title).toBe('合成レビューの題');
  expect(resolveBenchDir({ COCHRANE_BENCH_DIR: dir })).toBe(dir);
});
test('環境変数の未設定と存在しないパスを拒否する', () => {
  expect(() => resolveBenchDir({})).toThrow('未設定');
  expect(() => resolveBenchDir({ COCHRANE_BENCH_DIR: join(dir, 'missing') })).toThrow('存在しません');
});
test('対応 gold の欠落をレビュー付きで拒否する', () => {
  writeLines(join(dir, 'data/processed/cc-by/gold/task2_search_screen.jsonl'), []);
  expect(() => loadReviews(dir)).toThrow(review().pmcid);
});
test('検索日の形式とティアをまたぐ PMCID 重複を拒否する', () => {
  fixture(dir, [{ ...review(), cutoff_date: '2020-1-31' }]);
  expect(() => loadReviews(dir)).toThrow('検索日');
  fixture(dir, [review(), { ...review(), tier: 'cc-by-nc' }]);
  expect(() => loadReviews(dir)).toThrow('重複');
});
