/** @jest-environment node */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from 'dotenv';
import { main } from './appRun';
import { loadConditions, validateConditions } from './conditions';
import { readSubmissionState } from './scoreRuns';
import { readBudget, runPath } from './runDir';
import { procedureBody, findLeaks } from './leakCheck';
import { splitReviews } from './split';
import type { RunRuntime } from './startRuns';
import { fixture, record, review, writeJson, writeLines } from './testFixtures';
import { EXTRACT_PROTOCOL_AGENT_SYSTEM_PROMPT } from '../../../src/features/formula/skills/extractProtocol';
import { AGENT_DRAFT_PROCEDURE, AGENT_DRAFT_SETTINGS } from '../../../src/features/formula/agentDraft/procedure';
import { renderPromptTemplate } from '../../../src/features/formula/skills/renderPromptTemplate';
import { COCHRANE_HSSS_2024_PUBMED } from '../../../src/features/formula/skills/filterDesigner';
import * as ncbi from './ncbi';

jest.mock('dotenv', () => ({ config: jest.fn() }));
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const reply = (content: unknown[]) => ({ content, model: 'claude-fixed-response', usage: { input_tokens: 10, output_tokens: 2 } });
const text = (value: string) => reply([{ type: 'text', text: value }]);
const call = (name: string, input: unknown) => reply([{ type: 'tool_use', id: 'call1', name, input }]);
const extraction = () => text(JSON.stringify({ framework_type: 'pico', research_question: '合成疑問', study_design: 'RCT',
  inclusion_criteria: '合成組入', exclusion_criteria: '合成除外', blocks: [{ block_label: 'A', description: '概念 A' },
    { block_label: 'B', description: '概念 B' }], combination_expression: '#1 AND #2', suggested_filter_ids: ['RCTfilter'] }));
const formula = '## PubMed\n```\n#1 synthetic[tiab]\n#2 example[tiab]\n```\n';
const done = () => text('終了');
function setup(responses: (unknown | Response | Error)[] = [extraction(), done()], runs = 1, concurrency = 1) {
  const root = mkdtempSync(join(tmpdir(), 'p2f-app-'));
  const casesDir = join(root, 'cases'), harnessDir = join(root, 'harness');
  const rows = Array.from({ length: 10 }, (_, i) => review(i + 1));
  fixture(root, rows);
  const selected = rows.find((row) => splitReviews(rows).get(row.pmcid) === 'development')!;
  writeLines(join(casesDir, 'evaluable.jsonl'), rows.map((row) => record(row)));
  writeJson(join(casesDir, 'subsets.json'), { fixed: [selected.pmcid] });
  mkdirSync(join(casesDir, selected.pmcid));
  writeFileSync(join(casesDir, selected.pmcid, 'protocol.md'), '合成プロトコル');
  const conditionFile = join(harnessDir, 'v1app', 'conditions.json');
  writeJson(conditionFile, loadConditions('v1app'));
  const bodies: Record<string, unknown>[] = [], searches: Record<string, string>[] = [];
  const fetchImpl = jest.fn<Promise<Response>, Parameters<typeof fetch>>(async (input, init) => {
    if (String(input).includes('eutils')) {
      const url = new URL(String(input));
      searches.push(Object.fromEntries(init?.method === 'POST' ? new URLSearchParams(String(init.body)) : url.searchParams));
      return json({ esearchresult: { count: searches[searches.length - 1]!.db === 'mesh' ? '0' : '12', idlist: [] } });
    }
    expect(String(input)).toBe('https://api.anthropic.com/v1/messages');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    if (!responses.length) throw new Error('合成応答が不足しています');
    const value = responses.shift();
    if (value instanceof Error) throw value;
    return value instanceof Response ? value : json(value);
  });
  let elapsed = 0;
  const runtime: RunRuntime = { casesDir, harnessDir,
    env: { COCHRANE_BENCH_DIR: root, ANTHROPIC_API_KEY: 'FAKE_ANTHROPIC_SECRET', NCBI_API_KEY: 'FAKE_NCBI_SECRET' },
    now: () => new Date(Date.parse('2026-01-01T00:00:00Z') + elapsed), stdout: jest.fn(), stderr: jest.fn(),
    sleep: jest.fn(async (ms) => { elapsed += ms; }), fetchImpl };
  const args = ['--runs', join(root, 'runs'), '--version', 'v1app', '--subset', 'fixed', '--runs-per-review', String(runs), '--concurrency', String(concurrency)];
  const dir = runPath(join(root, 'runs'), 'v1app', selected.pmcid, 1);
  const read = (name: string) => readFileSync(join(dir, name), 'utf8');
  const agent = () => JSON.parse(read('agent.json')) as Record<string, unknown>;
  return { args, runtime, dir, read, agent, responses, fetchImpl, bodies, searches, selected, conditionFile };
}
afterEach(() => jest.restoreAllMocks());

test('アプリで抽出・生成し、承認したフィルタと結合式を展開して採点用に保存する', async () => {
  const s = setup([extraction(), call('write_formula', { content: formula }), call('tool', { command: 'check' }),
    call('tool', { command: 'count' }), call('tool', { command: 'submit' }), done()]);
  expect(await main(s.args, s.runtime)).toBe(0);
  expect(s.agent()).toMatchObject({ status: 'completed', model: 'claude-opus-5-5', effort: 'medium',
    respondedModels: ['claude-fixed-response'], extractionCalls: 1, generationCalls: 5, promptTokens: 60, outputTokens: 12 });
  expect(JSON.parse(s.read('extraction.json'))).toMatchObject({ frameworkType: 'pico', suggestedFilterIds: ['RCTfilter'], combinationExpression: '#1 AND #2' });
  const state = readSubmissionState(s.dir);
  expect(state.submitAttempts).toBe(1);
  expect(state.submission).toEqual({ number: 1, submittedAt: s.runtime.now().toISOString(),
    query: `(synthetic[tiab]) AND (example[tiab]) AND (${COCHRANE_HSSS_2024_PUBMED})` });
  expect(s.read('submissions/1.md')).toContain('#RCTfilter');
  expect(s.read('submissions/1.md')).toContain('#1 AND #2 AND #RCTfilter');
  expect(readBudget(s.dir)).toEqual({ measurements: 1, submissions: 1 });
  const logs = s.read('tool-log.jsonl').trim().split('\n').map((line) => JSON.parse(line));
  expect(logs.map((log) => log.command)).toEqual(['check', 'count', 'submit']);
  expect(logs[2]).toMatchObject({ result: '成功', args: '式ファイル 1 件', remaining: { measurements: 19, submissions: 3 } });
  expect(s.searches.length).toBeGreaterThan(1);
  for (const params of s.searches) expect(params).toMatchObject({ db: 'pubmed', retmax: '0', datetype: 'edat',
    mindate: '1800/01/01', maxdate: s.selected.cutoffDate.replace(/-/g, '/') });
  for (const body of s.bodies) { expect(body.output_config).toMatchObject({ effort: 'medium' }); expect(body).not.toHaveProperty('temperature'); }
  expect(config).not.toHaveBeenCalled();
  await main(s.args, s.runtime);
  expect(s.runtime.stdout).toHaveBeenCalledWith('済みで省略: 1 件\n');
});

test.each(['no_submission', 'extraction_failed', 'error'])('失敗状態 %s のファイルと再起動を区別する', async (status) => {
  const s = setup(status === 'no_submission' ? [extraction(), done()] : status === 'extraction_failed'
    ? [text('不正'), text('{}'), text('{')]: [new Error('FAKE_ANTHROPIC_SECRET FAKE_NCBI_SECRET https://secret.invalid/request')]);
  expect(await main(s.args, s.runtime)).toBe(status === 'error' ? 1 : 0);
  expect(s.agent().status).toBe(status);
  expect(existsSync(join(s.dir, 'submission.json'))).toBe(false);
  expect(existsSync(join(s.dir, 'submissions'))).toBe(false);
  expect(existsSync(join(s.dir, 'extraction.json'))).toBe(status === 'no_submission');
  expect(s.read('agent.json')).not.toMatch(/FAKE_ANTHROPIC_SECRET|FAKE_NCBI_SECRET|https:\/\//);
  const calls = s.fetchImpl.mock.calls.length;
  s.responses.push(extraction(), done());
  await main(s.args, s.runtime);
  expect(s.fetchImpl).toHaveBeenCalledTimes(calls + (status === 'error' ? 2 : 0));
  expect(existsSync(`${s.dir}.failed-20260101T000000Z`)).toBe(status === 'error');
  expect(JSON.stringify((s.runtime.stdout as jest.Mock).mock.calls)).not.toMatch(/FAKE_ANTHROPIC_SECRET|FAKE_NCBI_SECRET/);
});

test.each([undefined, '{', '{"status":"error"}'])('未記録・読めない・エラーの実行を退避する: %s', async (agent) => {
  const s = setup(); mkdirSync(s.dir, { recursive: true });
  if (agent !== undefined) writeFileSync(join(s.dir, 'agent.json'), agent);
  writeFileSync(join(s.dir, '途中.txt'), '保存');
  mkdirSync(`${s.dir}.failed-20260101T000000Z`);
  expect(await main(s.args, s.runtime)).toBe(0);
  expect(readFileSync(`${s.dir}.failed-20260101T000001Z/途中.txt`, 'utf8')).toBe('保存');
});

test('PubMed の通信失敗を提出なしにしない', async () => {
  const s = setup([extraction(), call('write_formula', { content: formula }), call('tool', { command: 'count' }), done()]);
  const fetchImpl = s.runtime.fetchImpl;
  s.runtime.fetchImpl = async (input, init) => String(input).includes('eutils') ? json({}, 400) : fetchImpl(input, init);
  expect(await main(s.args, s.runtime)).toBe(1);
  expect(s.agent().status).toBe('error');
  expect(s.read('tool-log.jsonl')).toContain('測定失敗（結果不明）');
  expect(readBudget(s.dir)).toEqual({ measurements: 0, submissions: 0 });
});

test('HTTP 再試行は既定の待機を使い、各試行に別の期限を渡す', async () => {
  const s = setup([json({}, 529), json({}, 503), extraction(), done()]);
  expect(await main(s.args, s.runtime)).toBe(0);
  expect((s.runtime.sleep as jest.Mock).mock.calls).toEqual([[1000], [2000]]);
  const signals = s.fetchImpl.mock.calls.map(([, init]) => init?.signal);
  expect(new Set(signals).size).toBe(4);
  expect(s.agent()).toMatchObject({ extractionCalls: 1, generationCalls: 1 });
});

test('モデルの上限に達しても提出なしとして保存して再実行しない', async () => {
  const s = setup([extraction(), ...Array.from({ length: 60 }, () => call('write_formula', { content: formula }))]);
  expect(await main(s.args, s.runtime)).toBe(0);
  expect(s.agent()).toMatchObject({ status: 'no_submission', generationCalls: 60 });
  await main(s.args, s.runtime); expect(s.fetchImpl).toHaveBeenCalledTimes(61);
});

test('不合格・上限・MeSH の通知を記録し、最後の提出回数で保存する', async () => {
  const s = setup([extraction(), call('write_formula', { content: '不正' }), call('tool', { command: 'submit' }),
    call('write_formula', { content: formula }), call('tool', { command: 'mesh', argument: 'Synthetic' }),
    ...Array.from({ length: 4 }, () => call('tool', { command: 'submit' })), done()]);
  expect(await main(s.args, s.runtime)).toBe(0);
  const logs = s.read('tool-log.jsonl').trim().split('\n').map((line) => JSON.parse(line));
  expect(logs.map((log) => log.result)).toEqual(['検査不合格', '成功', '成功', '成功', '成功', '上限超過']);
  expect(logs[1]).toMatchObject({ command: 'mesh', args: '語 1 件' });
  expect(readBudget(s.dir)).toEqual({ measurements: 1, submissions: 4 });
  expect(readSubmissionState(s.dir).submission?.number).toBe(4);
  expect(existsSync(join(s.dir, 'submissions/4.md'))).toBe(true);
});

test('抽出が応答不正から回復でき、次の通信失敗は抽出失敗にしない', async () => {
  const s = setup([text('{}'), extraction(), done()]);
  expect(await main(s.args, s.runtime)).toBe(0);
  expect(s.agent()).toMatchObject({ status: 'no_submission', extractionCalls: 2 });
  const failed = setup([text('{}'), json({}, 401)]);
  expect(await main(failed.args, failed.runtime)).toBe(1);
  expect(failed.agent().status).toBe('error');
});

test('要求は 300 秒の signal を試行ごとに作り、時間切れをエラーにする', async () => {
  const s = setup();
  const controller = new AbortController();
  const timeout = jest.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
  s.runtime.fetchImpl = async (_input, init) => new Promise<Response>((_resolve, reject) => {
    init!.signal!.addEventListener('abort', () => reject(new Error('時間切れ')), { once: true });
    controller.abort();
  });
  expect(await main(s.args, s.runtime)).toBe(1);
  expect(timeout).toHaveBeenCalledWith(300_000);
  expect(s.agent().status).toBe('error');
});

test('外へ投げる例外でもキー・URL・ヘッダを残さない', async () => {
  const s = setup(); s.runtime.harnessDir = join(s.dir, 'FAKE_ANTHROPIC_SECRET', 'FAKE_NCBI_SECRET');
  await expect(main(s.args, s.runtime)).rejects.not.toThrow(/FAKE_ANTHROPIC_SECRET|FAKE_NCBI_SECRET/);
  const failed = setup([new Error('authorization: Bearer 非公開値\nhttps://secret.invalid/request FAKE_NCBI_SECRET')]);
  expect(await main(failed.args, failed.runtime)).toBe(1);
  expect(failed.read('agent.json')).not.toMatch(/非公開値|https:\/\/|FAKE_NCBI_SECRET/);
  expect(failed.agent().status).toBe('error');
});

test('並行する実行はレート制限を共有し、指定した並行数に収まる', async () => {
  const s = setup([], 3, 2), spy = jest.spyOn(ncbi, 'createDeps');
  let active = 0, peak = 0;
  s.runtime.fetchImpl = async (_input, init) => {
    active++; peak = Math.max(peak, active);
    await new Promise<void>((resolve) => setImmediate(resolve)); active--;
    return json(JSON.parse(String(init?.body)).tools ? done() : extraction());
  };
  expect(await main(s.args, s.runtime)).toBe(0); expect(peak).toBe(2);
  expect(spy).toHaveBeenCalledTimes(3);
  expect(new Set(spy.mock.calls.map(([options]) => options.rateLimiter)).size).toBe(1);
});

test('不正な引数・別の実行役・キーの欠落を通信前に拒否する', async () => {
  const s = setup();
  await expect(main([...s.args, '--concurrency', '2'], s.runtime)).rejects.toThrow('並行数は 1〜8');
  await expect(main([...s.args, '--unknown'], s.runtime)).rejects.toThrow('実行引数が不正です');
  delete s.runtime.env.ANTHROPIC_API_KEY;
  await expect(main(s.args, s.runtime)).rejects.toThrow('ANTHROPIC_API_KEY');
  writeJson(s.conditionFile, { ...loadConditions('v1app'), runner: 'gemini-api' });
  await expect(main(s.args, s.runtime)).rejects.toThrow('実行役が app-anthropic');
  expect(s.fetchImpl).not.toHaveBeenCalled();
});

test('対象が空でも集計を出す', async () => {
  const s = setup(); writeJson(join(s.runtime.casesDir!, 'subsets.json'), { fixed: [] });
  expect(await main(s.args, s.runtime)).toBe(0);
  expect(s.runtime.stdout).toHaveBeenCalledWith('対象: 0 件\n'); expect(s.fetchImpl).not.toHaveBeenCalled();
});

test.each([{ provider: 'anthropic' }, { thinkingLevel: 'medium' }, { seeds: { label: 'seed', max: 1 } },
  { table: false }, { table: true }, { hitsLimit: 10 }, { combine: { from: 'v1o', k: 3 } },
  { tools: ['submit', 'outside'] }, { tools: ['submit', 'titles'] }, { tools: ['submit', 'seeds'] }])('アプリに併用できない条件を拒否する: %j', (change) => {
  expect(() => validateConditions({ ...loadConditions('v1app'), ...change }, 'v1app')).toThrow('不正です');
});

test('手順書の本文はアプリの三つの定数と一致し、識別子を含まない', () => {
  const body = procedureBody(readFileSync(join(__dirname, '../harness/v1app/procedure.md'), 'utf8'));
  expect(body).toBe('\n' + ['## ブロック抽出の指示', EXTRACT_PROTOCOL_AGENT_SYSTEM_PROMPT, '## 手順書',
    renderPromptTemplate(AGENT_DRAFT_PROCEDURE, { MAX_MEASUREMENTS: '20', MAX_SUBMISSIONS: '4' }),
    '## 設定', AGENT_DRAFT_SETTINGS].join('\n\n') + '\n');
  expect(findLeaks(body, [], new Set())).toEqual([]);
});
