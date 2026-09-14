/** @jest-environment node */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
const draft: DraftGeneration = { formula: { blocks: [{ id: '1', expression: 'hello[tiab]', isCombination: false }], combinationExpression: '#1' },
  markdown: '生の検索式', removedMeshHeadings: [], replacedMeshHeadings: [],
  filter: { filters: [], appendToCombination: '', excessFilterCandidates: [] },
  blockSkeletons: [], meshSuggestions: [], freewordSuggestions: [],
  blockHits: [{ blockIndex: 0, blockId: '1', blockLabel: '対象', expression: 'hello[tiab]', hitCount: 0, error: '生成時の構文エラー' }] };
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
  ['--report', '--label', '..'], ['--report', '--label', 'replay-x'], ['--report', '--report'],
  ['--relookup', '--trials', '1'], ['--relookup', '--dry-run'], ['--relookup', '--report']])('引数を拒否: %j', (...args) => {
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
  expect(JSON.parse(readFileSync(path(2), 'utf8')).removedMeshHeadings).toEqual([]);
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
  pending.meshLookups = [{ phrase: 'missing', term: 'missing', unquotedComma: true, status: 'unresolved', error: null }];
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

test.each([
  { files: ['a1-0001_draft_block.json'], history: 0, attempt: '2' },
  { files: ['a2-old.json', 'a10-old.json', 'a0-ignore.json', 'a-3-ignore.json', 'a1.5-ignore.json', 'other.json'], history: 0, attempt: '11' },
  { files: ['a1-old.json'], history: 3, attempt: '4' },
])('試行保存前の中断ログと履歴から次の実行番号を決める: %j', async ({ files, history, attempt }) => {
  const { results, path, deps } = setup();
  const logDir = join(path(1).slice(0, -5), 'llm');
  mkdirSync(logDir, { recursive: true });
  for (const file of files) writeFileSync(join(logDir, file), `interrupted: ${file}`);
  mkdirSync(join(logDir, 'a99-directory'));
  const historyPath = path(1).replace('.json', '.history.jsonl');
  if (history) writeFileSync(historyPath, '{}\n'.repeat(history));
  expect(existsSync(path(1))).toBe(false);
  expect(existsSync(historyPath)).toBe(history > 0);
  deps.provider = () => ({ model: 'fake', providerId: 'gemini', chat: async () => ({ text: 'draft', tokensIn: 1, tokensOut: 1, raw: null }) });
  deps.generate = async (_input, context) => {
    await context.llmFactory.forPurpose('draft_block').chat([{ role: 'user', content: 'draft' }]);
    return draft;
  };
  await main([...baseArgs.slice(0, -1), '1'], FIXTURES, results, deps);
  expect(JSON.parse(readFileSync(path(1), 'utf8')).llmLogs).toEqual([`llm/a${attempt}-0001_draft_block.json`]);
  expect(existsSync(join(logDir, `a${attempt}-0001_draft_block.json`))).toBe(true);
  for (const file of files) expect(readFileSync(join(logDir, file), 'utf8')).toBe(`interrupted: ${file}`);
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

test('再照会は plan がなければ入力読込や通信前に拒否する', async () => {
  const { results, root, deps } = setup();
  await expect(main(['--relookup'], '存在しない入力', results, deps)).rejects.toThrow('plan.json が必要');
  expect(deps.fetch).not.toHaveBeenCalled();
  expect(deps.generate).not.toHaveBeenCalled();
  expect(existsSync(root)).toBe(false);
});

test('再照会は完了診断だけを置換し、初回値と履歴を保持して LLM を呼ばない', async () => {
  const { results, deps } = setup();
  const root = join(results, 'draft-frequency', 'saved');
  const path = (k: number) => join(root, id, 'criteria-only', `trial-${k}.json`);
  mkdirSync(join(root, id, 'criteria-only'), { recursive: true });
  const condition = { caseId: id, variant: 'criteria-only' as const, c0Name: 'criteria-only-draft1', c0Sha256: 'sha' };
  const plan: Plan = { trials: 4, conditions: [condition, { ...condition, variant: 'seeded' }, { ...condition, caseId: 'r2-pdr-prognostic' }], createdAt: '', gitCommit: null };
  writeFileSync(join(root, 'plan.json'), JSON.stringify(plan));
  const previousMeshLookups = [{ phrase: 'Proliferative', term: null, status: 'not_mesh', error: null }];
  const diagnostics = (['block', 'formula'] as const).map((target) => ({ target, id: '1',
    expression: 'x[tiab] OR Diabetic Retinopathy, Proliferative[Mesh]', status: 'syntax_error', count: null,
    error: '構文エラー', phrasesNotFound: ['Proliferative', 'Proliferative'], fieldsNotFound: [] }));
  const saved = { complete: true, diagnostics, meshLookups: previousMeshLookups, outcome: 'syntax_error', formulaMd: '保存した式' };
  writeFileSync(path(1), JSON.stringify(saved));
  writeFileSync(path(2), JSON.stringify({ ...saved, complete: false }));
  writeFileSync(path(4), JSON.stringify({ ...saved, diagnostics: [] }));
  const excluded = plan.conditions.slice(1).map((item) => join(root, item.caseId, item.variant, 'trial-1.json'));
  for (const file of excluded) { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, JSON.stringify(saved)); }
  const untouched = [path(2), ...excluded].map((file) => [file, readFileSync(file, 'utf8')] as const);
  const history = path(1).replace('.json', '.history.jsonl');
  writeFileSync(history, '{"旧履歴":true}\n');
  deps.provider = jest.fn(deps.provider!);
  const secret = 'fake-ncbi-key';
  const originalKey = process.env.NCBI_API_KEY;
  process.env.NCBI_API_KEY = secret;
  deps.fetch = jest.fn().mockResolvedValueOnce(new Response('', { status: 429 }))
    .mockImplementation(async () => new Response(JSON.stringify({ esearchresult: { count: '0',
      warninglist: { quotedphrasesnotfound: ['"Diabetic Retinopathy, Proliferative"[mh]'] } } })));
  deps.eutils = { maxRetries: 1, sleep: jest.fn(async () => undefined) };
  const args = ['--relookup', '--label', 'saved', '--case', id, '--variant', 'criteria-only'];
  try {
    for (let run = 0; run < 2; run++) {
      await main(args, '存在しない入力', results, deps);
      const result = JSON.parse(readFileSync(path(1), 'utf8')) as Trial;
      expect(result.meshLookups).toEqual([{ phrase: 'Proliferative', term: 'Diabetic Retinopathy, Proliferative', unquotedComma: true, status: 'unresolved', error: null }]);
      expect(result.relookup?.previousMeshLookups).toEqual(previousMeshLookups);
      expect(Number.isFinite(Date.parse(result.relookup!.at))).toBe(true);
      expect(result.relookup).toHaveProperty('gitCommit');
      expect({ ...result, meshLookups: previousMeshLookups, relookup: undefined }).toEqual({ ...saved, relookup: undefined });
      expect(JSON.parse(readFileSync(path(4), 'utf8')).meshLookups).toEqual([]);
      for (const [file, content] of untouched) expect(readFileSync(file, 'utf8')).toBe(content);
      expect(existsSync(path(3))).toBe(false);
      expect(readFileSync(history, 'utf8')).toBe('{"旧履歴":true}\n');
      expect(existsSync(path(4).replace('.json', '.history.jsonl'))).toBe(false);
    }
    expect(deps.fetch).toHaveBeenCalledTimes(3);
    expect(deps.eutils.sleep).toHaveBeenCalledWith(1000);
    expect(sharedEutilsRateLimiters.withApiKey.acquire).toHaveBeenCalledTimes(3);
    for (const [input] of jest.mocked(deps.fetch!).mock.calls) {
      const params = new URL(String(input)).searchParams;
      expect(params.get('db')).toBe('mesh');
      expect(params.get('term')).toBe('"Diabetic Retinopathy, Proliferative"[mh]');
      expect(params.get('api_key')).toBe(secret);
      for (const key of ['maxdate', 'mindate', 'datetype']) expect(params.has(key)).toBe(false);
    }
    expect(deps.generate).not.toHaveBeenCalled();
    expect(deps.provider).not.toHaveBeenCalled();
    expect(output).toHaveBeenCalledWith(expect.stringContaining('trial-4: 照会語数=0'));
    const events = readFileSync(join(root, 'relookup-progress.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line).event);
    expect(events.filter((event) => event.api)).toHaveLength(3);
    expect(events.filter((event) => event.terms === 0)).toHaveLength(2);
    const summary = reportFrequency(root, plan, { caseId: id, variant: 'criteria-only' });
    expect(summary).toContain('| not_mesh語 | カンマ未引用の語 |');
    expect(summary.split('\n').find((line) => line.startsWith('| 全体 |'))).toMatch(/\| 1 \| 0 \| 0 \| 0 \| 0 \| 1 \| 0 \| 0 \|$/);
    const check = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const file = join(dir, entry.name);
        if (entry.isDirectory()) check(file); else expect(readFileSync(file, 'utf8')).not.toContain(secret);
      }
    };
    check(root);
  } finally {
    if (originalKey === undefined) delete process.env.NCBI_API_KEY; else process.env.NCBI_API_KEY = originalKey;
  }
});


test('辞書確認を注入し、除外見出しを保存して完了試行だけ集計する', async () => {
  const { results, root, path, deps } = setup();
  const removedMeshHeadings = [{ blockIndex: 0, blockId: '1', blockLabel: '対象', descriptor: 'Missing' }];
  const replacedMeshHeadings = [{ blockIndex: 0, blockId: '1', blockLabel: '対象', from: 'Heart Attack', to: ['Myocardial Infarction'] }];
  deps.fetch = jest.fn(async (url) => new Response(JSON.stringify(String(url).includes('esummary')
    ? { result: { uids: ['68009369'], '68009369': { ds_recordtype: 'descriptor', ds_meshterms: ['Neoplasms'] } } }
    : { esearchresult: { count: '1', idlist: ['68009369'] } })));
  deps.generate = async (_input, context) => {
    expect(await context.resolveMeshDescriptors!(['Neoplasms'])).toEqual(new Map([['Neoplasms', { status: 'resolved', headings: ['Neoplasms'] }]]));
    return { ...draft, removedMeshHeadings, replacedMeshHeadings };
  };
  await main(baseArgs, FIXTURES, results, deps);
  expect(JSON.parse(readFileSync(path(1), 'utf8')).removedMeshHeadings).toEqual(removedMeshHeadings);
  expect(JSON.parse(readFileSync(path(1), 'utf8')).replacedMeshHeadings).toEqual(replacedMeshHeadings);
  const pending = JSON.parse(readFileSync(path(3), 'utf8')) as Trial;
  pending.complete = false;
  writeFileSync(path(3), JSON.stringify(pending));
  const summary = reportFrequency(root, JSON.parse(readFileSync(join(root, 'plan.json'), 'utf8')) as Plan);
  expect(summary).toContain('| 外した見出し | 置き換えた見出し |');
  expect(summary.split('\n').find((line) => line.startsWith('| 全体 |'))).toMatch(/\| 2 \| 2 \|$/);
});
