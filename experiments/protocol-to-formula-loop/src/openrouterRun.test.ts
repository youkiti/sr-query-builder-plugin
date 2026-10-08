/** @jest-environment node */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { main } from './openrouterRun';
import { SETTINGS, parseOptions } from './geminiRun';
import { loadConditions } from './conditions';
import { runPath } from './runDir';
import { splitReviews } from './split';
import type { RunRuntime } from './startRuns';
import * as tool from './tool';
import { fixture, record, review, writeJson, writeLines } from './testFixtures';

const url = 'https://openrouter.ai/api/v1/chat/completions';
const formula = '## PubMed\n```\n#1 synthetic[tiab]\n#2 example[tiab]\n#3 #1 AND #2\n```\n';
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const reply = (message: Record<string, unknown>) => ({ choices: [{ message }], model: '固定モデル', provider: 'alibaba',
  usage: { prompt_tokens: 10, completion_tokens: 2 } });
const functionCall = (name: string, args: unknown, id = '呼出1') => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const call = (name: string, args: Record<string, unknown>) => reply({ role: 'assistant', tool_calls: [functionCall(name, args)] });
const done = () => reply({ role: 'assistant', content: '提出した式の説明' });
const headers = { Authorization: 'Bearer 合成OpenRouter秘密', 'Content-Type': 'application/json',
  'HTTP-Referer': 'https://github.com/youkiti/sr-query-builder-plugin', 'X-Title': 'sr-query-builder-plugin' };
function checkRequest(input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) {
  if (String(input) !== url || init?.method !== 'POST') throw new Error('想定外の通信です');
  expect(init.headers).toEqual(headers);
  expect(init.signal).toBeInstanceOf(AbortSignal);
}
function setup(responses: (unknown | Response | Error)[] = [done()], runs = 1, concurrency = 1) {
  const root = mkdtempSync(join(tmpdir(), 'p2f-openrouter-'));
  const casesDir = join(root, 'cases');
  const harnessDir = join(root, 'harness');
  const rows = Array.from({ length: 10 }, (_, i) => review(i + 1));
  fixture(root, rows);
  const selected = rows.find((row) => splitReviews(rows).get(row.pmcid) === 'development')!;
  writeLines(join(casesDir, 'evaluable.jsonl'), rows.map((row) => record(row)));
  writeJson(join(casesDir, 'subsets.json'), { smoke: [selected.pmcid] });
  mkdirSync(join(casesDir, selected.pmcid));
  writeFileSync(join(casesDir, selected.pmcid, 'protocol.md'), '合成プロトコルの全文');
  const conditions = { ...loadConditions('v0'), model: 'qwen/qwen3.8-flash', runner: 'openrouter-api', provider: 'alibaba' };
  const conditionFile = join(harnessDir, 'v0', 'conditions.json');
  writeJson(conditionFile, conditions);
  writeFileSync(join(harnessDir, 'v0', 'procedure.md'), '渡さない前書き\n---\n合成手順書の本文');
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = jest.fn<Promise<Response>, Parameters<typeof fetch>>(async (input, init) => {
    checkRequest(input, init);
    bodies.push(JSON.parse(String(init!.body)) as Record<string, unknown>);
    if (!responses.length) throw new Error('合成応答が不足しています');
    const value = responses.shift();
    if (value instanceof Error) throw value;
    return value instanceof Response ? value : json(value);
  });
  const runtime: RunRuntime = { casesDir, harnessDir, env: { COCHRANE_BENCH_DIR: root, OPENROUTER_API_KEY: '合成OpenRouter秘密', NCBI_API_KEY: '合成NCBI秘密' },
    now: () => new Date('2026-01-01T00:00:00Z'), stdout: jest.fn(), stderr: jest.fn(), sleep: jest.fn(async () => undefined), fetchImpl };
  const args = ['--runs', join(root, 'runs'), '--version', 'v0', '--subset', 'smoke', '--runs-per-review', String(runs), '--concurrency', String(concurrency)];
  const dir = runPath(join(root, 'runs'), 'v0', selected.pmcid, 1);
  const read = (name: string) => readFileSync(join(dir, name), 'utf8');
  const agent = () => JSON.parse(read('agent.json')) as Record<string, unknown>;
  return { args, runtime, dir, read, agent, fetchImpl, bodies, responses, conditions, conditionFile };
}
afterEach(() => jest.restoreAllMocks());

test.each(['check', 'count', 'submit', 'titles', 'outside'])('式のない %s は道具を呼ばずに書き込みを促す', async (command) => {
  const s = setup([call('tool', { command, argument: '1' }), done()]);
  writeJson(s.conditionFile, { ...s.conditions, tools: ['check', 'count', 'submit', 'titles', 'outside'] });
  const spy = jest.spyOn(tool, 'main');
  expect(await main(s.args, s.runtime)).toBe(0);
  expect(spy).not.toHaveBeenCalled();
  expect(JSON.stringify(s.bodies[1])).toContain('先に write_formula');
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

test.each([new Error('合成OpenRouter秘密 と 合成NCBI秘密'), new Response('不正な JSON'), json({ error: '合成OpenRouter秘密' })])(
  '通信例外と不正な成功応答は再試行する: %#', async (failure) => {
    const s = setup([failure, done()]);
    expect(await main(s.args, s.runtime)).toBe(0); expect(s.fetchImpl).toHaveBeenCalledTimes(2);
    expect(s.read('agent-log.jsonl')).not.toMatch(/合成OpenRouter秘密|合成NCBI秘密/);
  });

test('再試行を使い切ると理由を伏せ字で保存し、別の実行を続けて終了コード 1 を返す', async () => {
  const s = setup([...Array.from({ length: 6 }, () => new Error('合成OpenRouter秘密 と 合成NCBI秘密')), done()], 2);
  expect(await main(s.args, s.runtime)).toBe(1); expect(s.fetchImpl).toHaveBeenCalledTimes(7);
  expect(s.agent()).toMatchObject({ status: 'error', turns: 1 }); expect(s.agent().note).toContain('[REDACTED]');
  expect(s.read('agent.json') + s.read('agent-log.jsonl')).not.toMatch(/合成OpenRouter秘密|合成NCBI秘密/);
  expect((s.runtime.sleep as jest.Mock).mock.calls.map(([ms]) => ms)).toEqual([1000, 2000, 4000, 8000, 16000]);
  expect(JSON.parse(readFileSync(join(dirname(s.dir), 'run-2', 'agent.json'), 'utf8')).status).toBe('completed');
  expect(s.runtime.stdout).toHaveBeenCalledWith('error: 1 件\n');
});

test('400 は再試行せずエラーにする', async () => {
  const s = setup([json({ error: '合成OpenRouter秘密' }, 400)]);
  expect(await main(s.args, s.runtime)).toBe(1); expect(s.fetchImpl).toHaveBeenCalledTimes(1);
  expect(s.runtime.sleep).not.toHaveBeenCalled(); expect(s.agent().note).toContain('400');
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

test.each([{ runner: undefined, provider: undefined, model: 'fixed' }, { runner: 'claude-subagent', provider: undefined, model: 'fixed' }, { runner: 'gemini-api', provider: undefined, model: 'fixed' }, { combine: { from: 'v1', k: 2 } }])('対象外の版を拒否する: %j', async (change) => {
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
  delete s.runtime.env.OPENROUTER_API_KEY;
  await expect(main(s.args, s.runtime)).rejects.toThrow('OPENROUTER_API_KEY');
});

test.each([undefined, '12'])('道具のレート設定を保ち、道具の例外にも両キーを伏せる: %s', async (rps) => {
  const s = setup([call('write_formula', { content: formula }), call('tool', { command: 'check' }), done()], 1, 4);
  s.runtime.env.P2F_NCBI_RPS = rps;
  const spy = jest.spyOn(tool, 'main').mockImplementation(async (_args, runtime) => {
    expect(runtime!.env.P2F_NCBI_RPS).toBe(rps);
    expect(runtime!.rateLimiter).toBeDefined();
    throw new Error('合成OpenRouter秘密 と 合成NCBI秘密');
  });
  expect(await main(s.args, s.runtime)).toBe(0); expect(spy).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(s.bodies[2])).toContain('[終了コード 1]');
  expect(JSON.stringify(s.bodies[2])).not.toMatch(/合成OpenRouter秘密|合成NCBI秘密/);
});

test.each(['', ' ', '0', '-1', 'NaN', 'Infinity'])('共有レートの不正値を通信前に拒否する: %s', async (rps) => {
  const s = setup();
  s.runtime.env.P2F_NCBI_RPS = rps;
  await expect(main(s.args, s.runtime)).rejects.toThrow('P2F_NCBI_RPS は正の有限数が必要です');
  expect(s.fetchImpl).not.toHaveBeenCalled();
});

test('保存する式、説明、モデル版、外へ投げる例外にもキーを残さない', async () => {
  const s = setup([call('write_formula', { content: '合成OpenRouter秘密 合成NCBI秘密' }),
    { ...reply({ role: 'assistant', content: '合成OpenRouter秘密 合成NCBI秘密' }), provider: '合成NCBI秘密', model: '合成OpenRouter秘密' }]);
  await main(s.args, s.runtime);
  for (const name of readdirSync(s.dir).filter((name) => /^(agent|formula|final)/.test(name))) expect(s.read(name)).not.toMatch(/合成OpenRouter秘密|合成NCBI秘密/);
  for (const name of ['agent.json', 'agent-log.jsonl', 'formula.md', 'final.txt']) {
    if (name !== 'agent-log.jsonl') expect(s.read(name)).toContain('[REDACTED]');
    expect(s.read(name)).not.toMatch(/合成OpenRouter秘密|合成NCBI秘密/);
  }
  expect(JSON.stringify((s.runtime.stdout as jest.Mock).mock.calls)).not.toMatch(/合成OpenRouter秘密|合成NCBI秘密/);
  s.runtime.harnessDir = join(s.dir, '合成OpenRouter秘密', '合成NCBI秘密');
  await expect(main(s.args, s.runtime)).rejects.toThrow('[REDACTED]');
  await expect(main(s.args, s.runtime)).rejects.not.toThrow(/合成OpenRouter秘密|合成NCBI秘密/);
});

test('並行プールは指定した実行数を同時に進める', async () => {
  const s = setup([], 3, 2);
  let active = 0, peak = 0;
  s.runtime.fetchImpl = jest.fn(async (input, init) => {
    checkRequest(input, init);
    active++; peak = Math.max(peak, active);
    await new Promise<void>((done) => setImmediate(done));
    active--; return json(done());
  });
  expect(await main(s.args, s.runtime)).toBe(0); expect(peak).toBe(2);
  expect(s.runtime.stdout).toHaveBeenCalledWith('今回実行: 3 件\n');
});

test('300 秒で要求を中断し、再試行後はタイマーを残さない', async () => {
  jest.useFakeTimers();
  try {
    const s = setup();
    let attempts = 0;
    s.runtime.fetchImpl = jest.fn(async (input, init) => {
      checkRequest(input, init);
      if (attempts++) return json(done());
      return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(new Error('要求が中断されました')), { once: true });
      });
    });
    const pending = main(s.args, s.runtime);
    await jest.advanceTimersByTimeAsync(299_999);
    expect(s.runtime.fetchImpl).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(await pending).toBe(0); expect(s.runtime.fetchImpl).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);
  } finally { jest.useRealTimers(); }
});


const badArgumentsText = 'エラー: 引数が読めませんでした。JSON のオブジェクトで指定してください';
const logs = (s: ReturnType<typeof setup>) => s.read('agent-log.jsonl').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
const messages = (s: ReturnType<typeof setup>, turn: number) => s.bodies[turn]!.messages as Record<string, unknown>[];

test('関数を往復して提出し、要求の本文と許可したキーだけを送る', async () => {
  const s = setup([call('write_formula', { content: formula }), call('tool', { command: 'check' }), call('tool', { command: 'submit' }), done()]);
  expect(await main(s.args, s.runtime)).toBe(0);
  expect(s.bodies[0]).toEqual({
    messages: [{ role: 'system', content: '合成手順書の本文\n\n' + SETTINGS },
      { role: 'user', content: '次の研究プロトコルについて、手順書に従って検索式を作り、提出してください。\n\n合成プロトコルの全文' }],
    model: s.conditions.model,
    tools: [
      { type: 'function', function: { name: 'write_formula', description: '検索式の全文を書く',
        parameters: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] } } },
      { type: 'function', function: { name: 'tool', description: '手順書の道具を呼ぶ', parameters: { type: 'object',
        properties: { command: { type: 'string', enum: s.conditions.tools }, argument: { type: 'string' } }, required: ['command'] } } },
    ],
    provider: { only: ['alibaba'], allow_fallbacks: false }, usage: { include: true },
  });
  for (const body of s.bodies) expect(Object.keys(body).sort()).toEqual(['messages', 'model', 'provider', 'tools', 'usage']);
  expect(messages(s, 2).slice(-1)[0]).toEqual({ role: 'tool', tool_call_id: '呼出1', content: '検査に通りました\n\n[終了コード 0]' });
  expect(messages(s, 3).slice(-1)[0]).toEqual({ role: 'tool', tool_call_id: '呼出1', content: '提出 1 を受け付けました\n\n[終了コード 0]' });
  expect(JSON.parse(s.read('submission.json'))).toMatchObject({ number: 1 });
  expect(s.read('formula.md')).toBe(formula);
  expect(s.read('final.txt')).toBe('提出した式の説明');
  expect(s.agent()).toMatchObject({ status: 'completed', turns: 4 });
  expect(s.fetchImpl).toHaveBeenCalledTimes(4);
});

test('推論と未知の項目を含む応答全体を道具の結果の前に保持する', async () => {
  const message = { role: 'assistant', content: null, reasoning: '合成の推論',
    reasoning_details: [{ type: 'reasoning.text', text: '合成の詳細' }], 合成の未知項目: 1,
    tool_calls: [functionCall('write_formula', { content: formula }, '保持するID')] };
  const s = setup([reply(message), done()]);
  expect(await main(s.args, s.runtime)).toBe(0);
  expect(messages(s, 1).slice(2)).toEqual([message,
    { role: 'tool', tool_call_id: '保持するID', content: `formula.md を書きました（${formula.length} 文字）` }]);
});

test.each([undefined, 'high'])('推論設定 %s をすべての要求と実行記録に反映する', async (thinkingLevel) => {
  const s = setup([call('write_formula', { content: formula }), done()]);
  writeJson(s.conditionFile, { ...s.conditions, thinkingLevel });
  expect(await main(s.args, s.runtime)).toBe(0);
  expect(s.bodies).toHaveLength(2);
  for (const body of s.bodies) {
    if (thinkingLevel === undefined) expect(body).not.toHaveProperty('reasoning');
    else expect(body.reasoning).toEqual({ effort: 'high' });
  }
  expect(s.agent().thinkingLevel).toBe(thinkingLevel ?? null);
});

test('複数関数は先頭だけ実行し、各 ID に実行結果と未実行の応答を返す', async () => {
  const s = setup([reply({ role: 'assistant', tool_calls: [
    functionCall('write_formula', { content: formula }, '先頭'),
    functionCall('write_formula', { content: '上書きしない' }, '二番目'),
    functionCall('tool', { command: 'submit' }, '三番目'),
  ] }), done()]);
  const spy = jest.spyOn(tool, 'main');
  expect(await main(s.args, s.runtime)).toBe(0);
  expect(s.read('formula.md')).toBe(formula);
  expect(existsSync(join(s.dir, 'submission.json'))).toBe(false);
  expect(spy).not.toHaveBeenCalled();
  expect(messages(s, 1).slice(3)).toEqual([
    { role: 'tool', tool_call_id: '先頭', content: `formula.md を書きました（${formula.length} 文字）\n複数の関数が指定されたため、最初の 1 つだけ実行しました。` },
    ...['二番目', '三番目'].map((id) => ({ role: 'tool', tool_call_id: id, content: '未実行: 関数は 1 回の応答で 1 つずつ呼んでください。' })),
  ]);
});

test.each(['{', '[]', '"合成文字列"', 'null'])('引数 %s は道具を動かさず記録し、次の正しい呼び出しで続行する', async (argumentsText) => {
  const s = setup([reply({ role: 'assistant', tool_calls: [{ id: '壊れた引数', type: 'function',
    function: { name: 'write_formula', arguments: argumentsText } }] }), call('write_formula', { content: formula }), done()]);
  const spy = jest.spyOn(tool, 'main');
  const fetchImpl = s.runtime.fetchImpl;
  s.runtime.fetchImpl = async (input, init) => {
    if (s.bodies.length === 1) expect(existsSync(join(s.dir, 'formula.md'))).toBe(false);
    return fetchImpl(input, init);
  };
  expect(await main(s.args, s.runtime)).toBe(0);
  expect(spy).not.toHaveBeenCalled();
  expect(messages(s, 1).slice(-1)[0]).toEqual({ role: 'tool', tool_call_id: '壊れた引数', content: badArgumentsText });
  expect(s.agent()).toMatchObject({ status: 'completed', turns: 3, badArguments: 1 });
  expect(logs(s).map((row) => row.type)).toEqual(['bad_arguments', 'write_formula', 'text']);
  expect(s.read('formula.md')).toBe(formula);
});

test('空文字列の引数は空オブジェクトとして扱い、引数不正に数えない', async () => {
  const s = setup([reply({ role: 'assistant', tool_calls: [{ id: '空引数', type: 'function',
    function: { name: 'tool', arguments: '' } }] }), done()]);
  const spy = jest.spyOn(tool, 'main');
  expect(await main(s.args, s.runtime)).toBe(0);
  expect(spy).not.toHaveBeenCalled();
  expect(messages(s, 1).slice(-1)[0]).toEqual({ role: 'tool', tool_call_id: '空引数', content: 'エラー: この版では使えないコマンドです' });
  expect(s.agent().badArguments).toBe(0);
  expect(logs(s)[0]!.type).toBe('tool');
});

test.each([
  ['関数なし', [{ id: '不正' }]],
  ['関数が文字列', [{ id: '不正', function: '不正' }]],
  ['関数が配列', [{ id: '不正', function: [] }]],
  ['関数が null', [{ id: '不正', function: null }]],
  ['名前が数値', [{ id: '不正', function: { name: 1, arguments: '{}' } }]],
  ['引数がオブジェクト', [{ id: '不正', function: { name: 'write_formula', arguments: { content: formula } } }]],
  ['ID なし', [{ function: { name: 'write_formula', arguments: JSON.stringify({ content: formula }) } }]],
  ['ID が数値', [{ id: 1, function: { name: 'write_formula', arguments: JSON.stringify({ content: formula }) } }]],
  ['ID が空文字列', [functionCall('write_formula', { content: formula }, '')]],
  ['要素が null', [null]],
  ['要素が数値', [0]],
  ['二番目の ID なし', [functionCall('write_formula', { content: formula }),
    { function: { name: 'write_formula', arguments: JSON.stringify({ content: formula }) } }]],
  ['二番目が null', [functionCall('write_formula', { content: formula }), null]],
])('壊れた関数要素（%s）は会話に戻さず引数不正として記録し続行する', async (_label, broken) => {
  const s = setup([reply({ role: 'assistant', tool_calls: broken }), call('write_formula', { content: formula }), done()]);
  const spy = jest.spyOn(tool, 'main');
  const fetchImpl = s.runtime.fetchImpl;
  s.runtime.fetchImpl = async (input, init) => {
    if (s.bodies.length === 1) {
      expect(existsSync(join(s.dir, 'formula.md'))).toBe(false);
      expect(spy).not.toHaveBeenCalled();
    }
    return fetchImpl(input, init);
  };
  expect(await main(s.args, s.runtime)).toBe(0);
  expect(spy).not.toHaveBeenCalled();
  expect(messages(s, 1).filter((message) => message.role === 'assistant')).toHaveLength(0);
  expect(messages(s, 1).filter((message) => message.role === 'tool')).toHaveLength(0);
  expect(messages(s, 1).slice(-1)[0]).toEqual({ role: 'user',
    content: '関数の呼び出しの形式が読めませんでした。関数を 1 つ、もう一度呼んでください。' });
  expect(s.agent()).toMatchObject({ status: 'completed', turns: 3, badArguments: 1 });
  expect(logs(s).map((row) => row.type)).toEqual(['bad_arguments', 'write_formula', 'text']);
  expect(logs(s)[0]!.resultLength).toBe(0);
  expect(logs(s)[0]!.arguments).toBeUndefined();
  expect(s.read('formula.md')).toBe(formula);
  expect(messages(s, 2).filter((message) => message.role === 'tool')).toHaveLength(1);
  for (let turn = 1; turn < s.bodies.length; turn++) {
    let ids: unknown[] = [];
    for (const message of messages(s, turn)) {
      if (message.role === 'assistant') ids = (message.tool_calls as { id: unknown }[]).map((item) => item.id);
      if (message.role === 'tool') {
        expect(typeof message.tool_call_id).toBe('string');
        expect(message.tool_call_id).not.toBe('');
        expect(ids).toContain(message.tool_call_id);
      }
    }
  }
});

test('形が壊れた関数呼び出しが 60 回続いてもエラーにせず打ち切る', async () => {
  const s = setup(Array.from({ length: 60 }, () => reply({ role: 'assistant', tool_calls: [null] })));
  const spy = jest.spyOn(tool, 'main');
  expect(await main(s.args, s.runtime)).toBe(0);
  expect(s.agent()).toMatchObject({ status: 'max_turns', turns: 60, badArguments: 60 });
  expect(s.fetchImpl).toHaveBeenCalledTimes(60);
  expect(s.runtime.sleep).not.toHaveBeenCalled();
  expect(spy).not.toHaveBeenCalled();
  expect(existsSync(join(s.dir, 'formula.md'))).toBe(false);
  expect(logs(s)).toHaveLength(60);
  for (const row of logs(s)) {
    expect(row).toMatchObject({ type: 'bad_arguments', resultLength: 0 });
    expect(row.arguments).toBeUndefined();
  }
});

test('形が壊れた関数呼び出しを挟むと空応答の連続判定を数え直す', async () => {
  const s = setup([reply({ role: 'assistant', content: '' }), reply({ role: 'assistant', tool_calls: [null] }),
    reply({ role: 'assistant', content: '' }), done()]);
  expect(await main(s.args, s.runtime)).toBe(0);
  expect(s.agent()).toMatchObject({ status: 'completed', turns: 4, badArguments: 1, emptyReplies: 2 });
  expect(s.agent().note).toBeUndefined();
  expect(s.fetchImpl).toHaveBeenCalledTimes(4);
  expect(messages(s, 3).slice(-1)[0]).toEqual({ role: 'user', content: '応答が空でした。続けてください。' });
  expect(messages(s, 3).filter((message) => message.content === '応答が空でした。続けてください。')).toHaveLength(2);
  expect(logs(s).map((row) => row.type)).toEqual(['empty', 'bad_arguments', 'empty', 'text']);
  expect(s.read('final.txt')).toBe('提出した式の説明');
});

test.each([{ content: null }, { content: '' }, {}])('空応答 %j は会話に戻さず一度だけ続行を促す', async (content) => {
  const s = setup([reply({ role: 'assistant', ...content }), done()]);
  expect(await main(s.args, s.runtime)).toBe(0);
  expect(messages(s, 1)).toEqual([...messages(s, 0), { role: 'user', content: '応答が空でした。続けてください。' }]);
  expect(s.agent()).toMatchObject({ status: 'completed', turns: 2, emptyReplies: 1 });
  expect(logs(s).map((row) => row.type)).toEqual(['empty', 'text']);
});

test('空応答が二回続けば注記して終了し、関数呼び出しを挟むと数え直す', async () => {
  const s = setup([reply({ role: 'assistant', content: null }), call('write_formula', { content: formula }),
    reply({ role: 'assistant', content: '' }), reply({ role: 'assistant' })]);
  expect(await main(s.args, s.runtime)).toBe(0);
  expect(s.agent()).toMatchObject({ status: 'completed', turns: 4, emptyReplies: 3, note: '応答が 2 回続けて空でした' });
  expect(messages(s, 3).filter((message) => message.content === '応答が空でした。続けてください。')).toHaveLength(2);
  expect(logs(s).map((row) => row.type)).toEqual(['empty', 'write_formula', 'empty', 'empty']);
  expect(existsSync(join(s.dir, 'final.txt'))).toBe(false);
});

test.each([
  ['選択肢のエラー', { choices: [{ error: { message: '合成失敗' }, message: { role: 'assistant', content: '採用しない' } }] }],
  ['空の選択肢', { choices: [] }],
  ['メッセージなし', { choices: [{}] }],
])('HTTP 200 でも%sは失敗として再試行する', async (_label, failure) => {
  const s = setup([failure, done()]);
  expect(await main(s.args, s.runtime)).toBe(0);
  expect(s.fetchImpl).toHaveBeenCalledTimes(2);
  expect(s.runtime.sleep).toHaveBeenCalledWith(1000);
  expect(s.bodies[1]).toEqual(s.bodies[0]);
  expect(logs(s).map((row) => row.type)).toEqual(['error', 'text']);
  expect(s.agent()).toMatchObject({ status: 'completed', turns: 1 });
});

test('使用量と費用を合計し、応答元を到着順で重複なく記録して集計を表示する', async () => {
  const s = setup([
    { ...reply({ role: 'assistant', tool_calls: [{ id: '不正', function: { name: 'tool', arguments: '[' } }] }),
      provider: 'alibaba', model: '最初のモデル', usage: { prompt_tokens: 10, completion_tokens: 4, completion_tokens_details: { reasoning_tokens: 2 }, cost: 0.1 } },
    { ...reply({ role: 'assistant', content: null }), provider: '別の提供元', usage: { prompt_tokens: 20, completion_tokens: 6, completion_tokens_details: { reasoning_tokens: 3 } } },
    { ...done(), provider: 'alibaba', model: '最後のモデル', usage: { prompt_tokens: 30, completion_tokens: 8, completion_tokens_details: { reasoning_tokens: 4 }, cost: 0.2 } },
  ]);
  expect(await main(s.args, s.runtime)).toBe(0);
  expect(s.agent()).toMatchObject({ promptTokens: 60, outputTokens: 18, thoughtsTokens: 9,
    provider: 'alibaba', respondedProviders: ['alibaba', '別の提供元'], modelVersion: '最後のモデル', badArguments: 1, emptyReplies: 1 });
  expect(s.agent().cost).toBeCloseTo(0.3);
  for (const line of ['入力トークン: 60', '出力トークン: 18', '推論トークン: 9', '費用（USD）: 0.3000', '引数が読めなかった応答: 1', '空の応答: 1']) {
    expect(s.runtime.stdout).toHaveBeenCalledWith(line + '\n');
  }
  expect(logs(s).map((row) => row.usage)).toEqual([
    { promptTokens: 10, completionTokens: 4, reasoningTokens: 2, cost: 0.1 },
    { promptTokens: 20, completionTokens: 6, reasoningTokens: 3, cost: null },
    { promptTokens: 30, completionTokens: 8, reasoningTokens: 4, cost: 0.2 },
  ]);
});

test.each([-1, 1.5, '12'])('不正なトークン数 %s はすべてゼロとして数える', async (value) => {
  const s = setup([{ ...done(), usage: { prompt_tokens: value, completion_tokens: value, completion_tokens_details: { reasoning_tokens: value } } }]);
  expect(await main(s.args, s.runtime)).toBe(0);
  expect(s.agent()).toMatchObject({ promptTokens: 0, outputTokens: 0, thoughtsTokens: 0, cost: null });
  expect(logs(s)[0]!.usage).toEqual({ promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cost: null });
});

test.each([
  ['一度も数値なし', [undefined, '0.2', null], null],
  ['一部だけ数値', [undefined, 0.2, undefined], 0.2],
  ['ゼロの費用', [undefined, 0, undefined], 0],
])('費用が%sの場合は受信した数値だけを集計する', async (_label, costs, expected) => {
  const s = setup([call('write_formula', { content: formula }), call('write_formula', { content: formula }), done()]
    .map((response, i) => ({ ...response, usage: { cost: (costs as unknown[])[i] } })));
  expect(await main(s.args, s.runtime)).toBe(0);
  expect(s.agent().cost).toBe(expected);
});

test('ログは式と引数の本文を残さず長さと使用量だけを記録する', async () => {
  const argument = '合成の秘密の引数';
  const s = setup([call('write_formula', { content: formula }), call('tool', { command: 'mesh', argument }), done()]);
  jest.spyOn(tool, 'main').mockImplementation(async (_args, runtime) => { runtime!.stdout(argument); return 0; });
  expect(await main(s.args, s.runtime)).toBe(0);
  const rows = logs(s);
  expect(rows[0]!.arguments).toEqual({ contentLength: formula.length });
  expect(rows[1]!.arguments).toEqual({ command: 'mesh', argumentLength: argument.length });
  for (const row of rows) expect(row.usage).toEqual({ promptTokens: 10, completionTokens: 2, reasoningTokens: 0, cost: null });
  expect(rows[1]!.resultLength).toBe((argument + '\n[終了コード 0]').length);
  expect(s.read('agent-log.jsonl')).not.toContain('synthetic');
  expect(s.read('agent-log.jsonl')).not.toContain(argument);
});
