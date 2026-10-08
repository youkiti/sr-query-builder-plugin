import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { config } from 'dotenv';
import { aggregateVersion, type ReviewRuns, type ScoredRun } from './metrics';
import { readBudget, runPath, writeJson } from './runDir';
import { readSubmissionState, scoreMatchesSubmission, type StoredScore } from './scoreRuns';
import { parseRunOptions, targetReviews, type RunRuntime } from './startRuns';
import { defaultRuntime } from './tool';

const mean = (values: number[]): number | null => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const max = (values: number[]): number | null => values.length ? Math.max(...values) : null;
const median = (values: number[]): number | null => {
  const sorted = [...values].sort((a, b) => a - b);
  // 偶数個の中央値は中央二つの平均。
  return sorted.length ? (sorted[Math.floor((sorted.length - 1) / 2)]! + sorted[Math.floor(sorted.length / 2)]!) / 2 : null;
};

export function main(args: string[], runtime: RunRuntime = defaultRuntime()): number {
  const options = parseRunOptions(args, '--runs');
  const reviews = targetReviews(options, runtime);
  let missing = 0, unscored = 0;
  const dirs: string[] = [];
  const rows = reviews.map((review) => {
    const runs: ScoredRun[] = [];
    for (let i = 1; i <= options.runsPerReview; i++) {
      const dir = runPath(options.root, options.version, review.pmcid, i);
      dirs.push(dir);
      const path = join(dir, 'score.json');
      if (!existsSync(path)) { missing++; continue; }
      try {
        const score = JSON.parse(readFileSync(path, 'utf8')) as StoredScore | null;
        if (!score || !scoreMatchesSubmission(score, readSubmissionState(dir)) || score.status !== 'scored') { unscored++; continue; }
        runs.push(score);
      } catch { unscored++; }
    }
    return { pmcid: review.pmcid, tier: review.tier, cutoffDate: review.cutoffDate, runs };
  });
  if (missing || unscored) throw new Error(`採点記録の不足 ${missing} 件、未採点 ${unscored} 件`);
  const budgets = dirs.map((dir) => readBudget(dir));
  const runs = rows.flatMap((row) => row.runs);
  const countableHits = (scores: ScoredRun[]) => scores.filter((run) => !run.failed && typeof run.hits === 'number' && Number.isFinite(run.hits) && run.hits > 0).map((run) => run.hits);
  // 再現率は失敗も含め、レビュー内の母標準偏差（n で割る）をレビュー間で平均・中央値・最大に集計する。
  const spreads = rows.map((row) => {
    const recalls = row.runs.map((run) => run.studyRecall), average = mean(recalls)!;
    return Math.sqrt(mean(recalls.map((value) => (value - average) ** 2))!);
  });
  // 件数は失敗・非数値・非正値を除き、二本以上あるレビューの最大 ÷ 最小を集計する。
  const ranges = rows.flatMap((row) => {
    const hits = countableHits(row.runs);
    return hits.length < 2 ? [] : [Math.max(...hits) / Math.min(...hits)];
  });
  const hits = countableHits(runs);
  const measurements = budgets.map((budget) => budget.measurements), submissions = budgets.map((budget) => budget.submissions);
  // 検索日、同日は pmcid の昇順で前半 floor(n / 2) と残りに分け、レビュー内平均からレビュー間平均を取る。
  const sorted = [...rows].sort((a, b) => a.cutoffDate < b.cutoffDate ? -1 : a.cutoffDate > b.cutoffDate ? 1 : a.pmcid < b.pmcid ? -1 : a.pmcid > b.pmcid ? 1 : 0);
  const middle = Math.floor(sorted.length / 2);
  const summarize = (group: ReviewRuns[]) => {
    const summary = aggregateVersion(group);
    return { reviews: summary.reviews, allCapturedRate: summary.allCapturedRate, studyRecall: summary.studyRecall };
  };
  const report = { version: options.version, subset: options.subset, reviews: reviews.length, runsPerReview: options.runsPerReview,
    generatedAt: runtime.now().toISOString(), runs: runs.length, failedRuns: runs.filter((run) => run.failed).length,
    // 一本だけなら実行間の揺れと件数比は null。
    recallSpread: options.runsPerReview === 1 ? null : { reviews: spreads.length, mean: mean(spreads), median: median(spreads), max: max(spreads) },
    hitsRange: options.runsPerReview === 1 ? null : { reviews: ranges.length, median: median(ranges), max: max(ranges), over10x: ranges.filter((value) => value > 10).length },
    // 件数の閾値は厳密な >、道具の使用回数は全実行の中央値・最大と測定ゼロ回を数える。
    largeHits: { runs: hits.length, over10000: hits.filter((value) => value > 10000).length, over50000: hits.filter((value) => value > 50000).length },
    toolUse: { measurements: { median: median(measurements), max: max(measurements), zero: measurements.filter((value) => value === 0).length },
      submissions: { median: median(submissions), max: max(submissions) } },
    byCutoff: sorted.length < 2 ? null : { splitDate: sorted[middle]!.cutoffDate, older: summarize(sorted.slice(0, middle)), newer: summarize(sorted.slice(middle)) } };
  const reportsDir = runtime.reportsDir ?? resolve(__dirname, '../reports');
  mkdirSync(reportsDir, { recursive: true });
  writeJson(join(reportsDir, `spread-${options.version}-${options.subset}.json`), report);
  runtime.stdout(JSON.stringify(report, null, 2) + '\n');
  return 0;
}
if (require.main === module) {
  config();
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(String(error) + '\n'); process.exitCode = 1; }
}
