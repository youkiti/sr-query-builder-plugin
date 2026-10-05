import { createHash } from 'node:crypto';
import { CASES } from '../../query-optimization-bench/types';
import { TIERS, type BenchReview } from './bench';

export const SPLIT_SALT = 'protocol-to-formula-loop/2026-10-05';
export const SPLITS = ['development', 'validation', 'test'] as const;
export type Split = typeof SPLITS[number];
export const splitKey = (review: Pick<BenchReview, 'cochrane_id' | 'pmcid'>): string => review.cochrane_id?.split('.')[0]?.trim() || review.pmcid;

export function splitReviews(reviews: readonly BenchReview[]): Map<string, Split> {
  const keys = new Set<string>();
  for (const review of reviews) {
    const key = splitKey(review);
    if (keys.has(key)) throw new Error(`分割キーが重複しています: ${review.pmcid} (${key})`);
    keys.add(key);
  }
  const result = new Map<string, Split>();
  for (const tier of TIERS) {
    const rows = reviews.filter((review) => review.tier === tier).map((review) => ({ review,
      hash: createHash('sha256').update(`${SPLIT_SALT}:${splitKey(review)}`).digest('hex') }))
      .sort((a, b) => a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0);
    rows.forEach(({ review }, index) => result.set(review.pmcid,
      index < Math.round(rows.length * 0.2) ? 'development' : index < Math.round(rows.length * 0.5) ? 'validation' : 'test'));
  }
  for (const { pmcid } of CASES) if (result.has(pmcid)) result.set(pmcid, 'development');
  return result;
}
