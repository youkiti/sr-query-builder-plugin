import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadReviews, loadSummaries, resolveBenchDir, TIERS, type BenchReview, type BenchSummary, type Tier } from './bench';
import { casesDir } from './cases';
import { applyEvaluable, loadEvaluable, type EvaluableRecord } from './evaluable';
import { aggregateVersion, scoreSubmission, type ReviewRuns, type SubmissionOutcome, type VersionSummary } from './metrics';

export function originalFormulaOutcome(review: BenchReview): Extract<SubmissionOutcome, { status: 'measured' }> {
  const missed = new Set(review.included_not_retrieved);
  return { status: 'measured', hits: review.n_records, capturedPmids: review.includedPmids.filter((pmid) => !missed.has(pmid)) };
}

export function reconcileWithBench(reviews: BenchReview[], summaries: Record<Tier, BenchSummary>) {
  const mismatches: { pmcid?: string; tier: Tier; field: string }[] = [];
  const computed = reviews.map((review) => {
    const captured = new Set(originalFormulaOutcome(review).capturedPmids);
    const capturedStudies = review.studies.filter((study) => study.pmids.some((pmid) => captured.has(pmid))).length;
    const values = { n_included_pmids: review.includedPmids.length, n_included_studies: review.studies.length,
      included_studies_retrieved: capturedStudies, included_study_recall: review.studies.length ? capturedStudies / review.studies.length : 0,
      included_recall: review.includedPmids.length ? captured.size / review.includedPmids.length : 0 };
    for (const field of Object.keys(values) as (keyof typeof values)[]) {
      if (!Number.isFinite(review[field]) || Math.abs(values[field] - review[field]) > 1e-9) mismatches.push({ pmcid: review.pmcid, tier: review.tier, field });
    }
    return { tier: review.tier, ...values };
  });
  for (const tier of TIERS) {
    const rows = computed.filter((row) => row.tier === tier);
    for (const [field, source] of [['study_macro_recall', 'included_study_recall'], ['pmid_macro_recall', 'included_recall']] as const) {
      const actual = rows.length ? rows.reduce((sum, row) => sum + row[source], 0) / rows.length : 0;
      if (!Number.isFinite(summaries[tier][field]) || Math.abs(actual - summaries[tier][field]) > 1e-9) mismatches.push({ tier, field });
    }
  }
  return { count: mismatches.length, fields: [...new Set(mismatches.map((row) => row.field))], mismatches };
}

export function originalBaseline(reviews: BenchReview[], evaluable: Map<string, EvaluableRecord>): { summary: VersionSummary; excludedReviews: number } {
  let excludedReviews = 0;
  const runs: ReviewRuns[] = [];
  for (const review of reviews) {
    const record = evaluable.get(review.pmcid);
    if (!record) throw new Error(`評価可能性の記録がありません: ${review.pmcid}`);
    const filtered = applyEvaluable(review, record);
    if (!filtered.evaluable) { excludedReviews++; continue; }
    const outcome = originalFormulaOutcome(review);
    outcome.capturedPmids = outcome.capturedPmids.filter((pmid) => filtered.evaluablePmids.includes(pmid));
    runs.push({ pmcid: review.pmcid, tier: review.tier, runs: [scoreSubmission(filtered.studies, filtered.evaluablePmids, outcome)] });
  }
  return { summary: aggregateVersion(runs), excludedReviews };
}

export function main(benchDir = resolveBenchDir(), output = casesDir()): void {
  const reviews = loadReviews(benchDir);
  const reconciliation = reconcileWithBench(reviews, loadSummaries(benchDir));
  process.stdout.write(reconciliation.count ? `不一致: ${reconciliation.count} 件\n` : '一致: 不一致 0 件\n');
  if (reconciliation.count) process.exitCode = 1;
  if (existsSync(join(output, 'evaluable.jsonl'))) process.stdout.write(`${JSON.stringify(originalBaseline(reviews, loadEvaluable(output)))}\n`);
}
if (require.main === module) {
  try { main(); } catch (error) { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; }
}
