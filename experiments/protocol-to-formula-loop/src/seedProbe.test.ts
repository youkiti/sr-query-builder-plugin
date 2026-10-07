/** @jest-environment node */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DESIGN_SPECIFIC_QUERY_SYSTEM_PROMPT } from '../../../src/features/formula/skills/designSpecificQuery';
import { installDomParser } from '../../query-optimization-bench/domParser';
import { loadConditions } from './conditions';
import { createRun, runPath } from './runDir';
import { main } from './seedProbe';
import { splitReviews } from './split';
import type { RunRuntime } from './startRuns';
import { validateFormulaMd } from './submission';
import { fixture, review, writeJson, writeLines } from './testFixtures';

installDomParser();
const gold = Array.from({ length: 12 }, (_, i) => String(90000001 + i));
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'p2f-seed-probe-')), runs = join(root, 'runs'), casesDir = join(root, 'cases');
  const rows = Array.from({ length: 20 }, (_, i) => review(i + 1));
  fixture(root, rows);
  const selected = rows.filter((row) => splitReviews(rows).get(row.pmcid) === 'development').slice(0, 4);
  const sizes = [3, 4, 11, 1];
  writeLines(join(root, 'data/processed/cc-by/gold/task2_search_screen.jsonl'), rows.map((row) => {
    const size = sizes[selected.indexOf(row)] ?? 1, ids = gold.slice(0, size + 1);
    return { pmcid: row.pmcid, included_pmids: ids, pmid_to_study_id: Object.fromEntries(ids.map((id, i) => [id, `研究${Math.max(0, i - 1)}`])) };
  }));
  writeLines(join(casesDir, 'evaluable.jsonl'), rows.map((row) => {
    const ids = gold.slice(0, (sizes[selected.indexOf(row)] ?? 1) + 1);
    return { pmcid: row.pmcid, cutoffDate: row.cutoffDate, existing: ids, withinCutoff: ids, measuredAt: '2026-01-01T00:00:00Z' };
  }));
  writeJson(join(casesDir, 'subsets.json'), { smoke: selected.map((row) => row.pmcid), fixed: selected.map((row) => row.pmcid) });
  const protocolPath = join(root, 'protocol.md');
  writeFileSync(protocolPath, '合成プロトコル');
  for (const row of selected) {
    const dir = createRun({ root: runs, version: 'v1', pmcid: row.pmcid, runIndex: 1, cutoffDate: row.cutoffDate,
      conditions: loadConditions('v1'), protocolPath, now: () => new Date('2026-01-01') });
    const md = '## PubMed/MEDLINE\n\n```\n#1 alpha[tiab]\n#2 beta[Mesh]\n#3 #1 AND #2\n```\n';
    const validated = validateFormulaMd(md);
    if (!validated.ok) throw new Error('合成式が不正です');
    mkdirSync(join(dir, 'submissions'));
    writeFileSync(join(dir, 'submissions', '1.md'), md);
    writeJson(join(dir, 'submission.json'), { number: 1, query: validated.query });
  }
  const pool = Array.from({ length: 50 }, (_, i) => String(80000001 + i));
  for (const [index, position] of [0, 4, 5, 10, 19, 20, 49].entries()) pool[position] = gold[index]!;
  const fetchImpl = jest.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input)), params = init?.method === 'POST' ? new URLSearchParams(String(init.body)) : url.searchParams;
    expect(url.pathname.endsWith('/esearch.fcgi')).toBe(true);
    expect(params.get('sort')).toBe('relevance');
    expect(params.get('retmax')).toBe('50');
    expect(params.get('datetype')).toBe('edat');
    expect(params.get('maxdate')).toBe('2020/01/31');
    const term = params.get('term')!;
    if (term.includes('zero')) return new Response(JSON.stringify({ esearchresult: { count: '0', idlist: [] } }));
    if (term.includes('reject')) return new Response(JSON.stringify({ esearchresult: { ERROR: '拒否 PMC9999999 90000001 FAKE_SECRET' } }));
    expect(term).toBe('(narrow[ti])');
    return new Response(JSON.stringify({ esearchresult: { count: '80', idlist: pool } }));
  });
  const runtime: RunRuntime = { casesDir, reportsDir: join(root, 'reports'),
    env: { COCHRANE_BENCH_DIR: root, NCBI_API_KEY: 'FAKE_SECRET' }, fetchImpl,
    rateLimiter: { acquire: jest.fn(async () => undefined) }, sleep: async () => undefined,
    now: () => new Date('2026-01-01'), stdout: jest.fn(), stderr: jest.fn() };
  const args = ['--runs', runs, '--source', 'v1', '--label', 'probe', '--subset', 'smoke'];
  const dir = (i = 0) => join(runs, '_seed-probe', 'probe', selected[i]!.pmcid);
  const source = (i = 0) => runPath(runs, 'v1', selected[i]!.pmcid, 1);
  const response = (i: number, query: string) => writeJson(join(dir(i), 'response.json'), { specific_query: query, rationale: '合成の意図' });
  const prepare = async () => {
    await main(['prepare', ...args], runtime);
    response(0, '```\n(narrow[ti])\n```'); response(1, 'zero[ti]'); response(2, '('); response(3, 'reject[ti]');
  };
  const reportPath = join(runtime.reportsDir!, 'seed-probe-probe-smoke.json');
  const report = () => JSON.parse(readFileSync(reportPath, 'utf8'));
  return { root, args, runtime, fetchImpl, pool, dir, source, response, prepare, report, reportPath, selected };
}

test('製品の指示文と適格基準・概念行だけを用意し、既存の指示文と入力を上書きせず通信しない', async () => {
  const f = setup();
  await f.prepare();
  const prompt = readFileSync(join(f.dir(), 'prompt.md'), 'utf8');
  for (const text of [DESIGN_SPECIFIC_QUERY_SYSTEM_PROMPT, '合成レビューの題\n\n合成の目的', '合成の研究種別',
    '合成の対象', '合成の介入', '合成の評価項目', '#1 alpha[tiab]', '#2 beta[Mesh]', '`response.json`']) expect(prompt).toContain(text);
  expect(prompt).not.toMatch(/混入禁止の|#3|#1 AND #2/);
  const input = readFileSync(join(f.dir(), 'input.json'), 'utf8');
  expect(JSON.parse(input)).toMatchObject({ exclusionCriteria: '', studyDesign: '合成の研究種別', cutoffDate: '2020-01-31' });
  writeFileSync(join(f.dir(), 'prompt.md'), '保存済み');
  await main(['prepare', ...f.args], f.runtime);
  expect(readFileSync(join(f.dir(), 'prompt.md'), 'utf8')).toBe('保存済み');
  expect(readFileSync(join(f.dir(), 'input.json'), 'utf8')).toBe(input);
  expect(f.runtime.stdout).toHaveBeenLastCalledWith('用意した指示文: 新規 0 件、既にあり飛ばした 4 件\n');
  expect(f.fetchImpl).not.toHaveBeenCalled();
});

test('提出と応答の不足は対象全体で事前検出する', async () => {
  const f = setup();
  unlinkSync(join(f.source(2), 'submissions', '1.md')); unlinkSync(join(f.source(3), 'submission.json'));
  await expect(main(['prepare', ...f.args], f.runtime)).rejects.toThrow('実行フォルダまたは提出が 2 件不足しています');
  expect(existsSync(f.dir())).toBe(false);
  const g = setup(); await g.prepare();
  unlinkSync(join(g.dir(2), 'input.json')); unlinkSync(join(g.dir(3), 'response.json'));
  await expect(main(['measure', ...g.args], g.runtime)).rejects.toThrow('指示文または応答が 2 件不足しています');
  expect(g.fetchImpl).not.toHaveBeenCalled(); expect(existsSync(g.reportPath)).toBe(false);
});

test('四状態を全対象の分母で集計し、同一研究の複数報告と上位件数の境目を数え分ける', async () => {
  const f = setup(); await f.prepare();
  await main(['measure', ...f.args], f.runtime);
  expect(f.report()).toMatchObject({ reviews: 4, states: { measured: 1, zero_hits: 1, design_failed: 1, rejected: 1 },
    hitsQuantiles: { min: 80, q1: 80, median: 80, q3: 80, max: 80 },
    top5: { goldReportsTotal: 2, goldStudiesTotal: 1, reviewsWithAtLeast1: 1, reviewsWithAtLeast1Rate: 0.25, reviewsWithAtLeast2Rate: 0 },
    top10: { goldReportsTotal: 3, goldStudiesTotal: 2, reviewsWithAtLeast2: 1, reviewsWithAtLeast2Rate: 0.25 },
    top20: { goldReportsTotal: 4, goldStudiesTotal: 3, goldStudiesQuantiles: { min: 0, q1: 0, median: 0, q3: 0.75, max: 3 } },
    top50: { goldReportsTotal: 4, goldStudiesTotal: 3 },
    byStudyCount: { '1-3': { reviews: 2, top5: { reviewsWithAtLeast1Rate: 0.5 } },
      '4-10': { reviews: 1, top50: { reviewsWithAtLeast1Rate: 0 } }, '11+': { reviews: 1, top50: { reviewsWithAtLeast1Rate: 0 } } } });
  const output = readFileSync(f.reportPath, 'utf8') + JSON.stringify((f.runtime.stdout as jest.Mock).mock.calls);
  expect(output).not.toMatch(/PMC|9000000|8000000|FAKE_SECRET|narrow|alpha|beta|\[ti\]/);
  for (let i = 0; i < 4; i++) expect(readFileSync(join(f.dir(i), 'result.json'), 'utf8')).not.toMatch(/PMC|9000000|8000000|FAKE_SECRET|narrow|alpha|beta/);
  expect(f.fetchImpl).toHaveBeenCalledTimes(3);
  f.fetchImpl.mockClear();
  f.runtime.now = () => new Date('2026-02-01');
  await main(['measure', ...f.args], f.runtime);
  expect(f.fetchImpl).not.toHaveBeenCalled();
  expect(f.runtime.stdout).toHaveBeenCalledWith('測ったレビュー: 新規 0 件、保存済み 4 件、測り直し 0 件\n');
  expect(f.report()).toMatchObject({ generatedAt: '2026-02-01T00:00:00.000Z', measuredFrom: '2026-01-01T00:00:00.000Z', measuredTo: '2026-01-01T00:00:00.000Z' });
  f.response(2, '(narrow[ti])');
  await main(['measure', ...f.args], f.runtime);
  expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  expect(f.runtime.stdout).toHaveBeenCalledWith('測ったレビュー: 新規 0 件、保存済み 3 件、測り直し 1 件\n');
  expect(f.report()).toMatchObject({ top20: { goldReportsTotal: 9, goldStudiesTotal: 7 }, top50: { goldReportsTotal: 11, goldStudiesTotal: 9 },
    measuredTo: '2026-02-01T00:00:00.000Z' });
});

test.each(['壊れた JSON', '', 'null', '{"specific_query":""}', '{"specific_query":")("}',
  '{"specific_query":"narrow[ti]","rationale":42}'])('壊れた応答を設計失敗としてゼロ集計する（%s）', async (response) => {
  const f = setup(); await f.prepare();
  writeFileSync(join(f.dir(), 'response.json'), response);
  await main(['measure', ...f.args], f.runtime);
  expect(f.report()).toMatchObject({ states: { design_failed: 2 }, top50: { goldStudiesTotal: 0 } });
});

test.each(['通信', 'タイムアウト', '件数不足', '重複', '認証'])('結果不明は例外で停止し、集計も結果も保存せず機微情報を出さない（%s）', async (kind) => {
  const f = setup(); await f.prepare();
  f.fetchImpl.mockImplementation(async (_input, init) => {
    if (kind === '通信') throw new Error('PMC9999999 90000001 narrow[ti] FAKE_SECRET');
    if (kind === 'タイムアウト') return new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error('PMC9999999 FAKE_SECRET')));
    });
    if (kind === '認証') return new Response('FAKE_SECRET', { status: 401 });
    return new Response(JSON.stringify({ esearchresult: { count: '50', idlist: kind === '件数不足' ? f.pool.slice(1) : Array(50).fill(gold[0]) } }));
  });
  f.runtime.timeoutMs = 1;
  let caught: unknown;
  try { await main(['measure', ...f.args], f.runtime); } catch (error) { caught = error; }
  expect(String(caught)).toContain('結果不明');
  expect(String(caught)).not.toMatch(/PMC|90000001|narrow|FAKE_SECRET/);
  expect(existsSync(f.reportPath)).toBe(false); expect(existsSync(join(f.dir(), 'result.json'))).toBe(false);
});

test.each(['prepare', 'measure'])('開発群以外と余分な引数・不正な名前を拒否する（%s）', async (command) => {
  const f = setup();
  for (const subset of ['validation', 'test']) {
    await expect(main([command, ...f.args.slice(0, -1), subset], f.runtime)).rejects.toThrow('シードの下調べは開発群でだけ実行できます');
  }
  for (const extra of [['--open-test-set'], ['--runs-per-review', '2'], ['--label', '../PMC123']]) {
    await expect(main([command, ...f.args, ...extra], f.runtime)).rejects.toThrow('実行引数が不正です');
  }
  await expect(main([command, ...f.args.map((arg) => arg === 'probe' ? '../PMC123' : arg)], f.runtime)).rejects.toThrow('版または名前の指定が不正です');
  expect(f.fetchImpl).not.toHaveBeenCalled();
});

test('ファイルの破損や読み込み失敗はパスや内容を公開しない', async () => {
  const f = setup(); await f.prepare();
  writeFileSync(join(f.dir(), 'input.json'), 'PMC9999999 FAKE_SECRET');
  await expect(main(['measure', ...f.args], f.runtime)).rejects.toThrow('シードの下調べのファイルの読み書きに失敗しました');
  expect(f.fetchImpl).not.toHaveBeenCalled();
});

test('日付・正解・研究対応の変更を指紋に反映し、並び順だけなら再利用する', async () => {
  const f = setup(); await f.prepare();
  const measure = () => main(['measure', ...f.args], f.runtime);
  await measure(); f.fetchImpl.mockClear();
  const goldPath = join(f.root, 'data/processed/cc-by/gold/task2_search_screen.jsonl');
  const entries = readFileSync(goldPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as {
    pmcid: string; included_pmids: string[]; pmid_to_study_id: Record<string, string>;
  });
  for (const entry of entries) entry.included_pmids.reverse();
  writeLines(goldPath, entries); await measure(); expect(f.fetchImpl).not.toHaveBeenCalled();
  const entry = entries.find((row) => row.pmcid === f.selected[0]!.pmcid)!;
  entry.pmid_to_study_id[gold[1]!] = '別の研究';
  writeLines(goldPath, entries); await measure(); expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  f.fetchImpl.mockClear();
  const evaluablePath = join(f.runtime.casesDir!, 'evaluable.jsonl');
  const records = readFileSync(evaluablePath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as { pmcid: string; withinCutoff: string[] });
  records.find((row) => row.pmcid === f.selected[0]!.pmcid)!.withinCutoff.pop();
  writeLines(evaluablePath, records); await measure(); expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  f.fetchImpl.mockClear();
  const inputPath = join(f.dir(), 'input.json'), input = JSON.parse(readFileSync(inputPath, 'utf8'));
  input.cutoffDate = '2019-01-31'; writeJson(inputPath, input);
  f.fetchImpl.mockImplementation(async (url, init) => {
    const params = init?.method === 'POST' ? new URLSearchParams(String(init.body)) : new URL(String(url)).searchParams;
    expect(params.get('maxdate')).toBe('2019/01/31');
    return new Response(JSON.stringify({ esearchresult: { count: '0', idlist: [] } }));
  });
  await measure(); expect(f.fetchImpl).toHaveBeenCalledTimes(1);
});
