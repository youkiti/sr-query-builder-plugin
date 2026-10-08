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
  writeJson(join(s.dirs[0]!, 'submission.json'), { number: 1, query: 'a[tiab]' });
  writeFileSync(join(s.dirs[1]!, 'tool-log.jsonl'), JSON.stringify({ command: 'submit', result: '検査不合格' }) + '\n');
  writeJson(join(s.dirs[3]!, 'submission.json'), { number: 1, query: 'b[tiab]' });
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

test('式の拒否と0件は失敗として集計し、0件の捕捉通信は行わない', async () => {
  const s = setup();
  writeJson(join(s.dirs[0]!, 'submission.json'), { number: 1, query: 'a[tiabb]' });
  writeJson(join(s.dirs[1]!, 'submission.json'), { number: 1, query: 'zero[tiab]' });
  s.runtime.fetchImpl = jest.fn(async (input) => {
    const params = new URL(String(input)).searchParams;
    expect(params.get('retmax')).toBe('0');
    return new Response(JSON.stringify({ esearchresult: params.get('term')!.includes('tiabb')
      ? { errorlist: { fieldsnotfound: ['tiabb FAKE_SECRET'] } } : { count: '0' } }));
  });
  expect(await main(s.args, s.runtime)).toBe(0);
  expect(s.runtime.fetchImpl).toHaveBeenCalledTimes(2);
  const scores = s.dirs.map((dir) => JSON.parse(readFileSync(join(dir, 'score.json'), 'utf8')));
  expect(scores[0]).toMatchObject({ status: 'scored', failure: 'invalid_submission', outcome: { status: 'invalid_submission' } });
  expect(scores[1]).toMatchObject({ status: 'scored', failure: 'zero_hits', outcome: { status: 'measured', hits: 0 } });
  expect(JSON.stringify(scores)).not.toContain('FAKE_SECRET');
  expect(JSON.parse(readFileSync(join(s.runtime.reportsDir!, 'v0-smoke.json'), 'utf8')).summary.failures)
    .toEqual({ zeroHits: 0.25, invalidSubmission: 0.25, noSubmission: 0.5 });
});
test('ワイルドカード上限の拒否は再現率0で採点し、集計を止めない', async () => {
  const s = setup();
  writeJson(join(s.dirs[0]!, 'submission.json'), { number: 1, query: 'a*[tiab]' });
  const message = 'Search Backend failed: An error occurred while processing request. Status: 500. Source: /api/search/?r= Details: Search is temporarily unavailable. Please try again later. Details: Cannot search because the number of wildcards (*) exceeds 256.';
  s.runtime.fetchImpl = jest.fn(async (input) => {
    expect(new URL(String(input)).pathname).toMatch(/\/esearch\.fcgi$/);
    return new Response(JSON.stringify({ esearchresult: { ERROR: message } }));
  });
  expect(await main(s.args, s.runtime)).toBe(0);
  expect(JSON.parse(readFileSync(join(s.dirs[0]!, 'score.json'), 'utf8'))).toMatchObject({
    status: 'scored', studyRecall: 0, pmidRecall: 0, failure: 'invalid_submission',
    outcome: { status: 'invalid_submission', reason: expect.stringContaining('number of wildcards') },
  });
  expect(s.runtime.stdout).not.toHaveBeenCalledWith(expect.stringContaining('未確定'));
  expect(JSON.parse(readFileSync(join(s.runtime.reportsDir!, 'v0-smoke.json'), 'utf8')).summary)
    .toMatchObject({ studyRecall: 0, pmidRecall: 0, failures: { invalidSubmission: 0.25 } });
});
test('ワイルドカード上限を含まない検索バックエンド障害は測定失敗のまま集計しない', async () => {
  const s = setup();
  writeJson(join(s.dirs[0]!, 'submission.json'), { number: 1, query: 'a[tiab]' });
  const message = 'Search Backend failed: An error occurred while processing request. Status: 500. Source: /api/search/?r= Details: Search is temporarily unavailable. Please try again later.';
  s.runtime.fetchImpl = jest.fn(async (input) => {
    expect(new URL(String(input)).pathname).toMatch(/\/esearch\.fcgi$/);
    return new Response(JSON.stringify({ esearchresult: { ERROR: message } }));
  });
  expect(await main(s.args, s.runtime)).toBe(1);
  expect(JSON.parse(readFileSync(join(s.dirs[0]!, 'score.json'), 'utf8'))).toMatchObject({
    status: 'unknown', outcome: { status: 'measurement_failed', error: expect.stringContaining(message) },
  });
  expect(s.runtime.stdout).toHaveBeenCalledWith(expect.stringContaining('未確定'));
  expect(existsSync(s.runtime.reportsDir!)).toBe(false);
});
test('捕捉の段階でも拒否と応答破損を区別する', async () => {
  const s = setup();
  writeJson(join(s.dirs[0]!, 'submission.json'), { number: 1, query: 'a[tiab]' });
  let rejected = true;
  s.runtime.fetchImpl = jest.fn(async (input) => {
    const params = new URL(String(input)).searchParams;
    return new Response(JSON.stringify({ esearchresult: params.get('retmax') === '0' ? { count: '1' }
      : rejected ? { ERROR: '合成の拒否' } : { count: '1' } }));
  });
  expect(await main(s.args, s.runtime)).toBe(0);
  const path = join(s.dirs[0]!, 'score.json');
  expect(JSON.parse(readFileSync(path, 'utf8')).failure).toBe('invalid_submission');
  rejected = false;
  writeJson(join(s.dirs[0]!, 'submission.json'), { number: 2, query: 'b[tiab]' });
  expect(await main(s.args, s.runtime)).toBe(1);
  expect(JSON.parse(readFileSync(path, 'utf8')).status).toBe('unknown');
});
test('捕捉数が総件数より多ければ未確定にする', async () => {
  const s = setup();
  const rows = Array.from({ length: 5 }, (_, i) => review(i + 1));
  writeLines(join(s.root, 'data/processed/cc-by/gold/task2_search_screen.jsonl'), rows.map((row) => ({ pmcid: row.pmcid,
    included_pmids: ['11111111', '11111112'], pmid_to_study_id: {} })));
  writeLines(join(s.runtime.casesDir!, 'evaluable.jsonl'), rows.map((row) => ({ pmcid: row.pmcid, cutoffDate: row.cutoffDate,
    existing: ['11111111', '11111112'], withinCutoff: ['11111111', '11111112'] })));
  writeJson(join(s.dirs[0]!, 'submission.json'), { number: 1, query: 'a[tiab]' });
  s.runtime.fetchImpl = jest.fn(async (input) => new Response(JSON.stringify({ esearchresult:
    new URL(String(input)).searchParams.get('retmax') === '0' ? { count: '1' } : { count: '2', idlist: ['11111111', '11111112'] } })));
  expect(await main(s.args, s.runtime)).toBe(1);
  expect(JSON.parse(readFileSync(join(s.dirs[0]!, 'score.json'), 'utf8'))).toMatchObject({ status: 'unknown', error: '捕捉数が総件数を超えています' });
  expect(existsSync(s.runtime.reportsDir!)).toBe(false);
});
test('提出番号・式・試行数の一致時だけ再利用し、旧記録は再測定する', async () => {
  const s = setup();
  const dir = s.dirs[0]!;
  const scorePath = join(dir, 'score.json');
  const submit = (number: number, query: string) => writeJson(join(dir, 'submission.json'), { number, query });
  submit(1, 'a[tiab]');
  s.runtime.fetchImpl = jest.fn(async () => new Response(JSON.stringify({ esearchresult: { count: '0' } })));
  expect(await main(s.args, s.runtime)).toBe(0);
  const saved = JSON.parse(readFileSync(scorePath, 'utf8'));
  expect(saved).toMatchObject({ submission: { number: 1, querySha256: expect.stringMatching(/^[a-f0-9]{64}$/) }, submitAttempts: 0 });
  expect(await main(s.args, s.runtime)).toBe(0);
  expect(s.runtime.fetchImpl).toHaveBeenCalledTimes(1);
  submit(1, 'b[tiab]');
  expect(await main(s.args, s.runtime)).toBe(0);
  expect(s.runtime.fetchImpl).toHaveBeenCalledTimes(2);
  submit(2, 'b[tiab]');
  expect(await main(s.args, s.runtime)).toBe(0);
  expect(s.runtime.fetchImpl).toHaveBeenCalledTimes(3);
  writeFileSync(join(dir, 'tool-log.jsonl'), JSON.stringify({ command: 'submit' }) + '\n');
  expect(await main(s.args, s.runtime)).toBe(0);
  expect(s.runtime.fetchImpl).toHaveBeenCalledTimes(4);
  const old = JSON.parse(readFileSync(scorePath, 'utf8'));
  delete old.submission;
  writeJson(scorePath, old);
  expect(await main(s.args, s.runtime)).toBe(0);
  expect(s.runtime.fetchImpl).toHaveBeenCalledTimes(5);
  const absent = s.dirs[1]!;
  writeFileSync(join(absent, 'tool-log.jsonl'), JSON.stringify({ command: 'submit' }) + '\n');
  expect(await main(s.args, s.runtime)).toBe(0);
  expect(JSON.parse(readFileSync(join(absent, 'score.json'), 'utf8'))).toMatchObject({ failure: 'invalid_submission', submission: null, submitAttempts: 1 });
});
test('再利用した採点の測定範囲とレポート生成時刻を分ける', async () => {
  const s = setup();
  expect(await main(s.args, s.runtime)).toBe(0);
  const first = s.runtime.now().toISOString();
  s.runtime.now = () => new Date('2026-01-02T00:00:00Z');
  writeJson(join(s.dirs[0]!, 'submission.json'), { number: 1, query: 'a[tiab]' });
  s.runtime.fetchImpl = jest.fn(async () => new Response(JSON.stringify({ esearchresult: { count: '0' } })));
  expect(await main(s.args, s.runtime)).toBe(0);
  const last = s.runtime.now().toISOString();
  s.runtime.now = () => new Date('2026-01-03T00:00:00Z');
  expect(await main(s.args, s.runtime)).toBe(0);
  const report = JSON.parse(readFileSync(join(s.runtime.reportsDir!, 'v0-smoke.json'), 'utf8'));
  expect(report).toMatchObject({ generatedAt: s.runtime.now().toISOString(), measuredFrom: first, measuredTo: last });
  expect(report).not.toHaveProperty('measuredAt');
  expect(s.runtime.fetchImpl).toHaveBeenCalledTimes(1);
});
