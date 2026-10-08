/** @jest-environment node */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { main, parseOptions } from './geminiRun';
import { loadConditions } from './conditions';
import { runPath } from './runDir';
import { splitReviews } from './split';
import type { RunRuntime } from './startRuns';
import * as tool from './tool';
import { fixture, record, review, writeJson, writeLines } from './testFixtures';

const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const formula = '## PubMed\n```\n#1 synthetic[tiab]\n#2 example[tiab]\n#3 #1 AND #2\n```\n';
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const reply = (...parts: unknown[]) => ({ candidates: [{ content: { role: 'model', parts } }], modelVersion: '固定モデル',
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 } });
const call = (name: string, args: Record<string, unknown>) => reply({ functionCall: { name, args }, thoughtSignature: '合成署名' });
const done = () => reply({ text: '提出した式の説明' });
function setup(responses: (unknown | Response | Error)[] = [done()], runs = 1, concurrency = 1) {
  const root = mkdtempSync(join(tmpdir(), 'p2f-gemini-'));
  const casesDir = join(root, 'cases');
  const harnessDir = join(root, 'harness');
  const rows = Array.from({ length: 10 }, (_, i) => review(i + 1));
  fixture(root, rows);
  const selected = rows.find((row) => splitReviews(rows).get(row.pmcid) === 'development')!;
  writeLines(join(casesDir, 'evaluable.jsonl'), rows.map((row) => record(row)));
  writeJson(join(casesDir, 'subsets.json'), { smoke: [selected.pmcid] });
  mkdirSync(join(casesDir, selected.pmcid));
  writeFileSync(join(casesDir, selected.pmcid, 'protocol.md'), '合成プロトコルの全文');
  const conditions = { ...loadConditions('v0'), model: 'gemini-2.5-flash', runner: 'gemini-api' };
  const conditionFile = join(harnessDir, 'v0', 'conditions.json');
  writeJson(conditionFile, conditions);
  writeFileSync(join(harnessDir, 'v0', 'procedure.md'), '渡さない前書き\n---\n合成手順書の本文');
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = jest.fn<Promise<Response>, Parameters<typeof fetch>>(async (input, init) => {
    if (String(input) !== url || init?.method !== 'POST') throw new Error('想定外の通信です');
    expect(init.headers).toEqual({ 'x-goog-api-key': '合成Gemini秘密', 'Content-Type': 'application/json' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    if (!responses.length) throw new Error('合成応答が不足しています');
    const value = responses.shift();
    if (value instanceof Error) throw value;
    return value instanceof Response ? value : json(value);
  });
  const runtime: RunRuntime = { casesDir, harnessDir, env: { COCHRANE_BENCH_DIR: root, GEMINI_API_KEY: '合成Gemini秘密', NCBI_API_KEY: '合成NCBI秘密' },
    now: () => new Date('2026-01-01T00:00:00Z'), stdout: jest.fn(), stderr: jest.fn(), sleep: jest.fn(async () => undefined), fetchImpl };
  const args = ['--runs', join(root, 'runs'), '--version', 'v0', '--subset', 'smoke', '--runs-per-review', String(runs), '--concurrency', String(concurrency)];
  const dir = runPath(join(root, 'runs'), 'v0', selected.pmcid, 1);
  const read = (name: string) => readFileSync(join(dir, name), 'utf8');
  const agent = () => JSON.parse(read('agent.json')) as Record<string, unknown>;
  return { args, runtime, dir, read, agent, fetchImpl, bodies, responses, conditions, conditionFile };
}
afterEach(() => jest.restoreAllMocks());

test('関数を往復して提出し、手順書と設定と入力だけを送り、署名を含む応答を保持する', async () => {
  const s = setup([call('write_formula', { content: formula }), call('tool', { command: 'check' }), call('tool', { command: 'submit' }), done()]);
  expect(await main(s.args, s.runtime)).toBe(0);
  expect(s.agent()).toMatchObject({ status: 'completed', turns: 4, promptTokens: 40, outputTokens: 8, modelVersion: '固定モデル' });
  expect(JSON.parse(s.read('submission.json'))).toMatchObject({ number: 1 });
  expect(s.read('final.txt')).toBe('提出した式の説明');
  const body = JSON.stringify(s.bodies[0]);
  expect(body).toContain('合成手順書の本文'); expect(body).toContain('## この作業の設定'); expect(body).toContain('合成プロトコルの全文');
  expect(body).not.toContain('渡さない前書き'); expect(body).not.toContain('generationConfig');
  expect(body).toContain('"enum":["check","count","mesh","submit"]');
  expect(JSON.stringify(s.bodies[1])).toContain('合成署名');
  expect(JSON.stringify(s.bodies[2])).toContain('[終了コード 0]');
  expect(s.read('agent-log.jsonl').trim().split('\n')).toHaveLength(4);
  expect(s.read('agent-log.jsonl')).not.toContain('synthetic');
  expect(s.runtime.stdout).toHaveBeenCalledWith('completed: 1 件\n');
  expect(String((s.runtime.stdout as jest.Mock).mock.calls)).not.toContain('PMC');
  expect(JSON.stringify(s.fetchImpl.mock.calls.map(([input]) => input)) + s.read('agent-log.jsonl') + s.read('agent.json')
    + String((s.runtime.stdout as jest.Mock).mock.calls)).not.toMatch(/合成Gemini秘密|合成NCBI秘密/);
});

test.each(['check', 'count', 'submit', 'titles', 'outside'])('式のない %s は道具を呼ばずに書き込みを促す', async (command) => {
  const s = setup([call('tool', { command, argument: '1' }), done()]);
  writeJson(s.conditionFile, { ...s.conditions, tools: ['check', 'count', 'submit', 'titles', 'outside'] });
  const spy = jest.spyOn(tool, 'main');
  expect(await main(s.args, s.runtime)).toBe(0);
  expect(spy).not.toHaveBeenCalled();
  expect(JSON.stringify(s.bodies[1])).toContain('先に write_formula');
});

test('複数関数は先頭だけ実行し、非文字列の式と未知の関数やコマンドも拒否する', async () => {
  const s = setup([reply({ functionCall: { name: 'write_formula', args: { content: formula } } },
    { functionCall: { name: 'tool', args: { command: 'submit' } } }), call('write_formula', { content: 12 }),
    call('unknown', {}), call('tool', { command: 'unknown' }), done()]);
  expect(await main(s.args, s.runtime)).toBe(0);
  expect(s.read('formula.md')).toBe(formula); expect(existsSync(join(s.dir, 'submission.json'))).toBe(false);
  expect(JSON.stringify(s.bodies[1])).toContain('最初の 1 つだけ');
  expect(JSON.stringify(s.bodies[4])).toContain('文字列で指定');
});

test('関数呼び出しが続いても 60 回で終了する', async () => {
  const s = setup(Array.from({ length: 60 }, () => call('write_formula', { content: formula })));
  expect(await main(s.args, s.runtime)).toBe(0);
  expect(s.agent()).toMatchObject({ status: 'max_turns', turns: 60 }); expect(s.fetchImpl).toHaveBeenCalledTimes(60);
  expect(await main(s.args, s.runtime)).toBe(0); expect(s.fetchImpl).toHaveBeenCalledTimes(60);
});

test.each([429, 500, 502, 503, 504])('HTTP %i は再試行して成功する', async (status) => {
  const s = setup([json({}, status), done()]);
  expect(await main(s.args, s.runtime)).toBe(0); expect(s.fetchImpl).toHaveBeenCalledTimes(2);
  expect(s.runtime.sleep).toHaveBeenCalledWith(1000); expect(s.agent().status).toBe('completed');
  expect(s.read('agent-log.jsonl').trim().split('\n')).toHaveLength(2);
});

test.each([new Error('合成Gemini秘密 と 合成NCBI秘密'), new Response('不正な JSON'), json({ error: '合成Gemini秘密' })])(
  '通信例外と不正な成功応答は再試行する: %#', async (failure) => {
    const s = setup([failure, done()]);
    expect(await main(s.args, s.runtime)).toBe(0); expect(s.fetchImpl).toHaveBeenCalledTimes(2);
    expect(s.read('agent-log.jsonl')).not.toMatch(/合成Gemini秘密|合成NCBI秘密/);
  });

test('再試行を使い切ると理由を伏せ字で保存し、別の実行を続けて終了コード 1 を返す', async () => {
  const s = setup([...Array.from({ length: 6 }, () => new Error('合成Gemini秘密 と 合成NCBI秘密')), done()], 2);
  expect(await main(s.args, s.runtime)).toBe(1); expect(s.fetchImpl).toHaveBeenCalledTimes(7);
  expect(s.agent()).toMatchObject({ status: 'error', turns: 1 }); expect(s.agent().note).toContain('[REDACTED]');
  expect(s.read('agent.json') + s.read('agent-log.jsonl')).not.toMatch(/合成Gemini秘密|合成NCBI秘密/);
  expect((s.runtime.sleep as jest.Mock).mock.calls.map(([ms]) => ms)).toEqual([1000, 2000, 4000, 8000, 16000]);
  expect(JSON.parse(readFileSync(join(dirname(s.dir), 'run-2', 'agent.json'), 'utf8')).status).toBe('completed');
  expect(s.runtime.stdout).toHaveBeenCalledWith('error: 1 件\n');
});

test('400 は再試行せずエラーにする', async () => {
  const s = setup([json({ error: '合成Gemini秘密' }, 400)]);
  expect(await main(s.args, s.runtime)).toBe(1); expect(s.fetchImpl).toHaveBeenCalledTimes(1);
  expect(s.runtime.sleep).not.toHaveBeenCalled(); expect(s.agent().note).toContain('400');
});

test.each([{ candidates: [] }, { candidates: [{ finishReason: 'SAFETY' }] }, { candidates: [{ content: { parts: [] } }] }])(
  '空応答は一度だけ促してから理由を残して終了する: %j', async (empty) => {
    const s = setup([empty, empty]);
    expect(await main(s.args, s.runtime)).toBe(0); expect(s.fetchImpl).toHaveBeenCalledTimes(2);
    expect(s.agent()).toMatchObject({ status: 'completed', note: '応答が 2 回続けて空でした', modelVersion: null });
    expect(JSON.stringify(s.bodies[1])).toContain('応答が空でした。続けてください。');
  });

test('空応答の連続判定は関数の応答でリセットする', async () => {
  const s = setup([{}, call('write_formula', { content: formula }), {}, done()]);
  expect(await main(s.args, s.runtime)).toBe(0); expect(s.agent()).toMatchObject({ turns: 4, status: 'completed' });
});

test('完了済みは再開で飛ばす', async () => {
  const s = setup(); await main(s.args, s.runtime);
  expect(await main(s.args, s.runtime)).toBe(0); expect(s.fetchImpl).toHaveBeenCalledTimes(1);
  expect(s.runtime.stdout).toHaveBeenCalledWith('済みで省略: 1 件\n');
});

test.each([true, false])('失敗または未記録のフォルダは内容を保って改名する: %s', async (hasAgent) => {
  const s = setup(); mkdirSync(s.dir, { recursive: true });
  writeFileSync(join(s.dir, '途中.txt'), '途中までの実行');
  if (hasAgent) writeJson(join(s.dir, 'agent.json'), { status: 'error' });
  const collision = `${s.dir}.failed-20260101T000000Z`;
  mkdirSync(collision); writeFileSync(join(collision, '保存.txt'), '既存');
  expect(await main(s.args, s.runtime)).toBe(0);
  expect(readFileSync(`${s.dir}.failed-20260101T000001Z/途中.txt`, 'utf8')).toBe('途中までの実行');
  expect(readFileSync(join(collision, '保存.txt'), 'utf8')).toBe('既存');
  expect(s.agent().status).toBe('completed'); expect(s.runtime.stdout).toHaveBeenCalledWith('作り直し: 1 件\n');
});

test.each([{ runner: undefined }, { runner: 'claude-subagent' }, { combine: { from: 'v1', k: 2 } }])('対象外の版を拒否する: %j', async (change) => {
  const s = setup(); writeJson(s.conditionFile, { ...s.conditions, ...change });
  await expect(main(s.args, s.runtime)).rejects.toThrow(); expect(s.fetchImpl).not.toHaveBeenCalled();
});

test('試験群の保護と並行数の範囲とキーの存在を検査する', async () => {
  const s = setup(); const args = s.args.map((arg) => arg === 'smoke' ? 'test' : arg);
  await expect(main(args, s.runtime)).rejects.toThrow('--open-test-set');
  expect(parseOptions([...args, '--open-test-set']).openTestSet).toBe(true);
  expect(parseOptions(s.args.slice(0, -2)).concurrency).toBe(4);
  for (const value of ['0', '9', '1.5', 'x', '--version']) expect(() => parseOptions([...s.args.slice(0, -1), value])).toThrow('並行数');
  expect(() => parseOptions([...s.args, '--concurrency', '2'])).toThrow('並行数');
  delete s.runtime.env.GEMINI_API_KEY;
  await expect(main(s.args, s.runtime)).rejects.toThrow('GEMINI_API_KEY');
});

test.each([undefined, '12'])('道具のレート設定を保ち、道具の例外にも両キーを伏せる: %s', async (rps) => {
  const s = setup([call('write_formula', { content: formula }), call('tool', { command: 'check' }), done()], 1, 4);
  s.runtime.env.P2F_NCBI_RPS = rps;
  const spy = jest.spyOn(tool, 'main').mockImplementation(async (_args, runtime) => {
    expect(runtime!.env.P2F_NCBI_RPS).toBe(rps);
    expect(runtime!.rateLimiter).toBeDefined();
    throw new Error('合成Gemini秘密 と 合成NCBI秘密');
  });
  expect(await main(s.args, s.runtime)).toBe(0); expect(spy).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(s.bodies[2])).toContain('[終了コード 1]');
  expect(JSON.stringify(s.bodies[2])).not.toMatch(/合成Gemini秘密|合成NCBI秘密/);
});

test.each([false, true])('複数関数への応答は順序と識別子を保ち、後続の道具と書き込みは実行しない: %s', async (withId) => {
  const first = { name: 'tool', args: { command: 'submit' }, ...(withId ? { id: '合成呼出1' } : {}) };
  for (const second of [
    { name: 'tool', args: { command: 'submit' }, ...(withId ? { id: '合成呼出2' } : {}) },
    { name: 'write_formula', args: { content: '上書きしない式' }, ...(withId ? { id: '合成呼出2' } : {}) },
  ]) {
    const s = setup([call('write_formula', { content: formula }), reply({ functionCall: first }, { functionCall: second }), done()]);
    const spy = jest.spyOn(tool, 'main');
    expect(await main(s.args, s.runtime)).toBe(0);
    const contents = s.bodies[2]!.contents as { parts: unknown[] }[];
    expect(contents[contents.length - 1]!.parts).toEqual([
      { functionResponse: { name: first.name, ...(withId ? { id: first.id } : {}), response: { result: expect.stringContaining('提出 1 を受け付けました') } } },
      { functionResponse: { name: second.name, ...(withId ? { id: second.id } : {}), response: { result: '未実行: 関数は 1 回の応答で 1 つずつ呼んでください。' } } },
    ]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(s.read('budget.json'))).toEqual({ measurements: 0, submissions: 1 });
    expect(s.read('formula.md')).toBe(formula);
    spy.mockRestore();
  }
});

test.each([undefined, '4'])('並行する二実行の全道具呼び出しが共有レートの間隔を守る: %s', async (rps) => {
  const s = setup([], 2, 2);
  delete s.runtime.env.NCBI_API_KEY;
  s.runtime.env.P2F_NCBI_RPS = rps;
  let now = Date.parse('2026-01-01T00:00:00Z');
  const start = now;
  const times: number[] = [];
  let initial = 0;
  s.runtime.now = () => new Date(now);
  s.runtime.sleep = jest.fn(async (ms) => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    now += ms;
  });
  s.runtime.fetchImpl = jest.fn(async (input, init) => {
    if (String(input) === url) {
      const body = JSON.parse(String(init?.body)) as { contents: unknown[] };
      if (body.contents.length === 1) {
        initial++;
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(initial).toBe(2);
      }
      return json(body.contents.length < 5 ? call('tool', { command: 'mesh', argument: '合成語' }) : done());
    }
    const request = new URL(String(input));
    if (request.origin !== 'https://eutils.ncbi.nlm.nih.gov' || request.pathname !== '/entrez/eutils/esearch.fcgi'
      || request.searchParams.get('db') !== 'mesh') throw new Error('想定外の通信です');
    times.push(now - start);
    return json({ esearchresult: { count: '0', idlist: [] } });
  });
  expect(await main(s.args, s.runtime)).toBe(0);
  const interval = 1000 / Number(rps ?? 2);
  expect(times).toEqual(Array.from({ length: 8 }, (_, i) => interval * i));
  expect(s.runtime.sleep).toHaveBeenCalledTimes(7);
  for (const dir of [s.dir, join(dirname(s.dir), 'run-2')]) {
    expect(JSON.parse(readFileSync(join(dir, 'budget.json'), 'utf8'))).toEqual({ measurements: 2, submissions: 0 });
  }
});

test.each(['', ' ', '0', '-1', 'NaN', 'Infinity'])('共有レートの不正値を通信前に拒否する: %s', async (rps) => {
  const s = setup();
  s.runtime.env.P2F_NCBI_RPS = rps;
  await expect(main(s.args, s.runtime)).rejects.toThrow('P2F_NCBI_RPS は正の有限数が必要です');
  expect(s.fetchImpl).not.toHaveBeenCalled();
});

test('保存する式、説明、モデル版、外へ投げる例外にもキーを残さない', async () => {
  const s = setup([call('write_formula', { content: '合成Gemini秘密 合成NCBI秘密' }),
    { ...reply({ text: '合成Gemini秘密 合成NCBI秘密' }), modelVersion: '合成Gemini秘密' }]);
  await main(s.args, s.runtime);
  for (const name of readdirSync(s.dir).filter((name) => /^(agent|formula|final)/.test(name))) expect(s.read(name)).not.toMatch(/合成Gemini秘密|合成NCBI秘密/);
  s.runtime.harnessDir = join(s.dir, '合成Gemini秘密');
  await expect(main(s.args, s.runtime)).rejects.toThrow('[REDACTED]');
  await expect(main(s.args, s.runtime)).rejects.not.toThrow('合成Gemini秘密');
});

test('並行プールは指定した実行数を同時に進める', async () => {
  const s = setup([], 3, 2);
  let active = 0, peak = 0;
  s.runtime.fetchImpl = jest.fn(async (input) => {
    if (String(input) !== url) throw new Error('想定外の通信です');
    active++; peak = Math.max(peak, active);
    await new Promise<void>((done) => setImmediate(done));
    active--; return json(done());
  });
  expect(await main(s.args, s.runtime)).toBe(0); expect(peak).toBe(2);
  expect(s.runtime.stdout).toHaveBeenCalledWith('今回実行: 3 件\n');
});

test('120 秒で要求を中断し、再試行後はタイマーを残さない', async () => {
  jest.useFakeTimers();
  try {
    const s = setup();
    let attempts = 0;
    s.runtime.fetchImpl = jest.fn(async (input, init) => {
      if (String(input) !== url || init?.method !== 'POST') throw new Error('想定外の通信です');
      if (attempts++) return json(done());
      return new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(new Error('要求が中断されました')), { once: true });
      });
    });
    const pending = main(s.args, s.runtime);
    await jest.advanceTimersByTimeAsync(119_999);
    expect(s.runtime.fetchImpl).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(await pending).toBe(0); expect(s.runtime.fetchImpl).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);
  } finally { jest.useRealTimers(); }
});

test('語と外側の単位と式の絶対パスを渡し、標準出力と標準エラーをまとめる', async () => {
  const s = setup([call('tool', { command: 'mesh', argument: '合成語' }), call('write_formula', { content: formula }),
    call('tool', { command: 'outside', argument: '2' }), call('tool', { command: 'titles' }), done()]);
  writeJson(s.conditionFile, { ...s.conditions, tools: ['submit', 'mesh', 'outside', 'titles'] });
  const spy = jest.spyOn(tool, 'main').mockImplementation(async (_args, runtime) => {
    runtime!.stdout('合成出力\n'); runtime!.stderr('合成エラー\n'); return 3;
  });
  expect(await main(s.args, s.runtime)).toBe(0);
  expect(spy.mock.calls.map(([args]) => args)).toEqual([
    ['--run', s.dir, 'mesh', '合成語'], ['--run', s.dir, 'outside', join(s.dir, 'formula.md'), '2'],
    ['--run', s.dir, 'titles', join(s.dir, 'formula.md')],
  ]);
  expect(JSON.stringify(s.bodies[1])).toContain('合成出力\\n合成エラー\\n\\n[終了コード 3]');
});

test('道具の通信は Gemini 用の再試行を通さず例外のキーだけを伏せる', async () => {
  const s = setup([call('tool', { command: 'mesh', argument: '合成語' }), done()]);
  const geminiFetch = s.runtime.fetchImpl;
  let requests = 0;
  s.runtime.fetchImpl = async (input, init) => {
    if (String(input) === url) return geminiFetch(input, init);
    if (String(input) !== 'https://example.invalid/synthetic') throw new Error('想定外の通信です');
    requests++; throw new Error('合成Gemini秘密 合成NCBI秘密');
  };
  jest.spyOn(tool, 'main').mockImplementation(async (_args, runtime) => {
    await runtime!.fetchImpl('https://example.invalid/synthetic'); return 0;
  });
  expect(await main(s.args, s.runtime)).toBe(0); expect(requests).toBe(1);
  expect(s.runtime.sleep).not.toHaveBeenCalled();
  expect(JSON.stringify(s.bodies[1])).toContain('[REDACTED]');
  expect(JSON.stringify(s.bodies[1])).not.toMatch(/合成Gemini秘密|合成NCBI秘密/);
});

test('全ての往復に推論の強さを送り、署名付きの応答をそのまま返して推論トークンを集計する', async () => {
  const first = { ...call('write_formula', { content: formula }), usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, thoughtsTokenCount: 7 } };
  const second = call('tool', { command: 'check' });
  const last = { ...done(), usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5, thoughtsTokenCount: 11 } };
  const s = setup([first, second, last]);
  writeJson(s.conditionFile, { ...s.conditions, thinkingLevel: 'high' });
  expect(await main(s.args, s.runtime)).toBe(0);
  expect(s.bodies).toHaveLength(3);
  for (const body of s.bodies) expect(body.generationConfig).toEqual({ thinkingConfig: { thinkingLevel: 'high' } });
  expect((s.bodies[1]!.contents as unknown[])[1]).toEqual(first.candidates[0]!.content);
  expect((s.bodies[2]!.contents as unknown[])[1]).toEqual(first.candidates[0]!.content);
  expect((s.bodies[2]!.contents as unknown[])[3]).toEqual(second.candidates[0]!.content);
  expect(s.agent()).toMatchObject({ thinkingLevel: 'high', thoughtsTokens: 18, promptTokens: 40, outputTokens: 10 });
  expect(s.runtime.stdout).toHaveBeenCalledWith('推論トークン: 18\n');
});

test('推論の強さと推論トークンがない版も記録する', async () => {
  const s = setup();
  expect(await main(s.args, s.runtime)).toBe(0);
  expect(s.agent()).toMatchObject({ thinkingLevel: null, thoughtsTokens: 0 });
});

test('推論の指定がなくても複数の実行の推論トークンを合計する', async () => {
  const s = setup([
    { ...done(), usageMetadata: { thoughtsTokenCount: 7 } },
    { ...done(), usageMetadata: { thoughtsTokenCount: 11 } },
  ], 2);
  expect(await main(s.args, s.runtime)).toBe(0);
  expect(s.agent()).toMatchObject({ thinkingLevel: null, thoughtsTokens: 7 });
  expect(s.runtime.stdout).toHaveBeenCalledWith('推論トークン: 18\n');
});

test.each([-1, 1.5, '7', null])('不正な推論トークンはゼロとして記録する: %j', async (thoughtsTokenCount) => {
  const s = setup([{ ...done(), usageMetadata: { thoughtsTokenCount } }]);
  expect(await main(s.args, s.runtime)).toBe(0);
  expect(s.agent().thoughtsTokens).toBe(0);
});

test('推論の文章を除き通常の文章だけを最終説明に保存する', async () => {
  const s = setup([reply({ text: '内部の推論', thought: true }, { text: '通常の説明', thought: false }, { text: 'の続き' })]);
  expect(await main(s.args, s.runtime)).toBe(0);
  expect(s.read('final.txt')).toBe('通常の説明の続き');
});

test('推論の文章だけなら空応答として一度促し、通常の文章で完了する', async () => {
  const s = setup([reply({ text: '内部の推論', thought: true }), done()]);
  expect(await main(s.args, s.runtime)).toBe(0);
  expect(s.fetchImpl).toHaveBeenCalledTimes(2);
  expect(s.bodies[1]!.contents).toEqual([
    (s.bodies[0]!.contents as unknown[])[0],
    { role: 'user', parts: [{ text: '応答が空でした。続けてください。' }] },
  ]);
  expect(s.agent()).toMatchObject({ status: 'completed', turns: 2 });
  expect(s.read('final.txt')).toBe('提出した式の説明');
  expect(s.read('agent-log.jsonl').trim().split('\n').map((line) => JSON.parse(line).type)).toEqual(['empty', 'text']);
});

test('推論の文章だけの応答が二回続いたら空応答として終了する', async () => {
  const s = setup([reply({ text: '内部の推論', thought: true }), reply({ text: '続きの推論', thought: true })]);
  expect(await main(s.args, s.runtime)).toBe(0);
  expect(s.fetchImpl).toHaveBeenCalledTimes(2);
  expect(s.agent()).toMatchObject({ status: 'completed', note: '応答が 2 回続けて空でした' });
  expect(existsSync(join(s.dir, 'final.txt'))).toBe(false);
  expect(s.read('agent-log.jsonl').trim().split('\n').map((line) => JSON.parse(line).type)).toEqual(['empty', 'empty']);
});
