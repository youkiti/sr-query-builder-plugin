/** @jest-environment node */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BenchReview } from './bench';
import { main } from './overlap';
import type { SubmissionOutcome } from './metrics';
import { runPath } from './runDir';
import { readSubmissionState } from './scoreRuns';
import { splitReviews } from './split';
import type { RunRuntime } from './startRuns';
import { fixture, pmids, record, review, writeJson, writeLines } from './testFixtures';

const [a, b, c, d] = pmids as [string, string, string, string];
const query = '合成の検索式と秘密キー';

function setup(subset = 'smoke') {
  const root = mkdtempSync(join(tmpdir(), 'p2f-overlap-'));
  const rows: BenchReview[] = Array.from({ length: 20 }, (_, i) => ({ ...review(i + 1), tier: i < 10 ? 'cc-by' : 'cc-by-nc' }));
  fixture(root, rows);
  const splits = splitReviews(rows);
  const selected = subset === 'smoke'
    ? ['cc-by', 'cc-by-nc'].map((tier) => rows.find((row) => row.tier === tier && splits.get(row.pmcid) === 'development')!)
    : rows.filter((row) => splits.get(row.pmcid) === subset);
  const runtime: RunRuntime = { env: { COCHRANE_BENCH_DIR: root, NCBI_API_KEY: query }, casesDir: join(root, 'cases'),
    reportsDir: join(root, 'reports'), fetchImpl: jest.fn(), now: () => new Date('2026-01-01'), stdout: jest.fn(), stderr: jest.fn() };
  writeLines(join(runtime.casesDir!, 'evaluable.jsonl'), rows.map((row) => ({ ...record(row),
    withinCutoff: row.pmcid === selected[1]?.pmcid ? [b, c] : [...pmids] })));
  writeJson(join(runtime.casesDir!, 'subsets.json'), { smoke: selected.map((row) => row.pmcid), fixed: selected.map((row) => row.pmcid) });
  const dir = (version: string, i = 0, run = 1) => runPath(root, version, selected[i]!.pmcid, run);
  const save = (version: string, captured: string[], i = 0, run = 1, outcome?: SubmissionOutcome) => {
    const path = dir(version, i, run);
    writeJson(join(path, 'submission.json'), { number: 1, query });
    writeLines(join(path, 'tool-log.jsonl'), [{ command: 'submit' }]);
    const state = readSubmissionState(path);
    writeJson(join(path, 'score.json'), { status: 'scored', submission: state.fingerprint, submitAttempts: state.submitAttempts,
      outcome: outcome ?? { status: 'measured', hits: 100, capturedPmids: captured }, measuredAt: '2026-01-01' });
  };
  for (let i = 0; i < selected.length; i++) {
    save('single', [a], i); save('single', [b], i, 2); save('single', i === 1 ? [b, c] : [c], i, 3);
    save('bundle', i === 1 ? [a] : [b, c], i); save('bundle', i === 1 ? [c] : [a, c, d], i, 2);
    for (let run = 1; run <= 3; run++) save('other-single', i === 1 ? [b] : [d], i, run);
    save('other-bundle', i === 1 ? [b] : [a], i); save('other-bundle', i === 1 ? [b] : [], i, 2);
  }
  const args = ['--runs', root, '--subset', subset, '--single', 'single', '--single-runs', '3', '--bundle', 'bundle', '--bundle-runs', '2'];
  const reportPath = join(runtime.reportsDir!, `overlap-bundle-${subset}.json`);
  const read = () => JSON.parse(readFileSync(reportPath, 'utf8'));
  return { root, rows, selected, runtime, dir, save, args, reportPath, read };
}

test('研究単位の四分表を回ごとに平均し、レビュー間の平均再現率とティア別集計を出す', () => {
  const s = setup();
  expect(main(s.args, s.runtime)).toBe(0);
  const report = s.read();
  expect(report).toMatchObject({ reviews: 2, studies: 6, subset: 'smoke', single: 'single', singleRuns: 3,
    bundle: 'bundle', bundleRuns: 2, otherSingle: null, otherBundle: null, generatedAt: '2026-01-01T00:00:00.000Z', otherModel: null });
  expect(report.originalVsBundle).toEqual({ both: 1.5, originalOnly: 0.5, bundleOnly: 2, neither: 2,
    reviewsOriginalOnly: 0.5, reviewsBundleOnly: 1.5, reviewsNeither: 1.5,
    reviewsAllByOriginal: 0, reviewsAllByBundle: 0.5, reviewsAllByUnion: 0.5,
    originalStudyRecall: 0.25, bundleStudyRecall: 0.5, unionStudyRecall: 0.5625 });
  expect(report.tiers['cc-by'].originalVsBundle).toEqual({ both: 1.5, originalOnly: 0.5, bundleOnly: 1.5, neither: 0.5,
    reviewsOriginalOnly: 0.5, reviewsBundleOnly: 1, reviewsNeither: 0.5,
    reviewsAllByOriginal: 0, reviewsAllByBundle: 0.5, reviewsAllByUnion: 0.5,
    originalStudyRecall: 0.5, bundleStudyRecall: 0.75, unionStudyRecall: 0.875 });
  expect(report.tiers['cc-by-nc'].originalVsBundle).toMatchObject({ both: 0, originalOnly: 0, bundleOnly: 0.5,
    neither: 1.5, originalStudyRecall: 0, bundleStudyRecall: 0.25, unionStudyRecall: 0.25 });
  const output = (s.runtime.stdout as jest.Mock).mock.calls.map((call) => call[0]).join('');
  expect(output).toBe('対象のレビュー: 2 件\n研究: 6 個\n');
  const text = output + readFileSync(s.reportPath, 'utf8');
  for (const secret of [...pmids, ...s.rows.flatMap((row) => [row.pmcid, ...row.studies.map((study) => study.id)]), query]) {
    expect(text).not.toContain(secret);
  }
  expect(s.runtime.fetchImpl).not.toHaveBeenCalled();
});

test('単独の式の捕捉本数を原著の捕捉別に数え、各配列の合計は研究数になる', () => {
  const s = setup(); main(s.args, s.runtime);
  const report = s.read();
  expect(report.singleCaptureCounts).toEqual({ studiesByCaptureCount: [1, 3, 2, 0],
    byOriginal: { captured: [0, 1, 1, 0], missed: [1, 2, 1, 0] } });
  expect(report.tiers['cc-by'].singleCaptureCounts).toEqual({ studiesByCaptureCount: [1, 2, 1, 0],
    byOriginal: { captured: [0, 1, 1, 0], missed: [1, 1, 0, 0] } });
  for (const summary of [report, ...Object.values(report.tiers)] as typeof report[]) {
    const { studiesByCaptureCount, byOriginal } = summary.singleCaptureCounts;
    expect(studiesByCaptureCount.reduce((sum: number, n: number) => sum + n, 0)).toBe(summary.studies);
    expect(studiesByCaptureCount).toEqual(byOriginal.captured.map((n: number, i: number) => n + byOriginal.missed[i]));
  }
});

test('別モデルの単独式は全回の和集合、束ねた式は同じ回同士で比較する', () => {
  const s = setup(); main([...s.args, '--other-single', 'other-single', '--other-bundle', 'other-bundle'], s.runtime);
  const report = s.read();
  expect(report.otherModel.single).toEqual({ both: 1, singleOnly: 4, otherOnly: 1, neither: 0 });
  expect(report.otherModel.bundle).toEqual({ both: 0.5, bundleOnly: 3, otherOnly: 1.5, neither: 1,
    reviewsBundleOnly: 1.5, reviewsOtherOnly: 1.5, reviewsNeither: 1,
    reviewsAllByBundle: 0.5, reviewsAllByOther: 0, reviewsAllByUnion: 1,
    bundleStudyRecall: 0.5, otherStudyRecall: 0.375, unionStudyRecall: 0.8125 });
  expect(report.tiers['cc-by-nc'].otherModel.single).toEqual({ both: 1, singleOnly: 1, otherOnly: 0, neither: 0 });
  expect(s.runtime.fetchImpl).not.toHaveBeenCalled();
});

test('原著の全捕捉と和集合だけの全捕捉も数える', () => {
  const s = setup();
  writeLines(join(s.runtime.casesDir!, 'evaluable.jsonl'), s.rows.map((row) => ({ ...record(row), withinCutoff: [a, b] })));
  s.save('bundle', [b]); s.save('bundle', [b], 0, 2);
  main(s.args, s.runtime);
  expect(s.read().originalVsBundle).toMatchObject({ reviewsAllByOriginal: 2, reviewsAllByUnion: 2, originalStudyRecall: 1 });
  expect(s.read().tiers['cc-by'].originalVsBundle).toMatchObject({ reviewsAllByBundle: 0, unionStudyRecall: 1 });
});

test.each(['no_submission', 'invalid_submission'] as const)('提出の失敗を空の捕捉として数える: %s', (status) => {
  const s = setup();
  s.save('bundle', [], 0, 2, status === 'no_submission' ? { status } : { status, reason: query });
  const dir = s.dir('bundle', 0, 2);
  unlinkSync(join(dir, 'submission.json'));
  if (status === 'no_submission') unlinkSync(join(dir, 'tool-log.jsonl'));
  const state = readSubmissionState(dir);
  const path = join(dir, 'score.json');
  writeJson(path, { ...JSON.parse(readFileSync(path, 'utf8')), submission: state.fingerprint, submitAttempts: state.submitAttempts });
  main(s.args, s.runtime);
  expect(s.read().tiers['cc-by'].originalVsBundle).toMatchObject({ both: 0.5, originalOnly: 1.5, bundleOnly: 0.5, neither: 1.5,
    bundleStudyRecall: 0.25, unionStudyRecall: 0.625 });
  expect(readFileSync(s.reportPath, 'utf8')).not.toContain(query);
});

test.each(['不足', '提出変更', '提出番号', '提出回数', '未採点', '未測定', '不明な結果', '結果なし', '捕捉集合不正', '壊れた記録', 'JSON不正'])('不足を全実行で数え、集計も標準出力も書かない: %s', (kind) => {
  const s = setup();
  for (const [version, i, run] of [['single', 0, 3], ['bundle', 1, 2]] as const) {
    const dir = s.dir(version, i, run), path = join(dir, 'score.json');
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    if (kind === '不足') unlinkSync(path);
    else if (kind === '提出変更') writeJson(join(dir, 'submission.json'), { number: 1, query: '変更した秘密の式' });
    else if (kind === 'JSON不正') writeFileSync(path, query);
    else {
      if (kind === '提出番号') saved.submission.number++;
      if (kind === '提出回数') saved.submitAttempts++;
      if (kind === '未採点') saved.status = 'unknown';
      if (kind === '未測定') saved.outcome.status = 'measurement_failed';
      if (kind === '不明な結果') saved.outcome.status = query;
      if (kind === '結果なし') delete saved.outcome;
      if (kind === '捕捉集合不正') saved.outcome.capturedPmids = [null];
      writeJson(path, kind === '壊れた記録' ? null : saved);
    }
  }
  expect(() => main(s.args, s.runtime)).toThrow(/^採点記録が 2 件不足しています$/);
  expect(existsSync(s.runtime.reportsDir!)).toBe(false);
  expect(s.runtime.stdout).not.toHaveBeenCalled();
  expect(s.runtime.fetchImpl).not.toHaveBeenCalled();
});

test('別モデルの採点もすべて検査する', () => {
  const s = setup();
  unlinkSync(join(s.dir('other-single'), 'score.json')); unlinkSync(join(s.dir('other-bundle'), 'score.json'));
  expect(() => main([...s.args, '--other-single', 'other-single', '--other-bundle', 'other-bundle'], s.runtime))
    .toThrow(/^採点記録が 2 件不足しています$/);
  expect(existsSync(s.reportPath)).toBe(false);
});

test.each(['--other-single', '--other-bundle'])('別モデルの片方だけの指定を拒否する: %s', (flag) => {
  const s = setup(); expect(() => main([...s.args, flag, 'other'], s.runtime)).toThrow(/^実行引数が不正です$/);
});

test.each(['--single', '--bundle', '--single-runs', '--bundle-runs', '--subset', '--runs'])('必須引数の省略を拒否する: %s', (flag) => {
  const s = setup(), index = s.args.indexOf(flag);
  expect(() => main(s.args.filter((_, i) => i !== index && i !== index + 1), s.runtime)).toThrow(/^実行引数が不正です$/);
});

test.each([['--single', '../秘密'], ['--bundle', '秘密'], ['--single-runs', '0'], ['--bundle-runs', '-1'],
  ['--single-runs', '1.5'], ['--bundle-runs', 'NaN'], ['--single-runs', '9007199254740992'], ['--subset', '秘密']])('不正な値を拒否し値を例外に含めない: %s %s', (flag, value) => {
  const s = setup();
  expect(() => main(s.args.map((arg, i) => s.args[i - 1] === flag ? value : arg), s.runtime)).toThrow(/^実行引数が不正です$/);
});

test.each([['--single', 'single'], ['--unknown', '秘密'], ['--other-single', '../秘密', '--other-bundle', 'other']])('重複・未知の引数・別モデルの不正な版を拒否する: %j', (...extra) => {
  const s = setup(); expect(() => main([...s.args, ...extra], s.runtime)).toThrow(/^実行引数が不正です$/);
});

test.each(['test', '--open-test-set'])('試験群を開かずに拒否する: %s', (value) => {
  const s = setup();
  const args = value === 'test' ? s.args.map((arg) => arg === 'smoke' ? value : arg) : [...s.args, value];
  expect(() => main(args, s.runtime)).toThrow(/^重なりの集計は試験群では実行できません$/);
  expect(s.runtime.fetchImpl).not.toHaveBeenCalled();
});

test.each(['validation', 'development', 'fixed'])('許可された集合を通信せず集計できる: %s', (subset) => {
  const s = setup(subset === 'fixed' ? 'smoke' : subset);
  expect(main(s.args.map((arg) => arg === 'smoke' ? subset : arg), s.runtime)).toBe(0);
  expect(s.runtime.fetchImpl).not.toHaveBeenCalled();
});

test('空の集合は研究数ゼロと再現率なしで保存する', () => {
  const s = setup(); writeJson(join(s.runtime.casesDir!, 'subsets.json'), { smoke: [] });
  main(s.args, s.runtime);
  expect(s.read()).toMatchObject({ reviews: 0, studies: 0, originalVsBundle: { unionStudyRecall: null },
    singleCaptureCounts: { studiesByCaptureCount: [0, 0, 0, 0] } });
});

test.each(['対象の読み込み', '採点の読み込み', '書き込み'])('読み書きの失敗は識別情報を含まない固定文言にする: %s', (kind) => {
  const s = setup();
  if (kind === '対象の読み込み') s.runtime.casesDir = join(s.root, query);
  else if (kind === '採点の読み込み') {
    const path = join(s.dir('single'), 'score.json'); unlinkSync(path); mkdirSync(path);
  } else { s.runtime.reportsDir = join(s.root, query); writeFileSync(s.runtime.reportsDir, ''); }
  expect(() => main(s.args, s.runtime)).toThrow(/^重なりの集計のファイルの読み書きに失敗しました$/);
  expect(existsSync(s.reportPath)).toBe(false);
  expect(s.runtime.stdout).not.toHaveBeenCalled();
});
