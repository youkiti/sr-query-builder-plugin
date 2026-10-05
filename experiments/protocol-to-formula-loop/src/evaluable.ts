import { join } from 'node:path';
import { readJsonLines, type BenchReview } from './bench';

export interface EvaluableRecord {
  pmcid: string;
  cutoffDate: string;
  measuredAt: string;
  existing: string[];
  withinCutoff: string[];
}
export interface EvaluableReview extends BenchReview {
  evaluablePmids: string[];
  excludedReports: number;
  excludedStudies: number;
  nonexistentReports: number;
  afterCutoffReports: number;
  evaluable: boolean;
}

export function applyEvaluable(review: BenchReview, record: EvaluableRecord): EvaluableReview {
  if (record.pmcid !== review.pmcid || record.cutoffDate !== review.cutoffDate) throw new Error(`評価可能性のレビューまたは検索日が一致しません: ${review.pmcid}`);
  const included = new Set(review.includedPmids);
  const existing = new Set(record.existing);
  const within = new Set(record.withinCutoff);
  if ([...existing].some((pmid) => !included.has(pmid)) || [...within].some((pmid) => !existing.has(pmid))) {
    throw new Error(`評価可能性の PMID の部分集合が不整合です: ${review.pmcid}`);
  }
  const evaluablePmids = [...included].filter((pmid) => within.has(pmid));
  const studies = review.studies.map((study) => ({ ...study, pmids: study.pmids.filter((pmid) => within.has(pmid)) })).filter((study) => study.pmids.length);
  return { ...review, studies, evaluablePmids, excludedReports: included.size - within.size,
    excludedStudies: review.studies.length - studies.length,
    nonexistentReports: included.size - existing.size, afterCutoffReports: existing.size - within.size,
    evaluable: studies.length > 0 };
}

export function loadEvaluable(casesDir: string): Map<string, EvaluableRecord> {
  return new Map(readJsonLines<EvaluableRecord>(join(casesDir, 'evaluable.jsonl')).map((record) => [record.pmcid, record]));
}
