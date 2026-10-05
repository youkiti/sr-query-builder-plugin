import { type Study, type Tier } from './bench';

export type SubmissionOutcome =
  | { status: 'measured'; hits: number; capturedPmids: string[] }
  | { status: 'invalid_submission'; reason: string }
  | { status: 'no_submission' }
  | { status: 'measurement_failed'; error: string };
export interface ScoredRun {
  status: 'scored';
  hits: number;
  studyRecall: number;
  pmidRecall: number;
  missedStudies: number;
  allCaptured: boolean;
  precision: number;
  f7: number;
  failed: boolean;
}
export type RunScore = ScoredRun | { status: 'unknown'; error: string };

export function scoreSubmission(studies: readonly Study[], evaluablePmids: readonly string[], outcome: SubmissionOutcome): RunScore {
  if (outcome.status === 'measurement_failed') return { status: 'unknown', error: outcome.error };
  if (!studies.length || !evaluablePmids.length) throw new Error('採点には評価可能な研究と PMID が必要です');
  const failed: ScoredRun = { status: 'scored', hits: 0, studyRecall: 0, pmidRecall: 0, missedStudies: studies.length,
    allCaptured: false, precision: 0, f7: 0, failed: true };
  if (outcome.status === 'invalid_submission' || outcome.status === 'no_submission') return failed;
  if (!Number.isSafeInteger(outcome.hits) || outcome.hits < 0) throw new Error('hits は非負の整数が必要です');
  const captured = new Set(outcome.capturedPmids);
  const evaluable = new Set(evaluablePmids);
  if ([...captured].some((pmid) => !evaluable.has(pmid))) throw new Error('評価可能でない PMID が捕捉集合にあります');
  if (captured.size > outcome.hits) throw new Error('捕捉 PMID 数が hits を超えています');
  if (outcome.hits === 0) return failed;
  const capturedStudies = studies.filter((study) => study.pmids.some((pmid) => captured.has(pmid))).length;
  const studyRecall = capturedStudies / studies.length;
  const precision = captured.size / outcome.hits;
  const denominator = 49 * precision + studyRecall;
  return { status: 'scored', hits: outcome.hits, studyRecall, pmidRecall: captured.size / evaluable.size,
    missedStudies: studies.length - capturedStudies, allCaptured: capturedStudies === studies.length,
    precision, f7: denominator ? 50 * precision * studyRecall / denominator : 0, failed: false };
}

export interface Summary {
  reviews: number;
  allCapturedRate: number | null;
  studyRecall: number | null;
  pmidRecall: number | null;
  missedStudies: number;
  failureRate: number | null;
  medianHits: number | null;
  reviewsWithoutSuccessfulRuns: number;
  f7: number | null;
}
export interface VersionSummary extends Summary { tiers: Record<Tier, Summary> }
export interface ReviewRuns { pmcid: string; tier: Tier; runs: RunScore[] }
const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;

export function aggregateVersion(perReview: ReviewRuns[]): VersionSummary {
  const unknown = perReview.filter((review) => review.runs.some((run) => run.status === 'unknown'));
  if (unknown.length) throw new Error(`未確定のレビューが ${unknown.length} 件あります（未確定 run ${unknown.reduce((sum, review) => sum + review.runs.filter((run) => run.status === 'unknown').length, 0)} 件）`);
  if (perReview.some((review) => !review.runs.length)) throw new Error('run が空のレビューがあります');
  const averaged = perReview.map((review) => {
    const runs = review.runs as ScoredRun[];
    const successful = runs.filter((run) => !run.failed);
    return { tier: review.tier, allCapturedRate: mean(runs.map((run) => Number(run.allCaptured))),
      studyRecall: mean(runs.map((run) => run.studyRecall)), pmidRecall: mean(runs.map((run) => run.pmidRecall)),
      missedStudies: mean(runs.map((run) => run.missedStudies)), failureRate: mean(runs.map((run) => Number(run.failed))),
      hits: successful.length ? mean(successful.map((run) => run.hits)) : null, f7: mean(runs.map((run) => run.f7)) };
  });
  const summarize = (rows: typeof averaged): Summary => {
    const hits = rows.flatMap((row) => row.hits === null ? [] : [row.hits]).sort((a, b) => a - b);
    const average = (key: 'allCapturedRate' | 'studyRecall' | 'pmidRecall' | 'failureRate' | 'f7') => rows.length ? mean(rows.map((row) => row[key])) : null;
    return { reviews: rows.length, allCapturedRate: average('allCapturedRate'), studyRecall: average('studyRecall'),
      pmidRecall: average('pmidRecall'), missedStudies: rows.reduce((sum, row) => sum + row.missedStudies, 0),
      failureRate: average('failureRate'), f7: average('f7'), reviewsWithoutSuccessfulRuns: rows.length - hits.length,
      medianHits: hits.length ? (hits[Math.floor((hits.length - 1) / 2)]! + hits[Math.floor(hits.length / 2)]!) / 2 : null };
  };
  return { ...summarize(averaged), tiers: { 'cc-by': summarize(averaged.filter((row) => row.tier === 'cc-by')),
    'cc-by-nc': summarize(averaged.filter((row) => row.tier === 'cc-by-nc')) } };
}
