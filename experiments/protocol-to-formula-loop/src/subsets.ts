import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadReviews, resolveBenchDir, TIERS } from './bench';
import { casesDir } from './cases';
import { applyEvaluable, loadEvaluable, type EvaluableReview } from './evaluable';
import { loadLabels, REVIEW_TYPES, STUDY_BANDS, studyBand, type ReviewLabel } from './labels';
import { splitReviews } from './split';

export const SUBSET_SALT = 'protocol-to-formula-loop/subsets/2026-10-05';
export interface Subsets { smoke: string[]; fixed: string[] }
const lexical = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const spaced = <T>(rows: T[], count: number): T[] => Array.from({ length: count }, (_, i) => rows[Math.floor((i + 0.5) * rows.length / count)]!);

export function selectSubsets(devReviews: EvaluableReview[], labels: Map<string, ReviewLabel>, sizes = { smoke: 5, fixed: 20 }): Subsets {
  if (![sizes.smoke, sizes.fixed].every((size) => Number.isSafeInteger(size) && size > 0) || sizes.smoke > sizes.fixed) throw new Error('抽出件数は正整数で、smoke は fixed 以下が必要です');
  for (const review of devReviews) if (!labels.has(review.pmcid)) throw new Error(`開発群のラベルがありません: ${review.pmcid}`);
  const rows = devReviews.filter((review) => review.eligible).map((review) => {
    const label = labels.get(review.pmcid)!;
    return { pmcid: review.pmcid, key: [review.tier, label.reviewType, label.domain, studyBand(review.studies.length),
      createHash('sha256').update(`${SUBSET_SALT}:${review.pmcid}`).digest('hex')] };
  }).sort((a, b) => {
    for (let i = 0; i < a.key.length; i++) { const order = lexical(a.key[i]!, b.key[i]!); if (order) return order; }
    return 0;
  });
  if (rows.length < sizes.fixed) throw new Error(`評価可能な開発群が固定小集合の ${sizes.fixed} 件に足りません`);
  const fixed = spaced(rows, sizes.fixed).map((row) => row.pmcid);
  return { fixed, smoke: spaced(fixed, sizes.smoke) };
}

export function writeSubsets(output: string, subsets: Subsets): void {
  writeFileSync(join(output, 'subsets.json'), JSON.stringify({ salt: SUBSET_SALT, createdAt: new Date().toISOString(), ...subsets }, null, 2) + '\n', { flag: 'wx' });
}

export function main(benchDir = resolveBenchDir(), output = casesDir()): void {
  const reviews = loadReviews(benchDir);
  const splits = splitReviews(reviews);
  const evaluable = loadEvaluable(output);
  const dev = reviews.filter((review) => splits.get(review.pmcid) === 'development').map((review) => {
    const record = evaluable.get(review.pmcid);
    if (!record) throw new Error(`評価可能性の記録がありません: ${review.pmcid}`);
    return applyEvaluable(review, record);
  });
  const labels = loadLabels(output);
  const subsets = selectSubsets(dev, labels);
  writeSubsets(output, subsets);
  for (const name of ['smoke', 'fixed'] as const) {
    const selected = dev.filter((review) => subsets[name].includes(review.pmcid));
    process.stdout.write(`${name}: ${selected.length} 件\n`);
    for (const tier of TIERS) process.stdout.write(`${name} ${tier}: ${selected.filter((review) => review.tier === tier).length} 件\n`);
    for (const type of REVIEW_TYPES) process.stdout.write(`${name} ${type}: ${selected.filter((review) => labels.get(review.pmcid)!.reviewType === type).length} 件\n`);
    for (const band of STUDY_BANDS) process.stdout.write(`${name} ${band}: ${selected.filter((review) => studyBand(review.studies.length) === band).length} 件\n`);
  }
}
if (require.main === module) {
  try { main(); } catch (error) { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; }
}
