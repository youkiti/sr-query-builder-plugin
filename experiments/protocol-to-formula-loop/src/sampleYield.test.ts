/** @jest-environment node */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installDomParser } from '../../query-optimization-bench/domParser';
import { loadConditions } from './conditions';
import { createRun, runPath, writeJson } from './runDir';
import { main } from './sampleYield';
import { readSubmissionState } from './scoreRuns';
import { splitReviews } from './split';
import type { RunRuntime } from './startRuns';
import { validateFormulaMd } from './submission';
import { fixture, review, writeLines } from './testFixtures';

installDomParser();
const gold = ['90000001', '90000002', '90000003'];
const md = (expression: string) => '## PubMed/MEDLINE\n\n```\n#1 ' + expression + '\n```\n';
function setup(expression = 'alpha[tiab] AND beta[Mesh]') {
  const root = mkdtempSync(join(tmpdir(), 'p2f-samples-'));
  const casesDir = join(root, 'cases'), harnessDir = join(root, 'harness'), runs = join(root, 'runs');
  const rows = Array.from({ length: 10 }, (_, i) => review(i + 1));
  fixture(root, rows);
  writeLines(join(root, 'data/processed/cc-by/gold/task2_search_screen.jsonl'), rows.map((row) => ({
    pmcid: row.pmcid, included_pmids: gold, pmid_to_study_id: {},
  })));
  writeLines(join(casesDir, 'evaluable.jsonl'), rows.map((row) => ({ pmcid: row.pmcid,
    cutoffDate: row.cutoffDate, existing: gold, withinCutoff: gold, measuredAt: '2026-01-01T00:00:00Z' })));
  const selected = rows.find((row) => splitReviews(rows).get(row.pmcid) === 'development')!;
  writeJson(join(casesDir, 'subsets.json'), { smoke: [selected.pmcid], fixed: [selected.pmcid] });
  const protocolPath = join(root, 'protocol.md');
  writeFileSync(protocolPath, '合成プロトコル');
  const conditions = { ...loadConditions('v1'), version: 'bundle', combine: { from: 'v1', k: 3 } };
  mkdirSync(join(harnessDir, 'bundle'), { recursive: true });
  writeJson(join(harnessDir, 'bundle', 'conditions.json'), conditions);
  const source = (i = 1) => runPath(runs, 'v1', selected.pmcid, i);
  const bundle = (i = 1) => runPath(runs, 'bundle', selected.pmcid, i);
  const create = (version: string, runIndex: number, query: string) => {
    const dir = createRun({ root: runs, version, pmcid: selected.pmcid, runIndex, cutoffDate: selected.cutoffDate,
      conditions: version === 'v1' ? loadConditions('v1') : conditions, protocolPath, now: () => new Date('2026-01-01') });
    const text = md(query), validated = validateFormulaMd(text);
    if (!validated.ok) throw new Error('合成式が不正です');
    mkdirSync(join(dir, 'submissions'));
    writeFileSync(join(dir, 'submissions', '1.md'), text);
    writeJson(join(dir, 'submission.json'), { number: 1, query: validated.query });
    const state = readSubmissionState(dir);
    writeJson(join(dir, 'score.json'), { status: 'scored', submission: state.fingerprint, submitAttempts: state.submitAttempts,
      outcome: { status: 'measured', capturedPmids: [gold[2]] } });
  };
  create('v1', 1, expression); create('bundle', 1, 'bundled[tiab]');
  const pool = Array.from({ length: 200 }, (_, i) => i === 199 ? gold[0]! : String(80000001 + i));
  const fetchImpl = jest.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input)), params = init?.method === 'POST' ? new URLSearchParams(String(init.body)) : url.searchParams;
    if (url.pathname.endsWith('/efetch.fcgi')) {
      const ids = params.get('id')!.split(',');
      expect(ids.length).toBeLessThanOrEqual(100);
      return new Response('<PubmedArticleSet>' + [...ids].reverse().map((id) => `<PubmedArticle><MedlineCitation><PMID>${id}</PMID><MeshHeadingList>
        <MeshHeading><DescriptorName MajorTopicYN="Y">${id === gold[0] || id === gold[1] ? id : 'common'}</DescriptorName></MeshHeading>
        <MeshHeading><DescriptorName MajorTopicYN="N">${id}</DescriptorName><QualifierName MajorTopicYN="Y">other</QualifierName></MeshHeading>
        </MeshHeadingList></MedlineCitation></PubmedArticle>`).join('') + '</PubmedArticleSet>');
    }
    expect(url.pathname.endsWith('/esearch.fcgi')).toBe(true);
    expect(params.get('maxdate')).toBe('2020/01/31');
    expect(params.get('datetype')).toBe('edat');
    const term = params.get('term')!, capture = term.includes('[uid]'), beyond = term.includes('bundled');
    const current = !term.includes('[majr]') && !term.includes('[ti]');
    if (!capture) expect(params.get('sort')).toBe('relevance');
    const ids = capture ? (beyond ? [gold[1]!] : [gold[0]!, gold[1]!])
      : beyond ? [gold[1]!] : current ? [gold[1]!, ...pool.slice(0, 14)] : pool;
    return new Response(JSON.stringify({ esearchresult: { count: String(capture ? ids.length : beyond ? 1 : current ? 500 : 200), idlist: ids } }));
  });
  const runtime: RunRuntime = { casesDir, harnessDir, reportsDir: join(root, 'reports'),
    env: { COCHRANE_BENCH_DIR: root, NCBI_API_KEY: 'FAKE_SECRET' }, fetchImpl,
    rateLimiter: { acquire: async () => undefined }, sleep: async () => undefined,
    now: () => new Date('2026-01-01'), stdout: jest.fn(), stderr: jest.fn() };
  const args = ['--runs', runs, '--source', 'v1', '--bundle', 'bundle', '--subset', 'smoke', '--runs-per-review', '1'];
  const reportPath = join(runtime.reportsDir!, 'sample-yield-v1-bundle-smoke.json');
  const report = () => JSON.parse(readFileSync(reportPath, 'utf8'));
  const cacheDir = join(runs, '_cache/sample-yield/v1-bundle', selected.pmcid, 'run-1');
  return { args, runtime, fetchImpl, source, bundle, create, report, reportPath, cacheDir, conditions, selected };
}

test('四手法の件数・分母・四分位を集計し、再開時には通信しない', async () => {
  const f = setup();
  expect(await main(f.args, f.runtime)).toBe(0);
  expect(f.report()).toMatchObject({ targets: 2, runs: 1, missedGold: 2, skippedRuns: { undetermined: 0 }, rejectedTargets: 0,
    methods: {
      current: { samples: 2, sampleGoldTotal: 2, sampleSizeTotal: 30, precision: 2 / 30, targetsWithGold: 2,
        targetsWithGoldRate: 1, reviewsWithGold: 1, poolGoldTotal: 4, poolGoldPerMissed: 2,
        poolHitsQuantiles: { min: 500, q1: 500, median: 500, q3: 500, max: 500 } },
      narrowed: { sampleGoldTotal: 0, sampleSizeTotal: 30, targetsWithGoldRate: 0, reviewsWithGold: 0, poolGoldTotal: 4 },
      narrowed_diverse: { sampleGoldTotal: 2, sampleSizeTotal: 30, reviewsWithGold: 1, poolGoldTotal: 4 },
      beyond_bundle_diverse: { sampleGoldTotal: 2, sampleSizeTotal: 2, precision: 1, poolGoldTotal: 2 },
    } });
  const output = readFileSync(f.reportPath, 'utf8') + JSON.stringify((f.runtime.stdout as jest.Mock).mock.calls);
  expect(output).not.toMatch(/PMC|9000000|8000000|FAKE_SECRET|alpha|beta|bundled/);
  expect(readFileSync(join(f.cacheDir, 'inline-1.json'), 'utf8')).not.toMatch(/9000000|8000000|alpha|beta/);
  expect(f.fetchImpl.mock.calls.filter(([input]) => String(input).includes('efetch'))).toHaveLength(6);
  f.fetchImpl.mockClear();
  await main(f.args, f.runtime);
  expect(f.fetchImpl).not.toHaveBeenCalled();
  expect(f.runtime.stdout).toHaveBeenCalledWith('測った対象: 新規 0 件、保存済み 2 件、測り直し 0 件\n');
});

test('拒否された対象も保存し、集計の分母から除く', async () => {
  const f = setup();
  f.fetchImpl.mockImplementation(async () => new Response(JSON.stringify({ esearchresult: { ERROR: '拒否 alpha PMC123 90000001 FAKE_SECRET' } })));
  await main(f.args, f.runtime);
  expect(f.report()).toMatchObject({ targets: 0, rejectedTargets: 2, missedGold: 0,
    methods: { current: { precision: null, targetsWithGoldRate: null, poolGoldPerMissed: null, poolHitsQuantiles: { min: null } } } });
  f.fetchImpl.mockClear();
  await main(f.args, f.runtime);
  expect(f.fetchImpl).not.toHaveBeenCalled();
});

test('論文の記録が返らない PMID は書籍の記録を確認して MeSH なしとして数える', async () => {
  const f = setup(), original = f.fetchImpl.getMockImplementation()!;
  f.fetchImpl.mockImplementation(async (input, init) => {
    const response = await original(input, init);
    if (!String(input).includes('efetch')) return response;
    // 80000001 だけを、書籍の章として返す。
    return new Response((await response.text()).replace(/<PubmedArticle><MedlineCitation><PMID>80000001<\/PMID>[\s\S]*?<\/PubmedArticle>/,
      '<PubmedBookArticle><BookDocument><PMID>80000001</PMID></BookDocument></PubmedBookArticle>'));
  });
  expect(await main(f.args, f.runtime)).toBe(0);
  expect(f.report()).toMatchObject({ targets: 2, methods: { narrowed_diverse: { sampleSizeTotal: 30, sampleGoldTotal: 2 } } });
  // 欠けた 1 件の取り直しが、絞り込みの 2 対象で 1 回ずつ増える。
  expect(f.fetchImpl.mock.calls.filter(([input]) => String(input).includes('efetch'))).toHaveLength(8);
});

test.each(['通信', '書誌欠落', '検索欠落'])('失敗（%s）は結果不明として停止し、集計しない', async (failure) => {
  const f = setup(), original = f.fetchImpl.getMockImplementation()!;
  f.fetchImpl.mockImplementation(async (input, init) => {
    if (failure === '通信') throw new Error('PMC123 alpha[tiab] 90000001 FAKE_SECRET');
    if (failure === '書誌欠落' && String(input).includes('efetch')) return new Response('<PubmedArticleSet/>');
    if (failure === '検索欠落') return new Response(JSON.stringify({ esearchresult: { count: '200', idlist: [] } }));
    return original(input, init);
  });
  const error = await main(f.args, f.runtime).catch((value: Error) => value);
  expect(String(error)).toContain('見本の測定に失敗しました（結果不明）:');
  expect(String(error)).not.toMatch(/PMC|90000001|FAKE_SECRET|alpha/);
  expect(existsSync(f.reportPath)).toBe(false);
});

test.each(['validation', 'test'])('開発群以外（%s）を受け付けない', async (subset) => {
  const f = setup();
  await expect(main(f.args.map((value) => value === 'smoke' ? subset : value), f.runtime)).rejects.toThrow('見本の下調べは開発群でだけ実行できます');
  expect(f.fetchImpl).not.toHaveBeenCalled();
});
test('試験群を開く引数と元の版が異なる条件を拒否する', async () => {
  const f = setup();
  await expect(main([...f.args, '--open-test-set'], f.runtime)).rejects.toThrow('実行引数が不正です');
  writeJson(join(f.runtime.harnessDir!, 'bundle/conditions.json'), { ...f.conditions, combine: { from: 'v2', k: 3 } });
  await expect(main(f.args, f.runtime)).rejects.toThrow('束ねた版の条件が元の版と一致しません');
  expect(f.fetchImpl).not.toHaveBeenCalled();
});
test.each(['提出', '採点なし', '未測定'])('不足（%s）を通信前に全体検査する', async (missing) => {
  const f = setup();
  if (missing === '提出') unlinkSync(join(f.bundle(), 'submission.json'));
  if (missing === '採点なし') unlinkSync(join(f.source(), 'score.json'));
  if (missing === '未測定') writeJson(join(f.source(), 'score.json'), { outcome: { status: 'measurement_failed' } });
  f.args[f.args.length - 1] = '2';
  await expect(main(f.args, f.runtime)).rejects.toThrow('実行フォルダまたは提出が 3 件不足しています');
  expect(f.fetchImpl).not.toHaveBeenCalled();
});
test('次の束では元の四回目を選ぶ', async () => {
  const f = setup();
  f.create('v1', 4, 'alpha[tiab] AND beta[Mesh]'); f.create('bundle', 2, 'bundled[tiab]');
  f.args[f.args.length - 1] = '2';
  await main(f.args, f.runtime);
  expect(f.report()).toMatchObject({ targets: 4, runs: 2, missedGold: 4, methods: { current: { reviewsWithGold: 1 } } });
});
test.each([['alpha OR beta', 1, 0], ['alpha AND trial[pt]', 0, 1]] as const)('対象外を区分する（%s）', async (expression, runs, targets) => {
  const f = setup(expression);
  await main(f.args, f.runtime);
  expect(f.report()).toMatchObject({ targets: 0, skippedRuns: { undetermined: runs }, skippedTargets: targets });
  expect(f.fetchImpl).not.toHaveBeenCalled();
});
test('ゼロ件の集合では正解照合も書誌取得も呼ばない', async () => {
  const f = setup();
  f.fetchImpl.mockImplementation(async () => new Response(JSON.stringify({ esearchresult: { count: '0', idlist: [] } })));
  await main(f.args, f.runtime);
  expect(f.fetchImpl).toHaveBeenCalledTimes(6);
  expect(f.report().methods.current).toMatchObject({ samples: 0, precision: null, poolGoldTotal: 0 });
});
test('ファイルの失敗はパスや内容を含まない固定文言にする', async () => {
  const f = setup();
  writeFileSync(join(f.source(), 'score.json'), 'PMC123 FAKE_SECRET');
  await expect(main(f.args, f.runtime)).rejects.toThrow('見本の下調べのファイルの読み書きに失敗しました');
});

test('後続の実行で採点後に提出が変わった場合も通信前に不足として止める', async () => {
  const f = setup();
  f.create('v1', 4, 'alpha[tiab] AND beta[Mesh]'); f.create('bundle', 2, 'bundled[tiab]');
  writeJson(join(f.source(4), 'submission.json'), { number: 1, query: 'changed[tiab]' });
  f.args[f.args.length - 1] = '2';
  await expect(main(f.args, f.runtime)).rejects.toThrow('実行フォルダまたは提出が 1 件不足しています');
  expect(f.fetchImpl).not.toHaveBeenCalled();
});

test.each(['束の式', '古い形式'])('キャッシュの入力が異なる場合（%s）は測り直して上書きする', async (change) => {
  const f = setup();
  await main(f.args, f.runtime);
  const path = join(f.cacheDir, 'inline-1.json');
  const before = JSON.parse(readFileSync(path, 'utf8'));
  expect(before.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  if (change === '束の式') writeJson(join(f.bundle(), 'submission.json'), { number: 1, query: 'bundled_changed[tiab]' });
  else {
    for (const id of ['inline-1', 'inline-2']) {
      const cachePath = join(f.cacheDir, `${id}.json`), saved = JSON.parse(readFileSync(cachePath, 'utf8'));
      delete saved.fingerprint; delete saved.measuredAt;
      writeJson(cachePath, saved);
    }
  }
  f.fetchImpl.mockClear();
  f.runtime.now = () => new Date('2026-02-01');
  await main(f.args, f.runtime);
  expect(f.fetchImpl).toHaveBeenCalled();
  expect(f.runtime.stdout).toHaveBeenCalledWith('測った対象: 新規 0 件、保存済み 0 件、測り直し 2 件\n');
  const after = JSON.parse(readFileSync(path, 'utf8'));
  expect(after.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  if (change === '束の式') expect(after.fingerprint).not.toBe(before.fingerprint);
  expect(after.measuredAt).toBe('2026-02-01T00:00:00.000Z');
});

test.each([
  '<PubmedArticleSet/>',
  '<eFetchResult><ERROR>PMC123 alpha 90000002 FAKE_SECRET</ERROR></eFetchResult>',
  '<PubmedArticleSet><PubmedBookArticle><BookDocument><ReferenceList><PMID>90000002</PMID></ReferenceList></BookDocument></PubmedBookArticle></PubmedArticleSet>',
  '<PubmedArticleSet><PubmedBookArticle><BookDocument><PMID>99999999</PMID></BookDocument></PubmedBookArticle></PubmedArticleSet>',
])('最後の一件でも書籍の記録が確認できない応答（%s）は結果不明で止める', async (xml) => {
  const f = setup(), original = f.fetchImpl.getMockImplementation()!;
  f.fetchImpl.mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/efetch.fcgi') && url.searchParams.get('id') === gold[1]) return new Response(xml);
    return original(input, init);
  });
  await expect(main(f.args, f.runtime)).rejects.toThrow('見本の測定に失敗しました（結果不明）: 書誌の取得件数が一致しません');
  expect(existsSync(f.reportPath)).toBe(false);
});

test('測定日時の範囲には拒否された対象と再利用したキャッシュを含める', async () => {
  const f = setup(), original = f.fetchImpl.getMockImplementation()!;
  f.fetchImpl.mockImplementationOnce(async () => new Response(JSON.stringify({ esearchresult: { ERROR: '拒否' } })));
  f.runtime.now = jest.fn().mockReturnValueOnce(new Date('2026-02-01')).mockReturnValueOnce(new Date('2026-01-01'))
    .mockReturnValue(new Date('2026-03-01'));
  await main(f.args, f.runtime);
  expect(f.report()).toMatchObject({ targets: 1, runs: 1, rejectedTargets: 1, missedGold: 2,
    measuredFrom: '2026-01-01T00:00:00.000Z', measuredTo: '2026-02-01T00:00:00.000Z' });
  expect(JSON.parse(readFileSync(join(f.cacheDir, 'inline-1.json'), 'utf8'))).toMatchObject({
    status: 'rejected', fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/), measuredAt: '2026-02-01T00:00:00.000Z',
  });
  f.fetchImpl.mockClear();
  await main(f.args, f.runtime);
  expect(f.fetchImpl).not.toHaveBeenCalled();
  expect(f.report()).toMatchObject({ measuredFrom: '2026-01-01T00:00:00.000Z', measuredTo: '2026-02-01T00:00:00.000Z' });
  writeJson(join(f.bundle(), 'submission.json'), { number: 1, query: 'bundled_changed[tiab]' });
  f.fetchImpl.mockImplementation(original);
  await main(f.args, f.runtime);
  expect(f.report()).toMatchObject({ targets: 2, rejectedTargets: 0,
    measuredFrom: '2026-03-01T00:00:00.000Z', measuredTo: '2026-03-01T00:00:00.000Z' });
});

test('対象がない場合は実行数と未捕捉数をゼロ、測定日時を未設定にする', async () => {
  const f = setup('alpha OR beta');
  await main(f.args, f.runtime);
  expect(f.report()).toMatchObject({ targets: 0, runs: 0, missedGold: 0, measuredFrom: null, measuredTo: null });
});
