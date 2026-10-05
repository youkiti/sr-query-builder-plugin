/** @jest-environment node */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from './freezeEvaluable';
import { loadEvaluable } from './evaluable';
import { fixture, review, writeLines } from './testFixtures';
import type { Runtime } from './tool';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'p2f-freeze-'));
  const casesDir = join(root, 'cases');
  const rows = [review(), review(2), review(3)];
  fixture(root, rows);
  writeLines(join(root, 'data/processed/cc-by/gold/task2_search_screen.jsonl'), rows.map((row, i) => ({ pmcid: row.pmcid,
    included_pmids: i === 2 ? [] : [String(11111111 + i)], pmid_to_study_id: {} })));
  const runtime: Runtime & { casesDir: string } = { casesDir, env: { COCHRANE_BENCH_DIR: root, P2F_NCBI_RPS: '100000', NCBI_API_KEY: 'FAKE_SECRET' },
    now: () => new Date('2026-01-01Z'), stdout: jest.fn(), stderr: jest.fn(), sleep: async () => undefined,
    fetchImpl: jest.fn(async () => { throw new Error('想定外の通信'); }) };
  return { root, casesDir, rows, runtime };
}

test('1件ずつ追記し、空は通信せず、再開で飛ばし、強制時は最終行で置き換える', async () => {
  const s = setup();
  const path = join(s.casesDir, 'evaluable.jsonl');
  s.runtime.fetchImpl = jest.fn(async (input) => {
    const url = new URL(String(input));
    if (!url.pathname.endsWith('/esearch.fcgi')) throw new Error('想定外の通信');
    const term = url.searchParams.get('term')!;
    const id = term.includes('11111111') ? '11111111' : '11111112';
    if (id === '11111112') expect(readFileSync(path, 'utf8')).toContain('PMC0000001');
    if (url.searchParams.has('maxdate')) expect(url.searchParams.get('datetype')).toBe('edat');
    return new Response(JSON.stringify({ esearchresult: { count: '1', idlist: [id] } }));
  });
  expect(await main([], s.runtime)).toBe(0);
  expect(s.runtime.fetchImpl).toHaveBeenCalledTimes(4);
  expect(loadEvaluable(s.casesDir).get('PMC0000003')).toMatchObject({ existing: [], withinCutoff: [] });
  expect(await main([], s.runtime)).toBe(0);
  expect(s.runtime.fetchImpl).toHaveBeenCalledTimes(4);
  expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(3);
  s.runtime.fetchImpl = jest.fn(async (input) => {
    if (!String(input).includes('/esearch.fcgi')) throw new Error('想定外の通信');
    return new Response(JSON.stringify({ esearchresult: { count: '0', idlist: [] } }));
  });
  expect(await main(['--force'], s.runtime)).toBe(0);
  expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(6);
  expect(loadEvaluable(s.casesDir).get('PMC0000001')!.existing).toEqual([]);
  expect(String((s.runtime.stdout as jest.Mock).mock.calls)).not.toMatch(/PMC000000|11111111|11111112/);
});
test('失敗は記録せず次へ進み、終了コード1とマスクした要約を返す', async () => {
  const s = setup();
  s.runtime.fetchImpl = jest.fn(async (input) => {
    const url = new URL(String(input));
    if (!url.pathname.endsWith('/esearch.fcgi')) throw new Error('想定外の通信');
    if (url.searchParams.get('term')!.includes('11111111')) throw new Error('失敗 FAKE_SECRET');
    expect(existsSync(join(s.casesDir, 'evaluable.jsonl'))).toBe(false);
    return new Response(JSON.stringify({ esearchresult: { count: '1', idlist: ['11111112'] } }));
  });
  expect(await main([], s.runtime)).toBe(1);
  expect([...loadEvaluable(s.casesDir).keys()]).toEqual(['PMC0000002', 'PMC0000003']);
  const errors = String((s.runtime.stderr as jest.Mock).mock.calls);
  expect(errors).toContain('PMC0000001');
  expect(errors).not.toContain('FAKE_SECRET');
  expect(String((s.runtime.stdout as jest.Mock).mock.calls)).toContain('失敗: 1 件');
});

test('集計表は評価不能と原著式0件を分け、残る対象だけ数える', async () => {
  const s = setup();
  const rows = [review(1), { ...review(2), n_records: 0 }, { ...review(3), n_records: 0 }];
  fixture(s.root, rows);
  writeLines(join(s.casesDir, 'evaluable.jsonl'), rows.map((row, i) => ({ pmcid: row.pmcid, cutoffDate: row.cutoffDate,
    measuredAt: s.runtime.now().toISOString(), existing: row.includedPmids, withinCutoff: i === 2 ? [] : row.includedPmids })));
  expect(await main([], s.runtime)).toBe(0);
  const output = (s.runtime.stdout as jest.Mock).mock.calls.map(([text]) => String(text)).join('');
  expect(output).toContain('評価可能な研究なし\t原著式 0 件\t残るレビュー数');
  const columns = output.split('\n').find((line) => line.startsWith('cc-by\t'))!.split('\t');
  expect(columns.slice(4, 7)).toEqual(['1', '1', '1']);
  expect(s.runtime.fetchImpl).not.toHaveBeenCalled();
});
