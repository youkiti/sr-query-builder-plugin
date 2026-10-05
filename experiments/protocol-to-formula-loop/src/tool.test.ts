/** @jest-environment node */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';
import { loadConditions } from './conditions';
import { createRun, readBudget, writeJson } from './runDir';
import { main, type Runtime } from './tool';

const json = (body: unknown) => new Response(JSON.stringify(body));
const search = (count = 0, idlist: string[] = []) => json({ esearchresult: { count: String(count), idlist } });
function setup(titles = false) {
  const root = mkdtempSync(join(tmpdir(), 'p2f-tool-'));
  const file = join(root, 'formula.md');
  writeFileSync(file, '## PubMed\n```\n#1 a[tiab]\n#2 b[tiab]\n#3 #1 AND #2\n```\n');
  const conditions = loadConditions('v0');
  if (titles) conditions.tools.push('titles');
  const now = () => new Date('2026-01-01T00:00:00Z');
  const dir = createRun({ root, version: 'v0', pmcid: 'PMC0000001', runIndex: 1, cutoffDate: '2020-01-31', protocolPath: file, conditions, now });
  const runtime: Runtime = { env: { NCBI_API_KEY: 'FAKE_SECRET', P2F_NCBI_RPS: '100000' }, now,
    stdout: jest.fn(), stderr: jest.fn(), sleep: async () => undefined,
    fetchImpl: jest.fn(async () => { throw new Error('想定外の通信'); }) };
  const call = (command: string, argument = file) => main(['--run', dir, command, argument], runtime);
  return { root, dir, file, runtime, call };
}

test('check は通信も予算消費もせず、未知と版で禁止したコマンドを拒否する', async () => {
  const s = setup();
  expect(await s.call('check')).toBe(0);
  expect(await s.call('titles')).toBe(2);
  expect(await s.call('unknown')).toBe(2);
  expect(s.runtime.fetchImpl).not.toHaveBeenCalled();
  expect(readBudget(s.dir)).toEqual({ measurements: 0, submissions: 0 });
});
test('count は全体と全行を edat の検索日条件で測り、20 回目だけ通す', async () => {
  const s = setup();
  s.runtime.fetchImpl = jest.fn(async (input, init) => {
    const url = new URL(String(input));
    if (!url.pathname.endsWith('/esearch.fcgi')) throw new Error('想定外の通信');
    const params = init?.method === 'POST' ? new URLSearchParams(String(init.body)) : url.searchParams;
    expect(Object.fromEntries(params)).toMatchObject({ db: 'pubmed', datetype: 'edat', mindate: '1800/01/01', maxdate: '2020/01/31', retmax: '0' });
    return search(0);
  });
  writeJson(join(s.dir, 'budget.json'), { measurements: 19, submissions: 0 });
  expect(await s.call('count')).toBe(0);
  expect(s.runtime.fetchImpl).toHaveBeenCalledTimes(4);
  expect(await s.call('count')).toBe(2);
  expect(s.runtime.fetchImpl).toHaveBeenCalledTimes(4);
  expect(readBudget(s.dir).measurements).toBe(20);
  expect(String((s.runtime.stdout as jest.Mock).mock.calls)).toContain('全体: 0 件');
});
test('不合格の count と titles は消費せず、submit は消費する。4 回目は通り5 回目は拒否する', async () => {
  const s = setup(true);
  const valid = readFileSync(s.file, 'utf8');
  writeFileSync(s.file, '不正');
  expect(await s.call('count')).toBe(1);
  expect(await s.call('titles')).toBe(1);
  expect(await s.call('check')).toBe(1);
  expect(await s.call('submit')).toBe(1);
  expect(readBudget(s.dir)).toEqual({ measurements: 0, submissions: 1 });
  expect(existsSync(join(s.dir, 'submission.json'))).toBe(false);
  writeFileSync(s.file, valid);
  expect(await s.call('submit')).toBe(0);
  expect(await s.call('submit')).toBe(0);
  expect(await s.call('submit')).toBe(0);
  expect(await s.call('submit')).toBe(2);
  expect(JSON.parse(readFileSync(join(s.dir, 'submission.json'), 'utf8'))).toMatchObject({ number: 4, query: '(a[tiab]) AND (b[tiab])' });
  expect(readFileSync(join(s.dir, 'submissions/4.md'), 'utf8')).toBe(valid);
  expect(s.runtime.fetchImpl).not.toHaveBeenCalled();
});
test('途中の測定失敗で回数を減らさず、キーも件数も出さない', async () => {
  const s = setup();
  let calls = 0;
  s.runtime.fetchImpl = jest.fn(async (input) => {
    if (!String(input).includes('/esearch.fcgi')) throw new Error('想定外の通信');
    if (++calls === 1) return search(12);
    throw new Error('通信失敗 FAKE_SECRET ?api_key=FAKE_SECRET');
  });
  expect(await s.call('count')).toBe(3);
  expect(readBudget(s.dir).measurements).toBe(0);
  const output = JSON.stringify([ (s.runtime.stdout as jest.Mock).mock.calls, (s.runtime.stderr as jest.Mock).mock.calls ]);
  expect(output).toContain('回数は消費していません');
  expect(output).not.toMatch(/FAKE_SECRET|12 件|0 件/);
  expect(readFileSync(join(s.dir, 'tool-log.jsonl'), 'utf8')).not.toContain('FAKE_SECRET');
  expect(JSON.parse(readFileSync(join(s.dir, 'tool-log.jsonl'), 'utf8')).result).toBe('測定失敗（結果不明）');
});
test.each(['resolved', 'missing', 'unknown'])('mesh の存在・不在・不明を区別する: %s', async (status) => {
  const s = setup();
  s.runtime.fetchImpl = jest.fn(async (input) => {
    const url = new URL(String(input));
    if (url.searchParams.get('db') !== 'mesh') throw new Error('想定外の通信');
    if (url.pathname.endsWith('/esearch.fcgi')) return status === 'unknown' ? json({}) : search(status === 'missing' ? 0 : 1, status === 'missing' ? [] : ['11111111']);
    if (url.pathname.endsWith('/esummary.fcgi')) return json({ result: { uids: ['11111111'], '11111111': {
      ds_recordtype: 'descriptor', ds_meshterms: ['合成見出し'], ds_idxlinks: [{ treenum: 'A01.001' }],
    } } });
    throw new Error('想定外の通信');
  });
  expect(await s.call('mesh', '合成見出し')).toBe(status === 'unknown' ? 3 : 0);
  expect(readBudget(s.dir).measurements).toBe(status === 'unknown' ? 0 : 1);
  if (status === 'resolved') expect(String((s.runtime.stdout as jest.Mock).mock.calls)).toContain('A01.001');
});
test('タイムアウトを測定失敗として記録し、予算を消費しない', async () => {
  const s = setup();
  s.runtime.timeoutMs = 1;
  s.runtime.fetchImpl = jest.fn((input, init) => {
    if (!String(input).includes('/esearch.fcgi')) throw new Error('想定外の通信');
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('制限時間を超えました')));
    });
  });
  expect(await s.call('count')).toBe(3);
  expect(readBudget(s.dir).measurements).toBe(0);
  expect(String((s.runtime.stderr as jest.Mock).mock.calls)).toContain('回数は消費していません');
});
test('有効な版の titles は10件を要求して題だけ返す', async () => {
  const s = setup(true);
  const ids = Array.from({ length: 10 }, (_, i) => String(11111111 + i));
  s.runtime.fetchImpl = jest.fn(async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/esearch.fcgi')) { expect(url.searchParams.get('retmax')).toBe('10'); return search(15, ids); }
    if (url.pathname.endsWith('/esummary.fcgi')) return json({ result: Object.fromEntries(ids.map((id) => [id, { title: '合成の題' }])) });
    throw new Error('想定外の通信');
  });
  expect(await s.call('titles')).toBe(0);
  expect(readBudget(s.dir).measurements).toBe(1);
  const output = String((s.runtime.stdout as jest.Mock).mock.calls);
  expect(output).toContain('10. 合成の題');
  expect(output).not.toMatch(/11111111|FAKE_SECRET/);
});
test('道具から辿れる静的・動的 import と再公開に正解集合のモジュールがない', () => {
  const root = resolve(__dirname, '../../..');
  const forbidden = new Set(['bench', 'evaluable', 'baseline', 'metrics', 'cases', 'labels', 'subsets'].map((name) => resolve(__dirname, `${name}.ts`)));
  const visited = new Set<string>();
  const walk = (path: string): void => {
    expect(forbidden.has(path)).toBe(false);
    if (visited.has(path)) return;
    visited.add(path);
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      let spec: string | undefined;
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) spec = node.moduleSpecifier.text;
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === 'require')) {
        expect(node.arguments.length).toBe(1);
        expect(ts.isStringLiteral(node.arguments[0]!)).toBe(true);
        if (ts.isStringLiteral(node.arguments[0]!)) spec = node.arguments[0]!.text;
      }
      if (spec?.startsWith('.') || spec?.startsWith('@/')) {
        const base = spec.startsWith('@/') ? resolve(root, 'src', spec.slice(2)) : resolve(dirname(path), spec);
        const target = [`${base}.ts`, join(base, 'index.ts')].find(existsSync);
        expect(target).toBeDefined();
        if (target) walk(target);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  };
  walk(join(__dirname, 'tool.ts'));
  expect(visited.size).toBeGreaterThan(5);
});

test.each(['count', 'titles'])('PubMedの拒否は検査不合格で予算を使わない: %s', async (command) => {
  const s = setup(true);
  s.runtime.fetchImpl = jest.fn(async () => json({ esearchresult: { errorlist: { fieldsnotfound: ['tiabb FAKE_SECRET'] } } }));
  expect(await s.call(command)).toBe(1);
  expect(readBudget(s.dir).measurements).toBe(0);
  expect(JSON.parse(readFileSync(join(s.dir, 'tool-log.jsonl'), 'utf8')).result).toBe('検査不合格');
  expect(String((s.runtime.stderr as jest.Mock).mock.calls)).toContain('不明なフィールドタグ');
  expect(String((s.runtime.stderr as jest.Mock).mock.calls)).not.toContain('FAKE_SECRET');
  expect(existsSync(join(s.dir, '.lock'))).toBe(false);
});
test.each(['count', 'submit'])('ロックの上限では予算・提出・ログに書かない: %s', async (command) => {
  const s = setup();
  mkdirSync(join(s.dir, '.lock'));
  const before = readFileSync(join(s.dir, 'budget.json'), 'utf8');
  let now = Date.now();
  s.runtime.lockOptions = { timeoutMs: 400, now: () => now, sleep: async (ms) => { now += ms; } };
  expect(await s.call(command)).toBe(3);
  expect(readFileSync(join(s.dir, 'budget.json'), 'utf8')).toBe(before);
  expect(existsSync(join(s.dir, 'submission.json'))).toBe(false);
  expect(existsSync(join(s.dir, 'submissions'))).toBe(false);
  expect(existsSync(join(s.dir, 'tool-log.jsonl'))).toBe(false);
  expect(s.runtime.fetchImpl).not.toHaveBeenCalled();
  expect(String((s.runtime.stderr as jest.Mock).mock.calls)).toContain('同じ実行フォルダ');
});
test('同時の測定と提出を直列化し、両方の予算を保つ', async () => {
  const s = setup();
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  s.runtime.fetchImpl = jest.fn(async () => { entered(); await gate; return search(0); });
  const count = s.call('count');
  await started;
  const sleep = jest.fn(async () => { expect(existsSync(join(s.dir, 'submission.json'))).toBe(false); release(); await count; });
  s.runtime.lockOptions = { sleep };
  const submit = s.call('submit');
  expect(await count).toBe(0);
  expect(await submit).toBe(0);
  expect(sleep).toHaveBeenCalledWith(200);
  expect(readBudget(s.dir)).toEqual({ measurements: 1, submissions: 1 });
  expect(readFileSync(join(s.dir, 'tool-log.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2);
});

test('残り1回の測定が競合しても20回目だけ通す', async () => {
  const s = setup();
  writeJson(join(s.dir, 'budget.json'), { measurements: 19, submissions: 0 });
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  s.runtime.fetchImpl = jest.fn(async () => { entered(); await gate; return search(0); });
  const first = s.call('count');
  await started;
  s.runtime.lockOptions = { sleep: async () => { release(); await first; } };
  const second = s.call('count');
  expect(await first).toBe(0);
  expect(await second).toBe(2);
  expect(readBudget(s.dir).measurements).toBe(20);
  expect(s.runtime.fetchImpl).toHaveBeenCalledTimes(4);
});
