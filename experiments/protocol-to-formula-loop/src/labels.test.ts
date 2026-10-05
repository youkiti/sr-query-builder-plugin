/** @jest-environment node */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLabels, REVIEW_TYPES, studyBand } from './labels';
import { writeLines } from './testFixtures';

test('種別と領域を検査し、重複を拒否する', () => {
  const dir = mkdtempSync(join(tmpdir(), 'p2f-labels-'));
  const row = { pmcid: 'PMC0000001', domain: ' 合成領域 ', reviewType: 'intervention' };
  try {
    for (const reviewType of REVIEW_TYPES) {
      writeLines(join(dir, 'labels.jsonl'), [{ ...row, reviewType }]);
      expect(loadLabels(dir).get(row.pmcid)).toEqual({ ...row, domain: '合成領域', reviewType });
    }
    for (const rows of [[row, row], [{ ...row, domain: ' ' }], [{ ...row, reviewType: '未知' }]]) {
      writeLines(join(dir, 'labels.jsonl'), rows);
      expect(() => loadLabels(dir)).toThrow();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('評価可能な研究数で区分する', () => {
  expect([1, 3, 4, 10, 11].map(studyBand)).toEqual(['1-3', '1-3', '4-10', '4-10', '11+']);
  expect(() => studyBand(0)).toThrow();
});
