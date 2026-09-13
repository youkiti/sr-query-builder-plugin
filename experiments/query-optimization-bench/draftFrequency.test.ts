/** @jest-environment node */
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from 'dotenv';
import { main, parseFrequencyArgs, validatePlan, reportFrequency, type Plan, type Trial, type FrequencyDeps } from './draftFrequency';
import { FIXTURES } from './prepare';
import { loadC0Artifact } from './c0Artifact';
import { sharedEutilsRateLimiters } from '../../src/lib/ncbi/eutils';
import type { DraftGeneration } from '../../src/app/services/draftService';

jest.mock('dotenv', () => ({ config: jest.fn() }));
const id = 'r1-mindfulness-smoking';
const baseArgs = ['--case', id, '--variant', 'criteria-only', '--trials', '3'];
const draft = { formula: { blocks: [{ id: '1', expression: 'hello[tiab]', isCombination: false }], combinationExpression: '#1' },
  markdown: '生の検索式', blockHits: [{ hitCount: 0, error: '生成時の構文エラー' }] } as DraftGeneration;
let output: jest.SpyInstance;
beforeEach(() => {
  output = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  jest.spyOn(sharedEutilsRateLimiters.withoutApiKey, 'acquire').mockResolvedValue(undefined);
  jest.spyOn(sharedEutilsRateLimiters.withApiKey, 'acquire').mockResolvedValue(undefined);
});
afterEach(() => jest.restoreAllMocks());

function setup() {
  const results = mkdtempSync(join(tmpdir(), 'draft-frequency-'));
  const root = join(results, 'draft-frequency', 'default');
  const path = (k: number) => join(root, id, 'criteria-only', `trial-${k}.json`);
  const deps: FrequencyDeps = { provider: () => ({ model: 'fake', providerId: 'gemini', chat: jest.fn() }),
    fetch: jest.fn(async () => new Response(JSON.stringify({ esearchresult: { count: '1' } }))),
    generate: jest.fn(async () => draft), eutils: { maxRetries: 0, sleep: async () => undefined } };
  return { results, root, path, deps };
}

test.each([[], ['--trials', '0'], ['--trials', '1.5'], ['--trials', '01'], ['--trials', '9007199254740992'],
  ['--trials'], ['--unknown'], ['--report', '--dry-run'], ['--report', '--trials', '1'],
  ['--report', '--case', 'unknown'], ['--report', '--variant', 'unknown'], ['--report', '--label', '../x'],
  ['--report', '--label', '..'], ['--report', '--label', 'replay-x'], ['--report', '--report']])('引数を拒否: %j', (...args) => {
  expect(() => parseFrequencyArgs(args)).toThrow();
});

test('計画は試行数・条件・sha を固定し、部分集合だけ許可する', () => {
  const condition = { caseId: id, variant: 'criteria-only' as const, c0Name: 'criteria-only-draft1', c0Sha256: 'sha' };
  const plan: Plan = { trials: 3, conditions: [condition], createdAt: '', gitCommit: null };
  expect(() => validatePlan(plan, 3, [condition])).not.toThrow();
  expect(() => validatePlan(plan, 4, [condition])).toThrow('試行数');
  expect(() => validatePlan(plan, 3, [{ ...condition, variant: 'seeded' }])).toThrow('条件外');
  expect(() => validatePlan(plan, 3, [{ ...condition, c0Sha256: 'different' }])).toThrow('sha256');
});

test('固定入力、日付、診断だけの結論、完了スキップ、未完了の履歴と再開', async () => {
  const { results, root, path, deps } = setup();
  let generation = 0;
  deps.generate = jest.fn(async () => { if (++generation === 2) throw new Error('生成失敗'); return draft; });
  await main(baseArgs, FIXTURES, results, deps);
  expect(JSON.parse(readFileSync(path(1), 'utf8')).outcome).toBe('ok');
  expect(JSON.parse(readFileSync(path(2), 'utf8')).outcome).toBe('generation_failed');
  const artifact = loadC0Artifact(FIXTURES, id, 'criteria-only-draft1');
  expect(deps.generate).toHaveBeenCalledWith(expect.objectContaining({ protocol: artifact.protocol, blocks: artifact.blocks, targetHits: 2000,
    seedContext: { titles: [], samples: [], meshSummary: { seedCount: 0, concepts: [], checkTags: [] } } }), expect.anything());
  const url = new URL(jest.mocked(deps.fetch!).mock.calls[0]![0] as string);
  expect(url.searchParams.get('maxdate')).toBe('2021/04/15');
  expect(url.searchParams.get('retmax')).toBe('0');
  const previous = JSON.parse(readFileSync(path(3), 'utf8')) as Trial;
  previous.complete = false; previous.outcome = 'network_error';
  writeFileSync(path(3), JSON.stringify(previous));
  const completed = readFileSync(path(1), 'utf8');
  await main(baseArgs, FIXTURES, results, deps);
  expect(deps.generate).toHaveBeenCalledTimes(4);
  expect(readFileSync(path(1), 'utf8')).toBe(completed);
  expect(JSON.parse(readFileSync(path(3).replace('.json', '.history.jsonl'), 'utf8'))).toEqual(previous);
  expect(JSON.parse(readFileSync(path(3), 'utf8')).complete).toBe(true);
  await expect(main([...baseArgs.slice(0, -1), '4', '--dry-run'], FIXTURES, results, deps)).rejects.toThrow('試行数');
  expect(existsSync(join(root, 'plan.json'))).toBe(true);
});

test('実 fetch 失敗は生成と診断の両経路で未完了になり、キーは保存されない', async () => {
  const { results, path, deps } = setup();
  const secret = 'secret-test-api-key';
  deps.secrets = [secret];
  deps.fetch = jest.fn().mockRejectedValue(new Error(`通信断 ${secret}`));
  deps.provider = (network) => ({ model: 'fake', providerId: 'gemini', chat: async () => {
    await network(`https://example.test/?key=${secret}`); throw new Error('到達しない');
  } });
  deps.generate = async (_input, context) => {
    await context.llmFactory.forPurpose('draft_block').chat([{ role: 'user', content: secret }]); return draft;
  };
  await main([...baseArgs.slice(0, -1), '1'], FIXTURES, results, deps);
  expect(JSON.parse(readFileSync(path(1), 'utf8')).outcome).toBe('generation_transient');
  deps.generate = async () => draft;
  await main([...baseArgs.slice(0, -1), '1'], FIXTURES, results, deps);
  const result = JSON.parse(readFileSync(path(1), 'utf8')) as Trial;
  expect(result.outcome).toBe('network_error');
  expect(result.complete).toBe(false);
  function check(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) check(file); else expect(readFileSync(file, 'utf8')).not.toContain(secret);
    }
  }
  check(results);
});

test('集計は生成失敗も完了分母に含め、未完了と未実行を分ける', async () => {
  const { results, root, path, deps } = setup();
  deps.generate = async () => { throw new Error('生成失敗'); };
  await main(baseArgs, FIXTURES, results, deps);
  const plan = JSON.parse(readFileSync(join(root, 'plan.json'), 'utf8')) as Plan;
  plan.trials = 4;
  const pending = JSON.parse(readFileSync(path(3), 'utf8')) as Trial;
  pending.complete = false; pending.outcome = 'generation_transient';
  pending.diagnostics = (['block', 'formula'] as const).map((target) => ({ target, id: '1', expression: 'missing[Mesh]',
    status: 'syntax_error', count: null, error: '構文エラー', phrasesNotFound: ['missing'], fieldsNotFound: [] }));
  pending.meshLookups = [{ phrase: 'missing', term: 'missing', status: 'unresolved', error: null }];
  writeFileSync(path(3), JSON.stringify(pending));
  const summary = reportFrequency(root, plan);
  expect(summary).toContain('| 全体 | 4 | 2 | 1 | 1 | 2/2 | 0/2 | 0/2 | 0/2 | 0/2 | 0/0 | 0/0 | 0 | 0 | 0 | 0 | 0 |');
  expect(existsSync(join(root, 'summary.csv'))).toBe(true);
});

test('other_error は完了として集計され、再実行しない', async () => {
  const { results, root, path, deps } = setup();
  deps.fetch = jest.fn(async () => new Response(JSON.stringify({ esearchresult: {} })));
  const args = [...baseArgs.slice(0, -1), '1'];
  await main(args, FIXTURES, results, deps);
  expect(JSON.parse(readFileSync(path(1), 'utf8'))).toMatchObject({ outcome: 'other_error', complete: true });
  await main(args, FIXTURES, results, deps);
  expect(deps.generate).toHaveBeenCalledTimes(1);
  const summary = reportFrequency(root, JSON.parse(readFileSync(join(root, 'plan.json'), 'utf8')) as Plan);
  expect(summary).toContain('| syntax_error/完了 | other_error/完了 |');
  expect(summary).toContain('| 全体 | 1 | 1 | 0 | 0 | 0/1 | 0/1 | 1/1 | 0/1 | 0/1 | 0/1 | 0/1 |');
});

test('未完了試行の再実行後も実行回数の接頭辞で LLM ログを保持する', async () => {
  const { results, path, deps } = setup();
  deps.provider = () => ({ model: 'fake', providerId: 'gemini', chat: async () => ({ text: 'draft', tokensIn: 1, tokensOut: 1, raw: null }) });
  deps.generate = async (_input, context) => {
    await context.llmFactory.forPurpose('draft_block').chat([{ role: 'user', content: 'draft' }]);
    return draft;
  };
  deps.fetch = jest.fn().mockRejectedValue(new Error('通信断'));
  const args = [...baseArgs.slice(0, -1), '1'];
  await main(args, FIXTURES, results, deps);
  expect(JSON.parse(readFileSync(path(1), 'utf8')).complete).toBe(false);
  const logDir = join(path(1).slice(0, -5), 'llm');
  const firstLogs = readdirSync(logDir).map((file) => [file, readFileSync(join(logDir, file), 'utf8')] as const);
  expect(firstLogs.map(([file]) => file)).toEqual(['a1-0001_draft_block.json']);
  deps.fetch = jest.fn(async () => new Response(JSON.stringify({ esearchresult: { count: '1' } })));
  await main(args, FIXTURES, results, deps);
  expect(JSON.parse(readFileSync(path(1), 'utf8')).complete).toBe(true);
  expect(readdirSync(logDir).sort()).toEqual(['a1-0001_draft_block.json', 'a2-0001_draft_block.json']);
  for (const [file, content] of firstLogs) expect(readFileSync(join(logDir, file), 'utf8')).toBe(content);
});

test('dry-run と結果なし report は環境も通信も使わず、dry-run は書かない', async () => {
  const { results, root, deps } = setup();
  jest.mocked(config).mockClear();
  await main([...baseArgs, '--dry-run'], FIXTURES, results, deps);
  expect(existsSync(root)).toBe(false);
  expect(deps.fetch).not.toHaveBeenCalled();
  await main(['--report'], FIXTURES, results, deps);
  expect(output).toHaveBeenCalledWith(expect.stringContaining('0 件'));
  expect(config).not.toHaveBeenCalled();
  expect(deps.fetch).not.toHaveBeenCalled();
});
