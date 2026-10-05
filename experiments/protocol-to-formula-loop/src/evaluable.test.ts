/** @jest-environment node */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyEvaluable, loadEvaluable } from './evaluable';
import { pmids, record, review, writeLines } from './testFixtures';

test('日付外・不存在の報告と全滅した研究を区別して除く', () => {
  const result = applyEvaluable(review(), { ...record(), existing: pmids.slice(0, 3), withinCutoff: [pmids[1]!] });
  expect(result).toMatchObject({ evaluablePmids: [pmids[1]], excludedReports: 3, excludedStudies: 3,
    nonexistentReports: 1, afterCutoffReports: 2, evaluable: true });
  expect(result.studies).toEqual([{ id: 'study:合成研究甲', pmids: [pmids[1]] }]);
  expect(applyEvaluable(review(), { ...record(), withinCutoff: [] })).toMatchObject({ evaluable: false, excludedStudies: 4 });
});
test('レビュー・検索日・部分集合の不整合を拒否する', () => {
  for (const change of [{ pmcid: 'PMC0000099' }, { cutoffDate: '2020-02-01' }, { existing: [] }, { existing: ['00000099'] }]) {
    expect(() => applyEvaluable(review(), { ...record(), ...change })).toThrow();
  }
});
test('追記の最終行を採り、欠落ファイルを拒否する', () => {
  const dir = mkdtempSync(join(tmpdir(), 'p2f-evaluable-'));
  try {
    expect(() => loadEvaluable(dir)).toThrow('見つかりません');
    writeLines(join(dir, 'evaluable.jsonl'), [record(), { ...record(), withinCutoff: [] }]);
    expect(loadEvaluable(dir).get(review().pmcid)!.withinCutoff).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
