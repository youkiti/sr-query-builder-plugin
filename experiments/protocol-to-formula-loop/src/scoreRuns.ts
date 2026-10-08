import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { config } from 'dotenv';
import { esearch } from '../../../src/lib/ncbi/eutils';
import { capturedGold, redact } from '../../query-optimization-bench/ncbiEval';
import { aggregateVersion, scoreSubmission, type ReviewRuns, type RunScore, type SubmissionOutcome } from './metrics';
import { createDeps, isQueryRejection, isWildcardLimitRejection } from './ncbi';
import { readRun, runPath, writeJson } from './runDir';
import { parseRunOptions, targetReviews, type RunRuntime } from './startRuns';
import { defaultRuntime } from './tool';

export type StoredScore = RunScore & { measuredAt: string; submission: { number: number; querySha256: string } | null; submitAttempts: number };

export function readSubmissionState(dir: string) {
  const submissionPath = join(dir, 'submission.json');
  const submission = existsSync(submissionPath) ? JSON.parse(readFileSync(submissionPath, 'utf8')) as { number: number; query: string } : null;
  const fingerprint = submission ? { number: submission.number, querySha256: createHash('sha256').update(submission.query).digest('hex') } : null;
  const logPath = join(dir, 'tool-log.jsonl');
  const submitAttempts = existsSync(logPath) ? readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean)
    .filter((line) => (JSON.parse(line) as { command: string }).command === 'submit').length : 0;
  return { submission, fingerprint, submitAttempts };
}

export function scoreMatchesSubmission(saved: StoredScore, state: ReturnType<typeof readSubmissionState>): boolean {
  const { fingerprint, submitAttempts } = state;
  return saved.status === 'scored' && saved.submitAttempts === submitAttempts
    && (fingerprint === null ? saved.submission === null : saved.submission?.number === fingerprint.number
      && saved.submission?.querySha256 === fingerprint.querySha256);
}

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
  const measuredDates: string[] = [];
  for (const { review, dirs } of all) {
    const runs: RunScore[] = [];
    for (const [index, dir] of dirs.entries()) {
      const info = readRun(dir);
      if (info.version !== options.version || info.pmcid !== review.pmcid || info.runIndex !== index + 1
        || info.cutoffDate !== review.cutoffDate) throw new Error('実行条件が採点対象と一致しません');
      const scorePath = join(dir, 'score.json');
      const state = readSubmissionState(dir);
      const { submission, fingerprint, submitAttempts } = state;
      if (existsSync(scorePath)) {
        const saved = JSON.parse(readFileSync(scorePath, 'utf8')) as StoredScore;
        if (saved.status !== 'scored' && saved.status !== 'unknown') throw new Error('採点記録の状態が不正です');
        if (scoreMatchesSubmission(saved, state)) {
          runs.push(saved); measuredDates.push(saved.measuredAt); continue;
        }
      }
      let outcome: SubmissionOutcome;
      if (submission) {
        const deps = { ...createDeps({ env, fetchImpl, sleep, cutoffDate: info.cutoffDate }), rateLimiter: base.rateLimiter };
        try {
          const { count: hits } = await esearch(submission.query, deps, { retmax: 0 });
          const capturedPmids = hits ? await capturedGold(submission.query, review.evaluablePmids, deps) : [];
          if (capturedPmids.length > hits) throw new Error('捕捉数が総件数を超えています');
          outcome = { status: 'measured', hits, capturedPmids };
        } catch (error) {
          const message = redact(error instanceof Error ? error.message : String(error), [env.NCBI_API_KEY ?? '']);
          outcome = isQueryRejection(error) || isWildcardLimitRejection(error) ? { status: 'invalid_submission', reason: message } : { status: 'measurement_failed', error: message };
        }
      } else {
        outcome = submitAttempts ? { status: 'invalid_submission', reason: '受け付けられた提出がありません' } : { status: 'no_submission' };
      }
      const score = scoreSubmission(review.studies, review.evaluablePmids, outcome);
      const measuredAt = now().toISOString();
      writeJson(scorePath, { ...score, outcome, measuredAt, submission: fingerprint, submitAttempts });
      measuredDates.push(measuredAt);
      runs.push(score);
    }
    perReview.push({ pmcid: review.pmcid, tier: review.tier, runs });
  }
  const unknown = perReview.reduce((n, review) => n + review.runs.filter((run) => run.status === 'unknown').length, 0);
  if (unknown) { stdout(`未確定: ${unknown} 件。集計しません\n`); return 1; }
  measuredDates.sort((a, b) => Date.parse(a) - Date.parse(b));
  const report = { version: options.version, subset: options.subset, reviews: reviews.length,
    runsPerReview: options.runsPerReview, generatedAt: now().toISOString(),
    measuredFrom: measuredDates[0] ?? null, measuredTo: measuredDates[measuredDates.length - 1] ?? null, summary: aggregateVersion(perReview) };
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
