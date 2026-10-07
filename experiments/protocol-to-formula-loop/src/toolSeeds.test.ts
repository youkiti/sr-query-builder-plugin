/** @jest-environment node */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConditions } from './conditions';
import { createRun, readBudget, writeJson } from './runDir';
import { main, type Runtime } from './tool';

function setup(allowed = true) {
  const root = mkdtempSync(join(tmpdir(), 'p2f-tool-seeds-')), file = join(root, 'formula.md');
  writeFileSync(file, '## PubMed\n```\n#1 a[tiab]\n#2 b[tiab]\n#3 #1 NOT #2\n```\n');
  const conditions = loadConditions('v0'); if (allowed) conditions.tools.push('seeds');
  const now = () => new Date('2026-01-01');
  const dir = createRun({ root, version: 'v0', pmcid: 'PMC0000001', runIndex: 1, cutoffDate: '2020-01-31', protocolPath: file, conditions, now });
  writeJson(join(dir, 'seeds.json'), { pmids: ['90000001', '90000002', '90000003'] });
  const runtime: Runtime = { env: { NCBI_API_KEY: 'FAKE_SECRET' }, now, stdout: jest.fn(), stderr: jest.fn(), sleep: async () => undefined,
    rateLimiter: { acquire: jest.fn(async () => undefined) }, fetchImpl: jest.fn(async () => { throw new Error('想定外の通信'); }) };
  const call = () => main(['--run', dir, 'seeds', file], runtime);
  return { dir, file, runtime, call };
}
test('全体と非結合行を検索日条件で測り、捕捉・行の欠落・組み合わせでの欠落を出す', async () => {
  const s = setup(); const lists = [['90000001'], ['90000001', '90000003'], ['90000001', '90000002', '90000003']];
  let index = 0;
  s.runtime.fetchImpl = jest.fn(async (input, init) => {
    const url = new URL(String(input)), params = init?.method === 'POST' ? new URLSearchParams(String(init.body)) : url.searchParams;
    expect(params.get('datetype')).toBe('edat'); expect(params.get('maxdate')).toBe('2020/01/31');
    expect(params.get('term')).toContain('90000001[uid]');
    const idlist = lists[index++]!; return new Response(JSON.stringify({ esearchresult: { count: String(idlist.length), idlist } }));
  });
  expect(await s.call()).toBe(0); expect(s.runtime.fetchImpl).toHaveBeenCalledTimes(3);
  expect(s.runtime.stdout).toHaveBeenCalledWith('シード 1（90000001）: 式に入っています\nシード 2（90000002）: 式に入っていません。当てはまらない行: #1\nシード 3（90000003）: 式に入っていません。当てはまらない行: なし（行の組み合わせで外れています）\n');
  expect(readBudget(s.dir).measurements).toBe(1);
  expect(JSON.parse(readFileSync(join(s.dir, 'tool-log.jsonl'), 'utf8'))).toMatchObject({ args: '式ファイル 1 件', result: '成功' });
});
test('シードなしは上限でも通信せず成功して回数を消費しない', async () => {
  const s = setup(); writeJson(join(s.dir, 'seeds.json'), { pmids: [] }); writeJson(join(s.dir, 'budget.json'), { measurements: 20, submissions: 0 });
  expect(await s.call()).toBe(0); expect(s.runtime.stdout).toHaveBeenCalledWith('シード論文はありません\n');
  expect(s.runtime.fetchImpl).not.toHaveBeenCalled(); expect(readBudget(s.dir).measurements).toBe(20);
});
test('シードありの上限と版による禁止は通信前に拒否する', async () => {
  const s = setup(); writeJson(join(s.dir, 'budget.json'), { measurements: 20, submissions: 0 });
  expect(await s.call()).toBe(2); expect(s.runtime.fetchImpl).not.toHaveBeenCalled();
  const forbidden = setup(false); expect(await forbidden.call()).toBe(2); expect(forbidden.runtime.fetchImpl).not.toHaveBeenCalled();
});
test('全体の捕捉に成功しても行の結果が不明なら何も返さず回数を消費しない', async () => {
  const s = setup(); let requests = 0;
  s.runtime.fetchImpl = jest.fn(async () => {
    if (++requests > 1) throw new Error('行の通信に失敗しました');
    return new Response(JSON.stringify({ esearchresult: { count: '1', idlist: ['90000001'] } }));
  });
  expect(await s.call()).toBe(3); expect(s.runtime.stdout).not.toHaveBeenCalled(); expect(readBudget(s.dir).measurements).toBe(0);
});
test.each(['拒否', '通信失敗', '不完全'])('測定の%sを不捕捉にせず、回数も消費しない', async (mode) => {
  const s = setup();
  s.runtime.fetchImpl = jest.fn(async () => {
    if (mode === '通信失敗') throw new Error('FAKE_SECRET PMC1234567 題 alpha[tiab]');
    return new Response(JSON.stringify({ esearchresult: mode === '拒否'
      ? { ERROR: 'FAKE_SECRET PMC1234567 題 alpha[tiab]' } : { count: '2', idlist: ['90000001'] } }));
  });
  expect(await s.call()).toBe(mode === '拒否' ? 1 : 3); expect(readBudget(s.dir).measurements).toBe(0);
  expect(s.runtime.stdout).not.toHaveBeenCalled();
  expect(JSON.stringify((s.runtime.stderr as jest.Mock).mock.calls)).not.toMatch(/FAKE_SECRET|PMC1234567|alpha|90000001/);
  expect(JSON.parse(readFileSync(join(s.dir, 'tool-log.jsonl'), 'utf8')).result).toBe(mode === '拒否' ? '検査不合格' : '測定失敗（結果不明）');
});
