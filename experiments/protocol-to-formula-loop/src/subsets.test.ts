/** @jest-environment node */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyEvaluable } from './evaluable';
import { type ReviewLabel } from './labels';
import { main, selectSubsets, SUBSET_SALT, writeSubsets } from './subsets';
import { fixture, record, review, writeLines } from './testFixtures';

const dev = Array.from({ length: 25 }, (_, i) => applyEvaluable(review(i + 1), record(review(i + 1))));
const labels = new Map(dev.map((row): [string, ReviewLabel] => [row.pmcid, { pmcid: row.pmcid, domain: '合成領域', reviewType: 'intervention' }]));
test('等間隔抽出は決定的で、動作確認用は固定小集合の部分集合になる', () => {
  const selected = selectSubsets(dev, labels);
  expect(selected.fixed).toHaveLength(20);
  expect(selected.smoke).toHaveLength(5);
  expect(selected.smoke.every((id) => selected.fixed.includes(id))).toBe(true);
  expect(selectSubsets([...dev].reverse(), labels)).toEqual(selected);
  const ordered = dev.map((row) => ({ id: row.pmcid, hash: createHash('sha256').update(`${SUBSET_SALT}:${row.pmcid}`).digest('hex') }))
    .sort((a, b) => a.hash.localeCompare(b.hash));
  expect(selected.fixed).toEqual(Array.from({ length: 20 }, (_, i) => ordered[Math.floor((i + 0.5) * 25 / 20)]!.id));
  expect(selected.smoke).toEqual([2, 6, 10, 14, 18].map((i) => selected.fixed[i]));
});
test('層の辞書順をハッシュより優先する', () => {
  const rows = dev.slice(0, 4).map((row, i) => ({ ...row, tier: i < 2 ? 'cc-by-nc' as const : 'cc-by' as const }));
  const varied = new Map(rows.map((row, i): [string, ReviewLabel] => [row.pmcid, { pmcid: row.pmcid, domain: i % 2 ? '乙' : '甲', reviewType: 'intervention' }]));
  expect(selectSubsets(rows, varied, { fixed: 4, smoke: 2 }).fixed).toEqual([rows[3]!.pmcid, rows[2]!.pmcid, rows[1]!.pmcid, rows[0]!.pmcid]);
});
test('ラベル欠落・件数不足・不正な抽出件数を拒否し、評価不能レビューを抽出しない', () => {
  expect(() => selectSubsets(dev, new Map())).toThrow('ラベル');
  expect(() => selectSubsets(dev.slice(0, 19), labels)).toThrow('足りません');
  expect(() => selectSubsets(dev, labels, { fixed: 5, smoke: 6 })).toThrow('抽出件数');
  const rows = dev.map((row, i) => i === 0 ? { ...row, evaluable: false, studies: [] } : row);
  expect(selectSubsets(rows, labels).fixed).not.toContain(dev[0]!.pmcid);
});
test('抽出ファイルは既存内容を上書きしない', () => {
  const dir = mkdtempSync(join(tmpdir(), 'p2f-freeze-'));
  try {
    writeSubsets(dir, selectSubsets(dev, labels));
    const before = readFileSync(join(dir, 'subsets.json'), 'utf8');
    expect(JSON.parse(before)).toMatchObject({ salt: SUBSET_SALT, createdAt: expect.any(String) });
    expect(() => writeSubsets(dir, { fixed: [], smoke: [] })).toThrow();
    expect(readFileSync(join(dir, 'subsets.json'), 'utf8')).toBe(before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('CLI は合成開発群を凍結し、標準出力には層の件数だけを出す', () => {
  const dir = mkdtempSync(join(tmpdir(), 'p2f-subsets-'));
  const stdout = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
  try {
    const rows = Array.from({ length: 100 }, (_, i) => review(i + 1));
    fixture(dir, rows);
    writeLines(join(dir, 'evaluable.jsonl'), rows.map((row) => record(row)));
    writeLines(join(dir, 'labels.jsonl'), rows.map((row) => ({ pmcid: row.pmcid, domain: '合成領域', reviewType: 'intervention' })));
    main(dir, dir);
    const output = stdout.mock.calls.map(([value]) => String(value)).join('');
    expect(output).toContain('fixed: 20 件');
    expect(output).toContain('smoke: 5 件');
    expect(output).toContain('cc-by-nc: 0 件');
    expect(output).not.toContain('PMC');
    expect(() => main(dir, dir)).toThrow();
  } finally { stdout.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
});
