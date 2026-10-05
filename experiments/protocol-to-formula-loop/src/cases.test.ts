/** @jest-environment node */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { casesDir, main } from './cases';
import { fixture, pmids, review } from './testFixtures';

test('本文と索引に許可された入力だけを書き、0件の群も出力する', () => {
  const dir = mkdtempSync(join(tmpdir(), 'p2f-cases-'));
  const stdout = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
  try {
    fixture(dir, [review()]);
    const output = join(dir, 'cases');
    main(dir, output);
    const protocol = readFileSync(join(output, review().pmcid, 'protocol.md'), 'utf8');
    const index = readFileSync(join(output, 'index.jsonl'), 'utf8');
    expect(protocol).toContain('合成の評価項目');
    expect(Object.keys(JSON.parse(index))).toEqual(['pmcid', 'tier', 'cutoffDate', 'split', 'title', 'nStudies', 'nPmids']);
    expect(JSON.parse(index)).toMatchObject({ nStudies: 4, nPmids: 4 });
    for (const forbidden of [...pmids, '合成研究甲', '混入禁止', 'n_records', 'included_recall']) {
      expect(protocol + index).not.toContain(forbidden);
    }
    expect(stdout.mock.calls.map(([value]) => value).join('')).toContain('cc-by-nc: 0 件');
    expect(stdout.mock.calls).toHaveLength(6);
    expect(casesDir()).toBe(resolve(__dirname, '../cases'));
  } finally { stdout.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
});
