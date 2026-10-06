/** @jest-environment node */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from './combineBlocks';
import { main as combineRuns } from './combineRuns';
import { loadConditions } from './conditions';
import { createRun, readBudget, runPath, writeJson } from './runDir';
import { readSubmissionState } from './scoreRuns';
import { splitReviews } from './split';
import type { RunRuntime } from './startRuns';
import { validateFormulaMd } from './submission';
import { fixture, record, review, writeLines } from './testFixtures';

const md = (query: string) => '## PubMed/MEDLINE\n\n```\n#1 ' + query + '\n```\n';
function setup(queries: (string | null | undefined)[] = ['a1 AND b1', 'b2 AND a2', 'a3 AND b3']) {
  const root = mkdtempSync(join(tmpdir(), 'p2f-blocks-'));
  const casesDir = join(root, 'cases'), harnessDir = join(root, 'harness'), runs = join(root, 'runs');
  const rows = Array.from({ length: 10 }, (_, i) => review(i + 1));
  fixture(root, rows);
  writeLines(join(casesDir, 'evaluable.jsonl'), rows.map((row) => record(row)));
  const selected = rows.find((row) => splitReviews(rows).get(row.pmcid) === 'development')!;
  writeJson(join(casesDir, 'subsets.json'), { smoke: [selected.pmcid], fixed: [selected.pmcid] });
  mkdirSync(join(casesDir, selected.pmcid));
  const protocolPath = join(casesDir, selected.pmcid, 'protocol.md');
  writeFileSync(protocolPath, '合成プロトコル');
  const conditions = loadConditions('v6');
  mkdirSync(join(harnessDir, 'v6'), { recursive: true });
  writeJson(join(harnessDir, 'v6', 'conditions.json'), conditions);
  const source = (i: number) => runPath(runs, 'v1', selected.pmcid, i);
  const output = (i = 1) => runPath(runs, 'v6', selected.pmcid, i);
  const runtime: RunRuntime = { casesDir, harnessDir, reportsDir: join(root, 'reports'),
    env: { COCHRANE_BENCH_DIR: root, P2F_NCBI_RPS: '100000', NCBI_API_KEY: 'FAKE_SECRET' },
    now: () => new Date('2026-01-01T00:00:00Z'), stdout: jest.fn(), stderr: jest.fn(), sleep: async () => undefined,
    fetchImpl: jest.fn(async (input) => {
      const url = new URL(String(input));
      expect(url.pathname.endsWith('/esearch.fcgi')).toBe(true);
      const params = url.searchParams, term = params.get('term')!;
      expect(params.get('retmax')).toBe('0');
      expect(params.get('datetype')).toBe('edat');
      expect(params.get('maxdate')).toBe('2020/01/31');
      const both = term.includes(') AND (');
      const same = !term.includes('a') || !term.includes('b');
      return new Response(JSON.stringify({ esearchresult: { count: String(both ? same ? 80 : 10 : 100), idlist: [] } }));
    }) };
  for (const [index, query] of queries.entries()) {
    if (query === undefined) continue;
    const dir = createRun({ root: runs, version: 'v1', pmcid: selected.pmcid, runIndex: index + 1,
      cutoffDate: selected.cutoffDate, conditions: loadConditions('v1'), protocolPath, now: runtime.now });
    if (query === null) continue;
    const text = md(query), validated = validateFormulaMd(text);
    if (!validated.ok) throw new Error('合成式が不正です');
    mkdirSync(join(dir, 'submissions'));
    writeFileSync(join(dir, 'submissions', '2.md'), text);
    writeJson(join(dir, 'submission.json'), { number: 2, query: validated.query });
  }
  const args = ['--runs', runs, '--version', 'v6', '--subset', 'smoke', '--runs-per-review', String(queries.length / 3)];
  const saved = () => JSON.parse(readFileSync(join(output(), 'combine.json'), 'utf8'));
  const report = () => JSON.parse(readFileSync(join(runtime.reportsDir!, 'combine-v6-smoke.json'), 'utf8'));
  return { root, runs, args, runtime, source, output, saved, report, conditions, selected };
}

test('三本を概念ごとに束ね、提出と集計を記録し、完了済みを上書きしない', async () => {
  const f = setup();
  expect(await main(f.args, f.runtime)).toBe(0);
  expect(f.saved()).toMatchObject({ outcome: 'merged_all', groups: [{ reference: 1, members: [
    { combinedFrom: 2, accepted: true, permutation: [1, 0] }, { combinedFrom: 3, accepted: true, permutation: [0, 1] },
  ] }] });
  expect(readFileSync(join(f.output(), 'submissions', '1.md'), 'utf8')).toContain('(((a1) OR (a2) OR (a3)) AND ((b1) OR (b2) OR (b3)))');
  expect(readBudget(f.output())).toEqual({ measurements: 0, submissions: 1 });
  expect(readSubmissionState(f.output()).submitAttempts).toBe(1);
  expect(JSON.parse(readFileSync(join(f.output(), 'submission.json'), 'utf8'))).toMatchObject({ number: 1, combinedFrom: [1, 2, 3] });
  expect(f.report()).toMatchObject({ sources: { total: 3, usable: 3 }, alignments: { attempted: 2, accepted: 2 }, outcomes: { merged_all: 1 },
    scoreQuantiles: { min: 0.8, max: 0.8 } });
  expect(f.report().marginQuantiles.median).toBeCloseTo(0.7);
  expect(JSON.stringify(f.report())).not.toMatch(/PMC|FAKE_SECRET|a1|b1/);
  expect(JSON.stringify((f.runtime.stdout as jest.Mock).mock.calls)).not.toMatch(/PMC|FAKE_SECRET|a1|b1/);
  const before = readFileSync(join(f.output(), 'combine.json'), 'utf8');
  (f.runtime.fetchImpl as jest.Mock).mockClear();
  expect(await main(f.args, f.runtime)).toBe(0);
  expect(f.runtime.fetchImpl).not.toHaveBeenCalled();
  expect(readFileSync(join(f.output(), 'combine.json'), 'utf8')).toBe(before);
  expect(f.report().outcomes.merged_all).toBe(1);
  expect(f.runtime.stdout).toHaveBeenCalledWith('既にあり飛ばした: 1 件\n');
  expect(f.runtime.stdout).toHaveBeenCalledWith('測定: 新規 0 回、キャッシュ 0 回\n');
});
test('署名の違う一本は完成式のまま残す', async () => {
  const f = setup(['a1 AND b1', 'a2 AND b2', 'a3 AND b3 AND english[la]']);
  await main(f.args, f.runtime);
  expect(f.saved().outcome).toBe('merged_partial');
  expect(readFileSync(join(f.output(), 'submissions', '1.md'), 'utf8')).toContain(' OR (a3 AND b3 AND english[la])');
});
test('二つ以上のグループに束ねたときも一部と数える', async () => {
  const f = setup(['a1', 'a2', 'a3 AND english[la]']);
  f.conditions.combine = { from: 'v1', k: 6, blocks: { minOverlap: 0.3, minMargin: 0.1, maxConcepts: 3 } };
  writeJson(join(f.runtime.harnessDir!, 'v6', 'conditions.json'), f.conditions);
  for (let i = 4; i <= 6; i++) {
    const dir = f.source(i);
    mkdirSync(join(dir, 'submissions'), { recursive: true });
    writeFileSync(join(dir, 'run.json'), readFileSync(join(f.source(3), 'run.json')));
    writeFileSync(join(dir, 'submissions', '2.md'), readFileSync(join(f.source(3), 'submissions', '2.md')));
    writeFileSync(join(dir, 'submission.json'), readFileSync(join(f.source(3), 'submission.json')));
  }
  await main(f.args, f.runtime);
  expect(f.saved().outcome).toBe('merged_partial');
  expect(f.saved().groups).toHaveLength(2);
});
test('全て異なる署名では従来と同じ完成式の和になる', async () => {
  const f = setup(['a1', 'a2 AND b2', 'a3 AND b3 AND english[la]']);
  await main(f.args, f.runtime);
  expect(f.saved().outcome).toBe('formula_or');
  expect(f.runtime.fetchImpl).not.toHaveBeenCalled();
  const old = { ...f.conditions, version: 'old', combine: { from: 'v1', k: 3 } };
  mkdirSync(join(f.runtime.harnessDir!, 'old'));
  writeJson(join(f.runtime.harnessDir!, 'old', 'conditions.json'), old);
  combineRuns(f.args.map((arg) => arg === 'v6' ? 'old' : arg), f.runtime);
  expect(readFileSync(join(f.output(), 'submissions', '1.md'), 'utf8')).toBe(
    readFileSync(join(runPath(f.runs, 'old', f.selected.pmcid, 1), 'submissions', '1.md'), 'utf8'));
});
test('全て未提出ならフォルダと完了記録だけを作る', async () => {
  const f = setup([null, null, null]);
  await main(f.args, f.runtime);
  expect(f.saved().outcome).toBe('no_submission');
  expect(f.report().sources.total).toBe(0);
  expect(readSubmissionState(f.output()).submission).toBeNull();
  expect(readBudget(f.output())).toEqual({ measurements: 0, submissions: 0 });
  expect(f.runtime.fetchImpl).not.toHaveBeenCalled();
});
test.each(['相手', '基準', '積集合'])('%sの式が拒否された場合だけ完成式に戻す', async (side) => {
  const f = setup();
  const normal = f.runtime.fetchImpl;
  f.runtime.fetchImpl = jest.fn(async (input, init) => {
    const term = new URL(String(input)).searchParams.get('term')!;
    const rejected = side === '基準' ? term === '(a1)' : side === '相手' ? term === '(b2)' : term === '(a1) AND (b2)';
    return rejected ? new Response(JSON.stringify({ esearchresult: { ERROR: 'PMC123 a1 FAKE_SECRET' } })) : normal(input, init);
  });
  await main(f.args, f.runtime);
  expect(f.saved().outcome).toBe(side === '基準' ? 'formula_or' : 'merged_partial');
  expect(f.saved().groups[0].members[0]).toMatchObject({ accepted: false, rejectedReason: 'query_rejected', score: null });
  expect(f.report().alignments.rejected.query_rejected).toBe(side === '基準' ? 2 : 1);
  expect(JSON.stringify(f.saved())).not.toMatch(/PMC|FAKE_SECRET|a1/);
});
test('通信失敗では成果物を作らず、成功した測定だけを再開で再利用する', async () => {
  const f = setup();
  const normal = f.runtime.fetchImpl;
  f.runtime.fetchImpl = jest.fn(async (input, init) => {
    if (new URL(String(input)).searchParams.get('term') === '(b1)') throw new Error('PMC123 a1 FAKE_SECRET');
    return normal(input, init);
  });
  await expect(main(f.args, f.runtime)).rejects.toThrow('件数の測定に失敗しました（結果不明）');
  expect(existsSync(f.output())).toBe(false);
  const key = createHash('sha256').update(f.selected.cutoffDate + '\n(a1)').digest('hex');
  const cached = join(f.runs, '_cache', 'counts', key + '.json');
  expect(JSON.parse(readFileSync(cached, 'utf8'))).toEqual({ count: 100, measuredAt: f.runtime.now().toISOString() });
  (normal as jest.Mock).mockClear();
  f.runtime.fetchImpl = normal;
  await main(f.args, f.runtime);
  expect((normal as jest.Mock).mock.calls.some(([input]) => new URL(String(input)).searchParams.get('term') === '(a1)')).toBe(false);
  expect(f.saved().outcome).toBe('merged_all');
});
test('別の出力版でも件数キャッシュだけで完了できる', async () => {
  const f = setup();
  await main(f.args, f.runtime);
  mkdirSync(join(f.runtime.harnessDir!, 'retry'));
  writeJson(join(f.runtime.harnessDir!, 'retry', 'conditions.json'), { ...f.conditions, version: 'retry' });
  (f.runtime.fetchImpl as jest.Mock).mockClear();
  await main(f.args.map((arg) => arg === 'v6' ? 'retry' : arg), f.runtime);
  expect(f.runtime.fetchImpl).not.toHaveBeenCalled();
  expect(f.runtime.stdout).toHaveBeenCalledWith('測定: 新規 0 回、キャッシュ 14 回\n');
});
test('後半の不足と作りかけを全成果物の作成前に検出する', async () => {
  const missing = setup(['a1', 'a2', 'a3', null, null, undefined]);
  await expect(main(missing.args, missing.runtime)).rejects.toThrow('元の実行フォルダが 1 件不足しています');
  expect(existsSync(missing.output())).toBe(false);
  const f = setup(['a1', 'a2', 'a3', null, null, null]);
  mkdirSync(f.output(2), { recursive: true });
  await expect(main(f.args, f.runtime)).rejects.toThrow('束ねた版の実行フォルダが 1 件、作りかけで残っています');
  expect(existsSync(f.output())).toBe(false);
  expect(f.runtime.fetchImpl).not.toHaveBeenCalled();
});
test('読めない提出ファイルと検査不合格は完成式で扱う', async () => {
  const f = setup();
  unlinkSync(join(f.source(1), 'submissions', '2.md'));
  writeFileSync(join(f.source(2), 'submissions', '2.md'), '不正');
  writeFileSync(join(f.source(3), 'submissions', '2.md'), md('different'));
  await main(f.args, f.runtime);
  expect(f.saved().outcome).toBe('formula_or');
  expect(f.report().sources).toMatchObject({ total: 3, usable: 0, reasons: { invalid: 2, query_mismatch: 1 } });
  expect(f.runtime.fetchImpl).not.toHaveBeenCalled();
});
test.each([0, 40])('閾値に達しない行列の不採用理由を集計する: %i', async (intersection) => {
  const f = setup();
  f.runtime.fetchImpl = jest.fn(async (input) => new Response(JSON.stringify({ esearchresult: {
    count: String(new URL(String(input)).searchParams.get('term')!.includes(') AND (') ? intersection : 100),
  } })));
  await main(f.args, f.runtime);
  expect(f.saved().outcome).toBe('formula_or');
  expect(f.report().alignments.rejected[intersection === 0 ? 'below_min_overlap' : 'below_min_margin']).toBe(2);
});
test.each([undefined, { from: 'v1', k: 3 }, { versions: ['v1', 'v2'] }])('概念の条件がない版を拒否する: %j', async (combine) => {
  const f = setup();
  writeJson(join(f.runtime.harnessDir!, 'v6', 'conditions.json'), { ...f.conditions, combine });
  await expect(main(f.args, f.runtime)).rejects.toThrow('概念ごとに束ねる条件がありません');
  expect(existsSync(f.output())).toBe(false);
});
