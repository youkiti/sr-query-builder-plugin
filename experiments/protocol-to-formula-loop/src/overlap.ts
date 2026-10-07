import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { config } from 'dotenv';
import { originalFormulaOutcome } from './baseline';
import type { EvaluableReview } from './evaluable';
import type { SubmissionOutcome } from './metrics';
import { runPath, writeJson } from './runDir';
import { readSubmissionState, scoreMatchesSubmission, type StoredScore } from './scoreRuns';
import { parseRunOptions, targetReviews, type RunRuntime } from './startRuns';
import { defaultRuntime } from './tool';

const fileError = '重なりの集計のファイルの読み書きに失敗しました';

function parseOptions(args: string[]) {
  if (args.includes('--open-test-set') || args.some((arg, i) => arg === '--subset' && args[i + 1] === 'test')) {
    throw new Error('重なりの集計は試験群では実行できません');
  }
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (!['--runs', '--subset', '--single', '--single-runs', '--bundle', '--bundle-runs', '--other-single', '--other-bundle'].includes(key)
      || values.has(key) || !args[i + 1] || args[i + 1]!.startsWith('--')) throw new Error('実行引数が不正です');
    values.set(key, args[++i]!);
  }
  const single = values.get('--single'), bundle = values.get('--bundle');
  const otherSingle = values.get('--other-single') ?? null, otherBundle = values.get('--other-bundle') ?? null;
  const singleRuns = Number(values.get('--single-runs')), bundleRuns = Number(values.get('--bundle-runs'));
  if (!single || !bundle || [single, bundle, otherSingle, otherBundle].some((value) => value !== null && !/^[A-Za-z0-9_-]+$/.test(value))
    || (otherSingle === null) !== (otherBundle === null)
    || [singleRuns, bundleRuns].some((value) => !Number.isSafeInteger(value) || value <= 0)) throw new Error('実行引数が不正です');
  try {
    return { ...parseRunOptions(['--runs', values.get('--runs') ?? '', '--subset', values.get('--subset') ?? '',
      '--version', single, '--runs-per-review', String(singleRuns)], '--runs'), single, singleRuns, bundle, bundleRuns, otherSingle, otherBundle };
  } catch { throw new Error('実行引数が不正です'); }
}

interface ReviewCaptures {
  review: EvaluableReview;
  original: boolean[];
  single: boolean[][];
  bundle: boolean[][];
  otherSingle: boolean[][];
  otherBundle: boolean[][];
}

function partition(left: boolean[], right: boolean[]) {
  const counts = { both: 0, leftOnly: 0, rightOnly: 0, neither: 0 };
  for (const [i, captured] of left.entries()) {
    counts[captured ? right[i] ? 'both' : 'leftOnly' : right[i] ? 'rightOnly' : 'neither']++;
  }
  return counts;
}

function pairedSummary(rows: ReviewCaptures[], other: boolean) {
  const total = { both: 0, leftOnly: 0, rightOnly: 0, neither: 0,
    reviewsLeftOnly: 0, reviewsRightOnly: 0, reviewsNeither: 0,
    reviewsAllByLeft: 0, reviewsAllByRight: 0, reviewsAllByUnion: 0,
    leftStudyRecall: 0, rightStudyRecall: 0, unionStudyRecall: 0 };
  for (const row of rows) {
    const perReview = { ...total };
    for (const key of Object.keys(perReview) as (keyof typeof perReview)[]) perReview[key] = 0;
    for (const [i, bundle] of row.bundle.entries()) {
      const counts = partition(other ? bundle : row.original, other ? row.otherBundle[i]! : bundle);
      const size = row.review.studies.length;
      const values = { ...counts, reviewsLeftOnly: Number(counts.leftOnly > 0), reviewsRightOnly: Number(counts.rightOnly > 0),
        reviewsNeither: Number(counts.neither > 0), reviewsAllByLeft: Number(counts.rightOnly + counts.neither === 0),
        reviewsAllByRight: Number(counts.leftOnly + counts.neither === 0), reviewsAllByUnion: Number(counts.neither === 0),
        leftStudyRecall: (counts.both + counts.leftOnly) / size, rightStudyRecall: (counts.both + counts.rightOnly) / size,
        unionStudyRecall: (size - counts.neither) / size };
      for (const key of Object.keys(values) as (keyof typeof values)[]) perReview[key] += values[key];
    }
    for (const key of Object.keys(total) as (keyof typeof total)[]) total[key] += perReview[key] / row.bundle.length;
  }
  const { both, neither, reviewsNeither, reviewsAllByUnion } = total;
  const recall = (value: number) => rows.length ? value / rows.length : null;
  const common = { both, neither, reviewsNeither, reviewsAllByUnion, unionStudyRecall: recall(total.unionStudyRecall) };
  return other ? { ...common, bundleOnly: total.leftOnly, otherOnly: total.rightOnly,
    reviewsBundleOnly: total.reviewsLeftOnly, reviewsOtherOnly: total.reviewsRightOnly,
    reviewsAllByBundle: total.reviewsAllByLeft, reviewsAllByOther: total.reviewsAllByRight,
    bundleStudyRecall: recall(total.leftStudyRecall), otherStudyRecall: recall(total.rightStudyRecall) }
    : { ...common, originalOnly: total.leftOnly, bundleOnly: total.rightOnly,
      reviewsOriginalOnly: total.reviewsLeftOnly, reviewsBundleOnly: total.reviewsRightOnly,
      reviewsAllByOriginal: total.reviewsAllByLeft, reviewsAllByBundle: total.reviewsAllByRight,
      originalStudyRecall: recall(total.leftStudyRecall), bundleStudyRecall: recall(total.rightStudyRecall) };
}

function summarize(rows: ReviewCaptures[], singleRuns: number, hasOther: boolean) {
  const studiesByCaptureCount = Array<number>(singleRuns + 1).fill(0);
  const byOriginal = { captured: Array<number>(singleRuns + 1).fill(0), missed: Array<number>(singleRuns + 1).fill(0) };
  const singleOverlap = { both: 0, singleOnly: 0, otherOnly: 0, neither: 0 };
  for (const row of rows) {
    for (const [i, original] of row.original.entries()) {
      const count = row.single.filter((run) => run[i]).length;
      studiesByCaptureCount[count]!++;
      byOriginal[original ? 'captured' : 'missed'][count]!++;
    }
    if (hasOther) {
      const counts = partition(row.original.map((_, i) => row.single.some((run) => run[i])),
        row.original.map((_, i) => row.otherSingle.some((run) => run[i])));
      singleOverlap.both += counts.both; singleOverlap.singleOnly += counts.leftOnly;
      singleOverlap.otherOnly += counts.rightOnly; singleOverlap.neither += counts.neither;
    }
  }
  return { reviews: rows.length, studies: rows.reduce((sum, row) => sum + row.review.studies.length, 0),
    originalVsBundle: pairedSummary(rows, false), singleCaptureCounts: { studiesByCaptureCount, byOriginal },
    otherModel: hasOther ? { single: singleOverlap, bundle: pairedSummary(rows, true) } : null };
}

export function main(args: string[], runtime: RunRuntime = defaultRuntime()): number {
  const options = parseOptions(args);
  let reviews: EvaluableReview[];
  try { reviews = targetReviews(options, runtime); }
  catch { throw new Error(fileError); }
  let missing = 0;
  const all: ReviewCaptures[] = reviews.map((review) => {
    const capturedStudies = (pmids: string[]) => {
      const captured = new Set(pmids.filter((pmid) => review.evaluablePmids.includes(pmid)));
      return review.studies.map((study) => study.pmids.some((pmid) => captured.has(pmid)));
    };
    const load = (version: string | null, runs: number): boolean[][] => {
      if (version === null) return [];
      return Array.from({ length: runs }, (_, i) => {
        const dir = runPath(options.root, version, review.pmcid, i + 1), path = join(dir, 'score.json');
        if (!existsSync(path)) { missing++; return []; }
        try {
          const score = JSON.parse(readFileSync(path, 'utf8')) as (StoredScore & { outcome?: SubmissionOutcome }) | null;
          if (!score || !scoreMatchesSubmission(score, readSubmissionState(dir))) { missing++; return []; }
          const outcome = score.outcome;
          if (outcome?.status === 'no_submission' || outcome?.status === 'invalid_submission') return capturedStudies([]);
          if (outcome?.status !== 'measured' || !Array.isArray(outcome.capturedPmids)
            || outcome.capturedPmids.some((pmid) => typeof pmid !== 'string')) { missing++; return []; }
          return capturedStudies(outcome.capturedPmids);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code) throw new Error(fileError);
          missing++; return [];
        }
      });
    };
    return { review, original: capturedStudies(originalFormulaOutcome(review).capturedPmids),
      single: load(options.single, options.singleRuns), bundle: load(options.bundle, options.bundleRuns),
      otherSingle: load(options.otherSingle, options.singleRuns), otherBundle: load(options.otherBundle, options.bundleRuns) };
  });
  if (missing) throw new Error(`採点記録が ${missing} 件不足しています`);
  const { subset, single, singleRuns, bundle, bundleRuns, otherSingle, otherBundle } = options;
  const summarizeRows = (rows: ReviewCaptures[]) => summarize(rows, singleRuns, otherSingle !== null);
  const report = { subset, single, singleRuns, bundle, bundleRuns, otherSingle, otherBundle,
    generatedAt: runtime.now().toISOString(), ...summarizeRows(all),
    tiers: { 'cc-by': summarizeRows(all.filter((row) => row.review.tier === 'cc-by')),
      'cc-by-nc': summarizeRows(all.filter((row) => row.review.tier === 'cc-by-nc')) } };
  try {
    const reportsDir = runtime.reportsDir ?? resolve(__dirname, '../reports');
    mkdirSync(reportsDir, { recursive: true });
    writeJson(join(reportsDir, `overlap-${bundle}-${subset}.json`), report);
  } catch { throw new Error(fileError); }
  runtime.stdout(`対象のレビュー: ${report.reviews} 件\n研究: ${report.studies} 個\n`);
  return 0;
}
if (require.main === module) {
  config();
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; }
}
