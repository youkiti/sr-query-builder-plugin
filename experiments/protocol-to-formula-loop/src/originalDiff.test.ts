/** @jest-environment node */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BenchRow } from './bench';
import { loadConditions } from './conditions';
import { main } from './originalDiff';
import { createRun, runPath, writeJson } from './runDir';
import { readSubmissionState } from './scoreRuns';
import { splitReviews } from './split';
import type { RunRuntime } from './startRuns';
import { validateFormulaMd } from './submission';
import { fixture, review, writeLines } from './testFixtures';

const gold = ['90000001', '90000002', '90000003', '90000004'];
const outside = '99999999';
const md = (expression: string) => '## PubMed/MEDLINE\n\n```\n#1 ' + expression + '\n```\n';
const unit = (query: string, translator = 'translator-a'): NonNullable<BenchRow['units']>[number] => ({
  query, translator, count: 50, database: 'MEDLINE', result_set: '', segment: '', strategy_index: 1, translation_sha: '',
});
function setup(units = [unit('(originala[Mesh] AND originalb[tiab]) AND 2020[edat]')],
  expressions = ['alpha[Mesh] AND beta[tiab]', 'alpha[Mesh] AND beta[tiab]',
    'alpha[Mesh] AND trial[pt]', 'alpha[Mesh] AND beta[tiab]']) {
  const root = mkdtempSync(join(tmpdir(), 'p2f-original-diff-'));
  const casesDir = join(root, 'cases'), harnessDir = join(root, 'harness'), runs = join(root, 'runs');
  const rows = Array.from({ length: 10 }, (_, i) => ({ ...review(i + 1), units, n_records: 100,
    included_not_retrieved: [gold[1]!, gold[3]!] }));
  fixture(root, rows);
  writeLines(join(root, 'data/processed/cc-by/gold/task2_search_screen.jsonl'), rows.map((row) => ({
    pmcid: row.pmcid, included_pmids: [...gold, outside], pmid_to_study_id: { [gold[0]!]: '一', [outside]: '二', [gold[1]!]: '二' },
  })));
  writeLines(join(casesDir, 'evaluable.jsonl'), rows.map((row) => ({ pmcid: row.pmcid,
    cutoffDate: row.cutoffDate, existing: [...gold, outside], withinCutoff: gold, measuredAt: '2026-01-01T00:00:00Z' })));
  const selected = rows.find((row) => splitReviews(rows).get(row.pmcid) === 'development')!;
  writeJson(join(casesDir, 'subsets.json'), { smoke: [selected.pmcid], fixed: [selected.pmcid] });
  const protocolPath = join(root, 'protocol.md'); writeFileSync(protocolPath, '合成プロトコル');
  const conditions = { ...loadConditions('v1'), version: 'bundle', combine: { from: 'v1', k: 2 } };
  mkdirSync(join(harnessDir, 'bundle'), { recursive: true }); writeJson(join(harnessDir, 'bundle/conditions.json'), conditions);
  const source = (i = 1) => runPath(runs, 'v1', selected.pmcid, i);
  const bundle = (i = 1) => runPath(runs, 'bundle', selected.pmcid, i);
  const create = (version: string, i: number, expression: string, pmids: string[] = []) => {
    const dir = createRun({ root: runs, version, pmcid: selected.pmcid, runIndex: i, cutoffDate: selected.cutoffDate,
      conditions: version === 'v1' ? loadConditions('v1') : conditions, protocolPath, now: () => new Date('2026-01-01') });
    const text = md(expression), validated = validateFormulaMd(text);
    if (!validated.ok) throw new Error('合成式が不正です');
    mkdirSync(join(dir, 'submissions')); writeFileSync(join(dir, 'submissions/1.md'), text);
    writeJson(join(dir, 'submission.json'), { number: 1, query: validated.query });
    const state = readSubmissionState(dir);
    writeJson(join(dir, 'score.json'), { status: 'scored', submission: state.fingerprint, submitAttempts: state.submitAttempts,
      outcome: { status: 'measured', hits: i * 100, capturedPmids: pmids } });
  };
  expressions.forEach((expression, i) => create('v1', i + 1, expression));
  create('bundle', 1, 'bundled[tiab]', [gold[1]!, outside]);
  create('bundle', 2, 'bundled[tiab]', [gold[1]!, gold[2]!, outside]);
  const fetchImpl = jest.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input)), params = init?.method === 'POST' ? new URLSearchParams(String(init.body)) : url.searchParams;
    if (url.pathname.endsWith('/esummary.fcgi')) return new Response(JSON.stringify({ result: Object.fromEntries(
      params.get('id')!.split(',').map((pmid) => [pmid, { title: '合成の題' }])) }));
    expect(params.get('maxdate')).toBe('2020/01/31'); expect(params.get('datetype')).toBe('edat');
    const term = params.get('term')!;
    expect(term).not.toContain(outside);
    const ids = term.includes('alpha') ? [gold[1]!, gold[2]!, gold[3]!]
      : term.includes('trial') ? [gold[0]!, gold[1]!, gold[2]!]
        : term.includes('originala') ? [gold[0]!, gold[2]!]
          : term.includes('originalb') ? [gold[0]!, gold[1]!, gold[2]!] : gold;
    return new Response(JSON.stringify({ esearchresult: { count: String(ids.length), idlist: ids } }));
  });
  const runtime: RunRuntime = { casesDir, harnessDir, reportsDir: join(root, 'reports'),
    env: { COCHRANE_BENCH_DIR: root, NCBI_API_KEY: 'FAKE_SECRET' }, fetchImpl,
    rateLimiter: { acquire: async () => undefined }, sleep: async () => undefined,
    now: () => new Date('2026-01-01'), stdout: jest.fn(), stderr: jest.fn() };
  const args = ['--runs', runs, '--subset', 'smoke', '--bundle', 'bundle', '--bundle-runs', '2', '--label', 'example'];
  const reportPath = join(runtime.reportsDir!, 'original-diff-bundle-smoke.json');
  const report = () => JSON.parse(readFileSync(reportPath, 'utf8'));
  const readingPath = join(runs, '_original-diff/example', `${selected.pmcid}.md`);
  return { root, runs, selected, args, runtime, fetchImpl, source, bundle, reportPath, report, readingPath, conditions };
}

test('式単位の分布・研究と実行の組・回に対応する型を数え、評価不能な報告を除く', async () => {
  const f = setup();
  expect(await main(f.args, f.runtime)).toBe(0);
  expect(f.report()).toMatchObject({ reviews: 1, translators: { 'translator-a': 1 },
    structure: { ai: { formulas: 4, conceptCounts: { '1': 1, '2': 3 }, filterRate: 0.25,
      meshTerms: { min: 0, max: 1 }, conceptRecall: { min: 0.75, max: 1 } },
    original: { formulas: 1, conceptCounts: { '2': 1 }, conceptRecall: { min: 0.5, max: 0.75 } }, hitsRatio: { median: 1.5 } },
    originalOnly: { pairs: { single_concept: 4, none: 2, excluded: 0 }, studies: { all_single_concept: 2, mixed: 1 } },
    bundleOnly: { pairs: { single_concept: 2 }, studies: { all_single_concept: 2 } },
  });
  const output = readFileSync(f.reportPath, 'utf8') + JSON.stringify((f.runtime.stdout as jest.Mock).mock.calls);
  expect(output).not.toMatch(/PMC|9000000|99999999|FAKE_SECRET|alpha|beta|originala|合成の題/);
  const reading = readFileSync(f.readingPath, 'utf8');
  expect(reading).toContain('合成の題'); expect(reading).toContain('研究: study:一');
  expect(reading).toContain('単位 inline-1'); expect(reading).toContain('原著だけ 2');
  f.fetchImpl.mockClear(); await main(f.args, f.runtime);
  expect(f.fetchImpl.mock.calls.every(([input]) => String(input).includes('esummary'))).toBe(true);
  expect(f.report().measurements.measured).toBe(0);
  expect(f.report().measurements.cached).toBe(10);
});

test('長い部分・壊れた要素・OR の AI 実行を帰属から除く', async () => {
  const f = setup([unit(`(${'x'.repeat(20001)} AND originalb[tiab]) AND 2020[edat]`), unit('壊れた式(')],
    ['alpha[Mesh] OR beta[tiab]', 'alpha[Mesh] AND beta[tiab]', 'alpha[Mesh] AND beta[tiab]', 'alpha[Mesh] AND beta[tiab]']);
  await main(f.args, f.runtime);
  expect(f.report()).toMatchObject({ exclusions: { undeterminedRuns: 1, undeterminedElements: 1, unmeasurableParts: 1, excludedElements: 2 },
    originalOnly: { pairs: { excluded: 2 }, studies: { incomplete: 2 } },
    bundleOnly: { pairs: { excluded: 4 }, studies: { incomplete: 2 } } });
  expect(f.fetchImpl.mock.calls.some(([, init]) => String(init?.body).includes('x'.repeat(20001)))).toBe(false);
});

test.each([
  ['alpha[Mesh] AND alpha[tiab]', 'multiple', 'all_multiple', 4],
  ['beta[tiab] AND alpha[pt]', 'single_filter', 'all_single_filter', 4],
  ['beta[tiab]', 'no_lines', 'mixed', 6],
  ['beta[tiab] AND beta[Mesh]', 'none', 'mixed', 6],
] as const)('帰属の区分と全実行で一致する型を数える: %s', async (expression, category, type, count) => {
  const f = setup(undefined, Array<string>(4).fill(expression));
  await main(f.args, f.runtime);
  expect(f.report().originalOnly.pairs[category]).toBe(count);
  expect(f.report().originalOnly.studies[type]).toBe(count === 6 ? 3 : 2);
});

test('否定の測定結果を評価可能な報告の補集合にして帰属させる', async () => {
  const f = setup(undefined, Array<string>(4).fill('beta[tiab] NOT alpha[Mesh]'));
  await main(f.args, f.runtime);
  expect(f.report()).toMatchObject({ structure: { ai: { negativeRate: 1, filterRate: 1, conceptCounts: { '1': 4 } } },
    originalOnly: { pairs: { single_filter: 2, none: 4 }, studies: { all_single_filter: 1, mixed: 2 } } });
});

test('同じ原著の複数翻訳を要素として数え、異なる帰属を混在にする', async () => {
  const f = setup([
    unit('(originala[Mesh] AND originala[tiab]) AND 2020[edat]', 'translator-a'),
    unit('(originalb[tiab] AND originala[pt]) AND 2020[edat]', 'translator-b'),
    unit('(originala[Mesh] OR originalb[tiab]) AND 2020[edat]', 'translator-a'),
  ]);
  await main(f.args, f.runtime);
  expect(f.report()).toMatchObject({ translators: { 'translator-a': 2, 'translator-b': 1 },
    structure: { original: { formulas: 3, conceptCounts: { '1': 2, '2': 1 }, filterRate: 1 / 3 } },
    bundleOnly: { pairs: { multiple: 2, single_filter: 2, no_lines: 2 }, studies: { mixed: 2 } } });
});

test('拒否を保存し、該当実行と要素の帰属を除く', async () => {
  const f = setup(), original = f.fetchImpl.getMockImplementation()!;
  f.fetchImpl.mockImplementation(async (input, init) => String(input).includes('esummary') ? original(input, init)
    : new Response(JSON.stringify({ esearchresult: { ERROR: '拒否 PMC123 alpha 90000001 FAKE_SECRET' } })));
  await main(f.args, f.runtime);
  expect(f.report()).toMatchObject({ exclusions: { rejectedUnits: 10, excludedRuns: 4, excludedElements: 1 },
    originalOnly: { pairs: { excluded: 6 }, studies: { incomplete: 3 } }, bundleOnly: { pairs: { excluded: 2 } } });
  f.fetchImpl.mockClear(); await main(f.args, f.runtime);
  expect(f.fetchImpl.mock.calls.every(([input]) => String(input).includes('esummary'))).toBe(true);
});

test('結果不明なら集計と読み物を書かず、機密を例外に出さない', async () => {
  const f = setup();
  f.fetchImpl.mockImplementation(async () => { throw new Error('PMC123 alpha 90000001 FAKE_SECRET'); });
  await expect(main(f.args, f.runtime)).rejects.toThrow('単位の測定に失敗しました（結果不明）');
  expect(existsSync(f.reportPath)).toBe(false); expect(existsSync(f.readingPath)).toBe(false);
  expect(f.runtime.stdout).not.toHaveBeenCalled();
});

test('不足は全対象を先に数え、通信しない', async () => {
  const f = setup();
  unlinkSync(join(f.source(1), 'submissions/1.md')); unlinkSync(join(f.source(3), 'submission.json'));
  unlinkSync(join(f.bundle(2), 'score.json'));
  await expect(main(f.args, f.runtime)).rejects.toThrow('採点記録または提出が 3 件不足しています');
  expect(f.fetchImpl).not.toHaveBeenCalled();
});

test.each(['validation', 'test'])('開発群以外を拒む: %s', async (subset) => {
  const f = setup(); f.args[3] = subset;
  await expect(main(f.args, f.runtime)).rejects.toThrow('原著式との比較は開発群でだけ実行できます');
  expect(f.fetchImpl).not.toHaveBeenCalled();
});
test('試験群の解放・不正なラベル・異なる結合形式を拒む', async () => {
  const f = setup();
  await expect(main([...f.args, '--open-test-set'], f.runtime)).rejects.toThrow('原著式との比較は開発群でだけ実行できます');
  await expect(main([...f.args.slice(0, -1), '../escape'], f.runtime)).rejects.toThrow('実行引数が不正です');
  for (const combine of [{ versions: ['v1', 'v2'] }, { from: 'v1', k: 2, blocks: { minOverlap: 0, minMargin: 0, maxConcepts: 2 } }]) {
    writeJson(join(f.runtime.harnessDir!, 'bundle/conditions.json'), { ...f.conditions, combine });
    await expect(main(f.args, f.runtime)).rejects.toThrow('束ねた版には元の版と本数だけの条件が必要です');
  }
});

test('題の失敗だけを許し、キャッシュの破損は再測定せず止める', async () => {
  const f = setup(), original = f.fetchImpl.getMockImplementation()!;
  f.fetchImpl.mockImplementation(async (input, init) => {
    if (String(input).includes('esummary')) throw new Error('題の取得失敗');
    return original(input, init);
  });
  await main(f.args, f.runtime);
  expect(readFileSync(f.readingPath, 'utf8')).toContain('題: ');
  const cache = join(f.runs, '_cache/original-diff');
  writeJson(join(cache, readdirSync(cache)[0]!), { fingerprint: '不一致' });
  f.fetchImpl.mockClear();
  await expect(main(f.args, f.runtime)).rejects.toThrow('単位のキャッシュが不正です');
  expect(f.fetchImpl).not.toHaveBeenCalled();
});
