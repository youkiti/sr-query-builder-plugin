/** @jest-environment node */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from './scoreRuns';
import { createRun, writeJson } from './runDir';
import { loadConditions } from './conditions';
import { fixture, review, writeLines } from './testFixtures';
import { splitReviews } from './split';
import type { RunRuntime } from './startRuns';

function setup(create = true) {
  const root = mkdtempSync(join(tmpdir(), 'p2f-score-'));
  const casesDir = join(root, 'cases');
  const rows = Array.from({ length: 5 }, (_, i) => review(i + 1));
  fixture(root, rows);
  writeLines(join(root, 'data/processed/cc-by/gold/task2_search_screen.jsonl'), rows.map((row) => ({ pmcid: row.pmcid,
    included_pmids: ['11111111'], pmid_to_study_id: {} })));
  writeLines(join(casesDir, 'evaluable.jsonl'), rows.map((row) => ({ pmcid: row.pmcid, cutoffDate: row.cutoffDate,
    measuredAt: '2026-01-01Z', existing: ['11111111'], withinCutoff: ['11111111'] })));
  const selected = rows.find((row) => splitReviews(rows).get(row.pmcid) === 'development')!;
  writeJson(join(casesDir, 'subsets.json'), { smoke: [selected.pmcid], fixed: [selected.pmcid] });
  const runtime: RunRuntime = { casesDir, reportsDir: join(root, 'reports'), env: { COCHRANE_BENCH_DIR: root, P2F_NCBI_RPS: '100000', NCBI_API_KEY: 'FAKE_SECRET' },
    now: () => new Date('2026-01-01Z'), stdout: jest.fn(), stderr: jest.fn(), sleep: async () => undefined,
    fetchImpl: jest.fn(async () => { throw new Error('想定外の通信'); }) };
  const file = join(root, 'protocol.md');
  writeFileSync(file, '合成プロトコル');
  const dirs = create ? Array.from({ length: 4 }, (_, i) => createRun({ root: join(root, 'runs'), version: 'v0', pmcid: selected.pmcid,
    runIndex: i + 1, cutoffDate: selected.cutoffDate, protocolPath: file, conditions: loadConditions('v0'), now: runtime.now })) : [];
  const args = ['--runs', join(root, 'runs'), '--version', 'v0', '--subset', 'smoke', '--runs-per-review', '4'];
  return { root, runtime, dirs, args };
}
test('実行フォルダ不足と試験群の未開封を通信前に拒否する', async () => {
  const s = setup(false);
  await expect(main(s.args, s.runtime)).rejects.toThrow('4 件不足');
  const args = [...s.args]; args[5] = 'test';
  await expect(main(args, s.runtime)).rejects.toThrow('--open-test-set');
  expect(s.runtime.fetchImpl).not.toHaveBeenCalled();
});
test('4区分を保存し、不明を集計せず、再開で不明だけ測り直す', async () => {
  const s = setup();
  writeJson(join(s.dirs[0]!, 'submission.json'), { query: 'a[tiab]' });
  writeFileSync(join(s.dirs[1]!, 'tool-log.jsonl'), JSON.stringify({ command: 'submit', result: '検査不合格' }) + '\n');
  writeJson(join(s.dirs[3]!, 'submission.json'), { query: 'b[tiab]' });
  let failure = true;
  s.runtime.fetchImpl = jest.fn(async (input) => {
    const url = new URL(String(input));
    if (!url.pathname.endsWith('/esearch.fcgi')) throw new Error('想定外の通信');
    expect(url.searchParams.get('datetype')).toBe('edat');
    expect(url.searchParams.get('maxdate')).toBe('2020/01/31');
    if (failure && url.searchParams.get('term')!.includes('b[tiab]')) throw new Error('合成の障害 FAKE_SECRET');
    return new Response(JSON.stringify({ esearchresult: { count: '1', idlist: url.searchParams.get('retmax') === '0' ? [] : ['11111111'] } }));
  });
  expect(await main(s.args, s.runtime)).toBe(1);
  const scores = s.dirs.map((dir) => JSON.parse(readFileSync(join(dir, 'score.json'), 'utf8')));
  expect(scores.map((score) => score.outcome.status)).toEqual(['measured', 'invalid_submission', 'no_submission', 'measurement_failed']);
  expect(scores.map((score) => score.status)).toEqual(['scored', 'scored', 'scored', 'unknown']);
  expect(JSON.stringify(scores)).not.toContain('FAKE_SECRET');
  expect(existsSync(s.runtime.reportsDir!)).toBe(false);
  const saved = s.dirs.slice(0, 3).map((dir) => readFileSync(join(dir, 'score.json'), 'utf8'));
  failure = false;
  (s.runtime.fetchImpl as jest.Mock).mockClear();
  expect(await main(s.args, s.runtime)).toBe(0);
  expect(s.runtime.fetchImpl).toHaveBeenCalledTimes(2);
  expect(s.dirs.slice(0, 3).map((dir) => readFileSync(join(dir, 'score.json'), 'utf8'))).toEqual(saved);
  const report = readFileSync(join(s.runtime.reportsDir!, 'v0-smoke.json'), 'utf8');
  expect(JSON.parse(report)).toMatchObject({ reviews: 1, runsPerReview: 4, summary: { allCapturedRate: 0.5, failureRate: 0.5 } });
  expect(report).not.toMatch(/PMC000000|11111111|capturedPmids/);
  (s.runtime.fetchImpl as jest.Mock).mockClear();
  expect(await main(s.args, s.runtime)).toBe(0);
  expect(s.runtime.fetchImpl).not.toHaveBeenCalled();
});
