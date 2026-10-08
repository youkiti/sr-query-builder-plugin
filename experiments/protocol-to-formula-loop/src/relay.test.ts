/** @jest-environment node */
import { spawn, spawnSync } from 'node:child_process';
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConditions } from './conditions';
import { main as prepare } from './prepareRuns';
import { parseRequest, serveRun } from './relay';
import { runPath } from './runDir';
import { splitReviews } from './split';
import { fixture, record, review, writeJson, writeLines } from './testFixtures';

const conditions = loadConditions('v1a');
const bytes = (...args: string[]) => Buffer.from(args.length ? args.join('\0') + '\0' : '');
const rejected = 'この呼び出しは受け付けられません（使えるのは check / count / submit に formula.md、mesh に語を 1 つ、だけです）';
test.each(['check', 'count', 'submit'])('%s は固定の式ファイルだけ受け付ける', (command) => {
  expect(parseRequest(bytes(command, 'formula.md'), conditions)).toEqual({ ok: true, args: [command, 'formula.md'] });
});
test('空白を含む MeSH の語をそのまま受け付ける', () => {
  expect(parseRequest(bytes('mesh', 'Heart Failure'), conditions)).toEqual({ ok: true, args: ['mesh', 'Heart Failure'] });
});
test.each([
  ['引数なし', bytes()], ['引数が三個', bytes('count', 'formula.md', 'x')], ['版の道具にない', bytes('titles', 'formula.md')],
  ['親へのパス', bytes('count', '../x.md')], ['絶対パス', bytes('count', 'C:/x.md')], ['別名', bytes('count', 'formula.md.bak')],
  ['語なし', bytes('mesh')], ['長い語', bytes('mesh', 'a'.repeat(201))], ['改行', bytes('mesh', 'a\nb')],
  ['バイト数超過', Buffer.alloc(2001, 97)], ['不正な UTF-8', Buffer.from([0xff, 0])], ['空のコマンド', bytes('', 'formula.md')],
  ['空白だけの語', bytes('mesh', '  ')], ['制御文字', bytes('mesh', 'a\x7fb')], ['余分な NUL', bytes('mesh', 'a', '')],
])('不正な依頼を拒否する: %s', (_label, value) => {
  expect(parseRequest(value as Buffer, conditions)).toEqual({ ok: false, message: rejected });
});

async function until(predicate: () => boolean): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 4000) throw new Error('テストの応答待ちが上限を超えました');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'p2f-relay-'));
  mkdirSync(join(dir, '.relay'));
  const file = (name: string) => join(dir, '.relay', name);
  const read = (name: string) => readFileSync(file(name), 'utf8');
  const request = (id = 'one', value = bytes('mesh', '語')) => writeFileSync(file(`${id}.req`), value);
  const runTool = jest.fn(async () => ({ code: 7, stdout: '出力\n', stderr: '診断\n' }));
  return { dir, file, read, request, runTool };
}

test('一依頼一応答で処理し、完了印の時点で全応答がそろう', async () => {
  const s = setup();
  let complete = false;
  const original = fs.writeFileSync;
  const writer = jest.spyOn(fs, 'writeFileSync').mockImplementation((path, data, options) => {
    if (String(path) === s.file('one.done')) {
      complete = ['out', 'err', 'code'].every((ext) => existsSync(s.file(`one.${ext}`)));
    }
    original(path, data, options);
  });
  const a = serveRun(s.dir, { conditions, runTool: s.runTool, intervalMs: 5 });
  const b = serveRun(s.dir, { conditions, runTool: s.runTool, intervalMs: 5 });
  try {
    s.request(); await until(() => complete);
    expect(s.read('one.out')).toBe('出力\n'); expect(s.read('one.err')).toBe('診断\n'); expect(s.read('one.code')).toBe('7');
    s.request(); await new Promise((resolve) => setTimeout(resolve, 30));
    expect(s.runTool).toHaveBeenCalledTimes(1);
  } finally { await a.stop(); await b.stop(); writer.mockRestore(); }
});

test.each(['引数', '式がディレクトリ', '式が大きすぎる', '依頼がディレクトリ'])('拒否応答は道具を呼ばない: %s', async (kind) => {
  const s = setup();
  if (kind === '式がディレクトリ') mkdirSync(join(s.dir, 'formula.md'));
  if (kind === '式が大きすぎる') writeFileSync(join(s.dir, 'formula.md'), Buffer.alloc(200001));
  if (kind === '依頼がディレクトリ') mkdirSync(s.file('one.req'));
  else s.request('one', bytes('count', kind === '引数' ? '../x.md' : 'formula.md'));
  const relay = serveRun(s.dir, { conditions, runTool: s.runTool, intervalMs: 5 });
  try {
    await until(() => existsSync(s.file('one.done')));
    expect(s.read('one.code')).toBe('2'); expect(s.read('one.err')).toBe(rejected); expect(s.runTool).not.toHaveBeenCalled();
  } finally { await relay.stop(); }
});

const linkProbe = setup();
writeFileSync(join(linkProbe.dir, 'source'), '合成');
let canLink = true;
try { symlinkSync(join(linkProbe.dir, 'source'), join(linkProbe.dir, 'link'), 'file'); }
catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) canLink = false; else throw error; }
(canLink ? test : test.skip)('式や依頼のシンボリックリンクを拒否する（リンク作成権限がない環境だけ省略）', async () => {
  const s = setup();
  symlinkSync(join(linkProbe.dir, 'source'), join(s.dir, 'formula.md'), 'file');
  s.request('one', bytes('count', 'formula.md'));
  symlinkSync(join(linkProbe.dir, 'source'), s.file('two.req'), 'file');
  const relay = serveRun(s.dir, { conditions, runTool: s.runTool, intervalMs: 5 });
  try {
    await until(() => existsSync(s.file('two.done')));
    expect(s.read('one.code')).toBe('2'); expect(s.read('two.code')).toBe('2'); expect(s.runTool).not.toHaveBeenCalled();
  } finally { await relay.stop(); }
});

test.each(['例外', 'タイムアウト'])('道具の%sは秘密を返さず、次の依頼へ進む', async (kind) => {
  const s = setup();
  const runTool = jest.fn().mockImplementationOnce(() => kind === '例外' ? Promise.reject(new Error('合成秘密')) : new Promise(() => undefined))
    .mockResolvedValue({ code: 0, stdout: '次', stderr: '' });
  s.request('a'); s.request('b');
  const relay = serveRun(s.dir, { conditions, runTool, timeoutMs: 10, intervalMs: 5 });
  try {
    await until(() => existsSync(s.file('b.done')));
    expect(s.read('a.code')).toBe('3'); expect(s.read('a.err')).toBe('測定に失敗しました（中継役の内部エラー）');
    expect(s.read('a.out') + s.read('a.err')).not.toContain('合成秘密'); expect(s.read('b.out')).toBe('次');
  } finally { await relay.stop(); }
});

test('不正な依頼名と処理済み印を無視し、存在しない式は道具へ渡す', async () => {
  const s = setup();
  for (const id of ['bad_name', 'a'.repeat(81), 'taken', 'done']) s.request(id);
  writeFileSync(s.file('taken.taken'), ''); writeFileSync(s.file('done.done'), '');
  s.request('valid', bytes('check', 'formula.md'));
  const relay = serveRun(s.dir, { conditions, runTool: s.runTool, intervalMs: 5 });
  try { await until(() => existsSync(s.file('valid.done'))); expect(s.runTool).toHaveBeenCalledTimes(1); }
  finally { await relay.stop(); }
});

test('停止は処理中の応答を書き終えるまで待つ', async () => {
  const s = setup();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const runTool = jest.fn(async () => { await gate; return { code: 0, stdout: '', stderr: '' }; });
  s.request();
  const relay = serveRun(s.dir, { conditions, runTool });
  await until(() => runTool.mock.calls.length === 1);
  let stopped = false;
  const stop = relay.stop().then(() => { stopped = true; });
  await Promise.resolve(); expect(stopped).toBe(false);
  release(); await stop; expect(existsSync(s.file('one.done'))).toBe(true);
});

const bashProbe = spawnSync('bash', ['--version'], { encoding: 'utf8' });
const hasBash = !bashProbe.error && bashProbe.status === 0;
(hasBash ? test.each(['a b', '空白 "引用" 日本語']) : test.skip.each(['a b', '空白 "引用" 日本語']))(
  '準備した bash の入口と中継で引数・出力・終了値が往復する（bash が無ければ省略）: %s', async (term) => {
    const root = mkdtempSync(join(tmpdir(), 'p2f-bash-'));
    const rows = Array.from({ length: 10 }, (_, i) => review(i + 1)); fixture(root, rows);
    const casesDir = join(root, 'cases');
    const selected = rows.find((row) => splitReviews(rows).get(row.pmcid) === 'development')!;
    writeLines(join(casesDir, 'evaluable.jsonl'), rows.map((row) => record(row)));
    writeJson(join(casesDir, 'subsets.json'), { smoke: [selected.pmcid] });
    const dir = runPath(join(root, 'runs'), 'v1a', selected.pmcid, 1); mkdirSync(dir, { recursive: true });
    prepare(['--runs', join(root, 'runs'), '--version', 'v1a', '--subset', 'smoke', '--runs-per-review', '1'], {
      casesDir, env: { COCHRANE_BENCH_DIR: root }, fetchImpl: jest.fn(), now: () => new Date(), stdout: jest.fn(), stderr: jest.fn(),
    });
    const runTool = jest.fn(async () => ({ code: 7, stdout: '返答\n', stderr: '診断\n' }));
    const relay = serveRun(dir, { conditions, runTool, intervalMs: 5 });
    try {
      const reply = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn('bash', [join(dir, 'tool.sh').replace(/\\/g, '/'), 'mesh', term]);
        let stdout = '', stderr = '';
        child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
        child.stdout.on('data', (text: string) => { stdout += text; }); child.stderr.on('data', (text: string) => { stderr += text; });
        child.once('error', reject); child.once('close', (code) => resolve({ code, stdout, stderr }));
      });
      expect(reply).toEqual({ code: 7, stdout: '返答\n', stderr: '診断\n' });
      expect(runTool).toHaveBeenCalledWith(['mesh', term], expect.any(AbortSignal));
    } finally { await relay.stop(); }
  });
