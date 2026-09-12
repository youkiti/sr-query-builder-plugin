/** @jest-environment node */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { report } from './report';

test('report reads both layouts and groups cases across profiles without counting attempts', () => {
  const network = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Real API forbidden'));
  const root = mkdtempSync(join(tmpdir(), 'bench-profiles-'));
  const fixtures = join(root, 'fixtures');
  const results = join(root, 'results');
  const save = (dir: string, value: unknown) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'run.json'), JSON.stringify(value));
  };
  const run = (id: string, profileId?: string) => ({ id, profileId, conditions: {}, status: 'completed', apiCalls: { ncbi: 0, llm: 0 }, elapsedMs: 0 });
  try {
    save(join(results, 'a'), run('a'));
    save(join(results, 'a', 'attempt'), run('ignored'));
    save(join(results, 'b'), run('b', 'tight-1000'));
    save(join(results, 'tight-1000', 'a'), run('a', 'tight-1000'));
    save(join(results, 'tight-1000', 'a', 'attempt'), run('ignored'));
    save(join(results, 'default', 'c'), run('c', 'default'));
    mkdirSync(join(fixtures, 'a'), { recursive: true });
    writeFileSync(join(fixtures, 'a', 'b1.json'), JSON.stringify({ query: 'baseline' }));
    report(results, fixtures);
    const csv = readFileSync(join(results, 'summary.csv'), 'utf8');
    const lines = csv.trim().split('\n');
    expect(lines[0]).toMatch(/^"profile","case"/);
    expect(lines.filter((line) => line.includes('"C0"')).map((line) => line.split(',').slice(0, 2))).toEqual([
      ['"default"', '"a"'], ['"tight-1000"', '"a"'], ['"tight-1000"', '"b"'], ['"default"', '"c"'],
    ]);
    expect(csv).not.toContain('ignored');
    expect(csv.match(/baseline/g)).toHaveLength(2);
    expect(readFileSync(join(results, 'summary.md'), 'utf8')).toContain('| profile | case |');
    expect(network).not.toHaveBeenCalled();
  } finally { network.mockRestore(); }
});
