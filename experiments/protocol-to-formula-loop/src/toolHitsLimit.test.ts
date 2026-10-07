/** @jest-environment node */
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rowContextQueries, type ConceptTable } from './conceptTable';
import { loadConditions } from './conditions';
import { createRun, readBudget } from './runDir';
import { main, type Runtime } from './tool';

function setup(count = 10000, version = 'v13') {
  const root = mkdtempSync(join(tmpdir(), 'p2f-hits-'));
  const file = join(root, 'table.json');
  const table: ConceptTable = { concepts: [{ name: '治療', rows: [
    { kind: 'general', label: '総称', mesh: [], terms: ['alpha'] },
    { kind: 'specific', label: '名称', mesh: [], terms: ['beta'] },
  ] }], rctFilter: true };
  const save = () => writeFileSync(file, JSON.stringify(table));
  save();
  const conditions = loadConditions(version);
  const now = () => new Date('2026-01-01T00:00:00Z');
  const dir = createRun({ root, version, pmcid: 'PMC0000001', runIndex: 1, cutoffDate: '2020-01-31', protocolPath: file, conditions, now });
  const queries: string[] = [];
  const counts = new Map<string, number>();
  const runtime: Runtime = { env: { P2F_NCBI_RPS: '100000' }, now, stdout: jest.fn(), stderr: jest.fn(), sleep: async () => undefined,
    fetchImpl: jest.fn(async (input, init) => {
      const url = new URL(String(input));
      if (!url.pathname.endsWith('/esearch.fcgi')) throw new Error('想定外の通信');
      const params = init?.method === 'POST' ? new URLSearchParams(String(init.body)) : url.searchParams;
      expect(Object.fromEntries(params)).toMatchObject({ db: 'pubmed', datetype: 'edat', mindate: '1800/01/01', maxdate: '2020/01/31', retmax: '0' });
      const query = params.get('term')!;
      queries.push(query);
      return new Response(JSON.stringify({ esearchresult: { count: String(counts.get(query) ?? count), idlist: [] } }));
    }) };
  const call = (command: string) => main(['--run', dir, command, file], runtime);
  const output = () => (runtime.stdout as jest.Mock).mock.calls.map(([text]) => text).join('');
  const log = () => JSON.parse(readFileSync(join(dir, 'tool-log.jsonl'), 'utf8'));
  return { dir, file, table, save, runtime, queries, counts, call, output, log };
}

test.each([0, 9999, 10000])('目安以下の count は寄与件数を返し、見直しを求めず測定１回だけ消費する: %i', async (count) => {
  const s = setup(count);
  s.counts.set('alpha[tiab]', 30000);
  s.counts.set(rowContextQueries(s.table)[0]!.query, Math.floor(count / 2));
  expect(await s.call('count')).toBe(0);
  expect(s.output()).toContain(`#1 行 1（総称: 総称）: 30000 件（式全体のうち ${Math.floor(count / 2)} 件）`);
  expect(s.output()).not.toContain('件数の見直し');
  expect(s.queries).toHaveLength(8);
  expect(readBudget(s.dir)).toEqual({ measurements: 1, submissions: 0 });
});
test('超過時は概念１個の注意と、半分以上を持ち込む行だけを案内する', async () => {
  const s = setup(20000);
  const contexts = rowContextQueries(s.table);
  s.counts.set(contexts[0]!.query, 9999);
  s.counts.set(contexts[1]!.query, 10000);
  expect(await s.call('count')).toBe(0);
  expect(s.output()).toContain('\n\n件数の見直し: 全体が 20000 件で、目安の 10000 件を超えています。\n- 概念が 1 個だけです。このレビューを区別する中心の概念がもう 1 つ無いか、手順 1 に戻って確かめてください。');
  expect(s.output()).not.toContain('- #1 行 1');
  expect(s.output()).toContain('- #1 行 2（名称）が、式全体の 50% を持ち込んでいます。その概念に属さない文献まで拾う広すぎる語（一般的な 1 語、類が広すぎる語の組、短すぎる語幹）が無いか確かめてください。その概念を正しく指す語や、個別の名称の行は削らないでください。');
  expect(s.output()).toContain('- 見直しても超えるときは、largeResultReason に「これ以上絞ると、どういう適格な研究を落とすか」を書いて提出してください。\n');
  expect(readBudget(s.dir)).toEqual({ measurements: 1, submissions: 0 });
});
test('寄与の多い順に最大５行を示し、割合は四捨五入する', async () => {
  const s = setup(20000);
  s.table.concepts[0]!.rows = Array.from({ length: 7 }, (_, i) => ({ kind: 'specific', label: `名称${i}`, mesh: [], terms: [`word${i}`] }));
  s.table.concepts.push({ name: '状態', rows: [{ kind: 'specific', label: '状態名', mesh: [], terms: ['condition'] }] });
  s.save();
  const values = [10000, 14000, 17499, 11000, 19000, 12000, 9000, 0];
  rowContextQueries(s.table).forEach((row, i) => s.counts.set(row.query, values[i]!));
  expect(await s.call('count')).toBe(0);
  const advice = s.output().split('\n').filter((line) => line.startsWith('- #'));
  expect(advice).toHaveLength(5);
  expect(advice.map((line) => line.match(/行 (\d+).*全体の (\d+)%/)!.slice(1))).toEqual([['5', '95'], ['3', '87'], ['2', '70'], ['6', '60'], ['4', '55']]);
  expect(s.output()).not.toContain('概念が 1 個だけです');
});
test('概念１個でフィルタがなければ行の件数で寄与を示す', async () => {
  const s = setup(20000);
  s.table.rctFilter = false;
  s.save();
  s.counts.set('alpha[tiab]', 10000);
  s.counts.set('beta[tiab]', 9999);
  expect(await s.call('count')).toBe(0);
  expect(s.output()).toContain('#1 行 1（総称: 総称）: 10000 件（式全体のうち 10000 件）');
  expect(s.output()).toContain('- #1 行 1（総称）が、式全体の 50%');
  expect(s.output()).not.toContain('- #1 行 2');
});
test.each([0, 10000])('目安以下の提出は件数を付けて保存し、測定回数を消費しない: %i', async (count) => {
  const s = setup(count);
  expect(await s.call('submit')).toBe(0);
  expect(s.output()).toBe(`提出 1 を受け付けました（全体 ${count} 件）\n`);
  expect(s.queries).toHaveLength(1);
  expect(readdirSync(join(s.dir, 'submissions')).sort()).toEqual(['1.md', '1.table.json']);
  expect(existsSync(join(s.dir, 'submission.json'))).toBe(true);
  expect(readBudget(s.dir)).toEqual({ measurements: 0, submissions: 1 });
});
test.each([undefined, '', ' \n　\t'])('超過で理由のない提出は１回消費し、何も保存しない: %j', async (largeResultReason) => {
  const s = setup(10001);
  s.table.largeResultReason = largeResultReason;
  s.save();
  expect(await s.call('submit')).toBe(1);
  expect(s.runtime.stderr).toHaveBeenCalledWith('全体が 10001 件で、目安の 10000 件を超えています。count で見直す点を確かめてください。見直しても超えるときは、largeResultReason に理由を書いて提出してください。\n');
  expect(readBudget(s.dir)).toEqual({ measurements: 0, submissions: 1 });
  expect(existsSync(join(s.dir, 'submissions'))).toBe(false);
  expect(existsSync(join(s.dir, 'submission.json'))).toBe(false);
  expect(s.log().result).toBe('検査不合格');
});
test('超過でも理由があれば提出を受け付け、理由を表とともに保存する', async () => {
  const s = setup(10001);
  s.table.largeResultReason = ' 総称を使わない適格な研究を落とすため ';
  s.save();
  expect(await s.call('submit')).toBe(0);
  expect(s.output()).toBe('提出 1 を受け付けました（全体 10001 件）\n');
  expect(JSON.parse(readFileSync(join(s.dir, 'submissions/1.table.json'), 'utf8')).largeResultReason).toBe(s.table.largeResultReason);
  expect(readBudget(s.dir)).toEqual({ measurements: 0, submissions: 1 });
});
test('提出時の測定失敗は結果不明となり、回数を消費せず何も保存しない', async () => {
  const s = setup();
  s.runtime.fetchImpl = jest.fn(async () => { throw new Error('通信失敗'); });
  expect(await s.call('submit')).toBe(3);
  expect(readBudget(s.dir)).toEqual({ measurements: 0, submissions: 0 });
  expect(existsSync(join(s.dir, 'submissions'))).toBe(false);
  expect(existsSync(join(s.dir, 'submission.json'))).toBe(false);
  expect(s.log().result).toBe('測定失敗（結果不明）');
});
test.each([false, true])('寄与件数の測定失敗とクエリ拒否は従来の経路で処理する: %j', async (rejected) => {
  const s = setup();
  const fetchImpl = s.runtime.fetchImpl;
  const target = rowContextQueries(s.table)[0]!.query;
  s.runtime.fetchImpl = jest.fn(async (input, init) => {
    const params = init?.method === 'POST' ? new URLSearchParams(String(init.body)) : new URL(String(input)).searchParams;
    if (params.get('term') !== target) return fetchImpl(input, init);
    if (rejected) return new Response(JSON.stringify({ esearchresult: { ERROR: '検索式が不正です' } }));
    throw new Error('通信失敗');
  });
  expect(await s.call('count')).toBe(rejected ? 1 : 3);
  expect(readBudget(s.dir)).toEqual({ measurements: 0, submissions: 0 });
  expect(s.log().result).toBe(rejected ? '検査不合格' : '測定失敗（結果不明）');
});
test('提出時に式が拒否されたら検査不合格とし、提出を１回消費して何も保存しない', async () => {
  const s = setup();
  s.runtime.fetchImpl = jest.fn(async () => new Response(JSON.stringify({ esearchresult: { ERROR: '検索式が不正です' } })));
  expect(await s.call('submit')).toBe(1);
  expect(readBudget(s.dir)).toEqual({ measurements: 0, submissions: 1 });
  expect(existsSync(join(s.dir, 'submissions'))).toBe(false);
  expect(existsSync(join(s.dir, 'submission.json'))).toBe(false);
  expect(s.log().result).toBe('検査不合格');
});
test('目安のある表でも check は通信しない', async () => {
  const s = setup();
  expect(await s.call('check')).toBe(0);
  expect(s.runtime.fetchImpl).not.toHaveBeenCalled();
  expect(readBudget(s.dir)).toEqual({ measurements: 0, submissions: 0 });
});
test('目安のない表は従来の count 出力と無通信の提出を維持する', async () => {
  const s = setup(20000, 'v11');
  s.table.rctFilter = false;
  s.table.largeResultReason = '理由は無視される';
  s.save();
  expect(await s.call('count')).toBe(0);
  expect(s.output()).toBe('全体: 20000 件\n#1: 20000 件\n#2: 20000 件\n#1 行 1（総称: 総称）: 20000 件\n#1 行 2（個別の名称: 名称）: 20000 件\n');
  s.runtime.fetchImpl = jest.fn(async () => { throw new Error('想定外の通信'); });
  expect(await s.call('submit')).toBe(0);
  expect(s.runtime.stdout).toHaveBeenLastCalledWith('提出 1 を受け付けました\n');
  expect(s.runtime.fetchImpl).not.toHaveBeenCalled();
  expect(existsSync(join(s.dir, 'submission.json'))).toBe(true);
});
