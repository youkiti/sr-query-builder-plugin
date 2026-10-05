import { join } from 'node:path';
import { readJsonLines } from './bench';

export const REVIEW_TYPES = ['intervention', 'diagnostic_test_accuracy', 'prognosis', 'qualitative', 'methodology', 'other'] as const;
export type ReviewType = typeof REVIEW_TYPES[number];
export interface ReviewLabel { pmcid: string; domain: string; reviewType: ReviewType }
export const STUDY_BANDS = ['1-3', '4-10', '11+'] as const;
export type StudyBand = typeof STUDY_BANDS[number];

export function studyBand(count: number): StudyBand {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('評価可能な研究数は正整数が必要です');
  return count <= 3 ? '1-3' : count <= 10 ? '4-10' : '11+';
}

export function loadLabels(casesDir: string): Map<string, ReviewLabel> {
  const labels = new Map<string, ReviewLabel>();
  for (const row of readJsonLines<ReviewLabel>(join(casesDir, 'labels.jsonl'))) {
    if (!row || typeof row.pmcid !== 'string' || !row.pmcid.trim() || typeof row.domain !== 'string' || !row.domain.trim()
      || !REVIEW_TYPES.includes(row.reviewType)) throw new Error('ラベルの形式が不正です');
    if (labels.has(row.pmcid)) throw new Error(`ラベルの PMCID が重複しています: ${row.pmcid}`);
    labels.set(row.pmcid, { ...row, domain: row.domain.trim() });
  }
  return labels;
}
