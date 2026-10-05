import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from 'dotenv';
import { redact } from '../../query-optimization-bench/ncbiEval';
import { loadReviews, resolveBenchDir } from './bench';
import { casesDir } from './cases';
import { loadConditions } from './conditions';
import { applyEvaluable, loadEvaluable, type EvaluableReview } from './evaluable';
import { createRun, runPath } from './runDir';
import { SPLITS, splitReviews } from './split';
import { defaultRuntime, type Runtime } from './tool';

export interface RunOptions { root: string; version: string; subset: string; runsPerReview: number; openTestSet: boolean }
export interface RunRuntime extends Runtime { casesDir?: string; harnessDir?: string; reportsDir?: string }
export function parseRunOptions(args: string[], rootFlag: '--out' | '--runs'): RunOptions {
  const values = new Map<string, string>();
  let openTestSet = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (key === '--open-test-set') { openTestSet = true; continue; }
    if (![rootFlag, '--version', '--subset', '--runs-per-review'].includes(key) || values.has(key)
      || !args[i + 1] || args[i + 1]!.startsWith('--')) throw new Error('実行引数が不正です');
    values.set(key, args[++i]!);
  }
  const root = values.get(rootFlag);
  const version = values.get('--version');
  const subset = values.get('--subset');
  const runsPerReview = Number(values.get('--runs-per-review'));
  if (!root || !version || !/^[A-Za-z0-9_-]+$/.test(version) || !subset
    || !['smoke', 'fixed', ...SPLITS].includes(subset) || !Number.isSafeInteger(runsPerReview) || runsPerReview <= 0) throw new Error('実行引数が不足しているか不正です');
  if (subset === 'test' && !openTestSet) throw new Error('試験群には --open-test-set が必要です');
  return { root, version, subset, runsPerReview, openTestSet };
}

export function targetReviews(options: RunOptions, runtime: RunRuntime): EvaluableReview[] {
  if (options.subset === 'test' && !options.openTestSet) throw new Error('試験群には --open-test-set が必要です');
  const reviews = loadReviews(resolveBenchDir(runtime.env));
  const records = loadEvaluable(runtime.casesDir ?? casesDir());
  const splits = splitReviews(reviews);
  const eligible = reviews.map((review) => {
    const record = records.get(review.pmcid);
    if (!record) throw new Error('評価可能性の記録が不足しています');
    return applyEvaluable(review, record);
  }).filter((review) => review.evaluable);
  if (options.subset === 'smoke' || options.subset === 'fixed') {
    const subsets = JSON.parse(readFileSync(join(runtime.casesDir ?? casesDir(), 'subsets.json'), 'utf8')) as Record<string, unknown>;
    const ids = subsets[options.subset];
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string') || new Set(ids).size !== ids.length
      || ids.some((id) => !eligible.some((review) => review.pmcid === id && splits.get(id) === 'development'))) throw new Error('固定集合の記録が不正です');
    return eligible.filter((review) => ids.includes(review.pmcid));
  }
  return eligible.filter((review) => splits.get(review.pmcid) === options.subset);
}

export function main(args: string[], runtime: RunRuntime = defaultRuntime()): number {
  const options = parseRunOptions(args, '--out');
  const reviews = targetReviews(options, runtime);
  const conditions = loadConditions(options.version, runtime.harnessDir);
  for (const review of reviews) for (let i = 1; i <= options.runsPerReview; i++) {
    if (existsSync(runPath(options.root, options.version, review.pmcid, i))) throw new Error('実行フォルダが既にあります');
  }
  let count = 0;
  for (const review of reviews) for (let runIndex = 1; runIndex <= options.runsPerReview; runIndex++) {
    createRun({ root: options.root, version: options.version, pmcid: review.pmcid, runIndex, cutoffDate: review.cutoffDate,
      protocolPath: join(runtime.casesDir ?? casesDir(), review.pmcid, 'protocol.md'), conditions, now: runtime.now });
    count++;
  }
  runtime.stdout(`作成: ${count} 件\n`);
  return 0;
}
if (require.main === module) {
  config();
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(redact(String(error), [process.env.NCBI_API_KEY ?? '']) + '\n'); process.exitCode = 1; }
}
