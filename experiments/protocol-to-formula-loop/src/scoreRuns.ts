import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { config } from 'dotenv';
import { evaluateSearch, redact } from '../../query-optimization-bench/ncbiEval';
import { aggregateVersion, scoreSubmission, type ReviewRuns, type RunScore, type SubmissionOutcome } from './metrics';
import { createDeps } from './ncbi';
import { readRun, runPath, writeJson } from './runDir';
import { parseRunOptions, targetReviews, type RunRuntime } from './startRuns';
import { defaultRuntime } from './tool';

export async function main(args: string[], runtime: RunRuntime = defaultRuntime()): Promise<number> {
  const options = parseRunOptions(args, '--runs');
  const reviews = targetReviews(options, runtime);
  const all = reviews.map((review) => ({ review, dirs: Array.from({ length: options.runsPerReview }, (_, i) =>
    runPath(options.root, options.version, review.pmcid, i + 1)) }));
  const missing = all.flatMap((row) => row.dirs).filter((dir) => !existsSync(dir) || !statSync(dir).isDirectory()).length;
  if (missing) throw new Error(`実行フォルダが ${missing} 件不足しています`);
  const { env, fetchImpl, sleep, now, stdout } = runtime;
  const base = createDeps({ env, fetchImpl, sleep });
  const perReview: ReviewRuns[] = [];
  for (const { review, dirs } of all) {
    const runs: RunScore[] = [];
    for (const [index, dir] of dirs.entries()) {
      const info = readRun(dir);
      if (info.version !== options.version || info.pmcid !== review.pmcid || info.runIndex !== index + 1
        || info.cutoffDate !== review.cutoffDate) throw new Error('実行条件が採点対象と一致しません');
      const scorePath = join(dir, 'score.json');
      if (existsSync(scorePath)) {
        const saved = JSON.parse(readFileSync(scorePath, 'utf8')) as RunScore;
        if (saved.status === 'scored') { runs.push(saved); continue; }
        if (saved.status !== 'unknown') throw new Error('採点記録の状態が不正です');
      }
      let outcome: SubmissionOutcome;
      if (existsSync(join(dir, 'submission.json'))) {
        const submission = JSON.parse(readFileSync(join(dir, 'submission.json'), 'utf8')) as { query: string };
        const result = await evaluateSearch(submission.query, review.evaluablePmids,
          { ...createDeps({ env, fetchImpl, sleep, cutoffDate: info.cutoffDate }), rateLimiter: base.rateLimiter });
        outcome = result.status === 'success' ? { ...result, status: 'measured' } : { status: 'measurement_failed', error: result.error };
      } else {
        const logPath = join(dir, 'tool-log.jsonl');
        const submitted = existsSync(logPath) && readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean)
          .some((line) => (JSON.parse(line) as { command: string }).command === 'submit');
        outcome = submitted ? { status: 'invalid_submission', reason: '受け付けられた提出がありません' } : { status: 'no_submission' };
      }
      const score = scoreSubmission(review.studies, review.evaluablePmids, outcome);
      writeJson(scorePath, { ...score, outcome, measuredAt: now().toISOString() });
      runs.push(score);
    }
    perReview.push({ pmcid: review.pmcid, tier: review.tier, runs });
  }
  const unknown = perReview.reduce((n, review) => n + review.runs.filter((run) => run.status === 'unknown').length, 0);
  if (unknown) { stdout(`未確定: ${unknown} 件。集計しません\n`); return 1; }
  const report = { version: options.version, subset: options.subset, reviews: reviews.length,
    runsPerReview: options.runsPerReview, measuredAt: now().toISOString(), summary: aggregateVersion(perReview) };
  const reportsDir = runtime.reportsDir ?? resolve(__dirname, '../reports');
  mkdirSync(reportsDir, { recursive: true });
  writeJson(join(reportsDir, `${options.version}-${options.subset}.json`), report);
  stdout(JSON.stringify(report, null, 2) + '\n');
  return 0;
}
if (require.main === module) {
  config();
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(redact(String(error), [process.env.NCBI_API_KEY ?? '']) + '\n'); process.exitCode = 1;
  });
}
