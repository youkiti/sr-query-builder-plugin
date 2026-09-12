import type { Comparison, Metrics, StudyGroup } from './types';

const ratio = (numerator: number, denominator: number): number | null => denominator === 0 ? null : numerator / denominator;

export function calculateMetrics(groups: readonly StudyGroup[], heldOut: readonly string[], capturedPmids: readonly string[], hits: number): Metrics {
  if (!Number.isSafeInteger(hits) || hits < 0) throw new Error('hits は非負の整数が必要です');
  const captured = new Set(capturedPmids);
  const goldPmids = new Set(groups.flatMap((group) => group.pmids));
  const studies = groups.flatMap((group) => group.members);
  const heldOutStudies = new Set(groups.filter((group) => heldOut.includes(group.id)).flatMap((group) => group.members.map((study) => study.studyId)));
  const capturedStudies = studies.filter((study) => study.pmids.some((pmid) => captured.has(pmid))).map((study) => study.studyId);
  const capturedHeldOut = capturedStudies.filter((id) => heldOutStudies.has(id));
  const reports = [...goldPmids].filter((pmid) => captured.has(pmid)).length;
  if (reports > hits) throw new Error('捕捉 gold PMID 数が hits を超えています');
  return {
    heldOutRecall: ratio(capturedHeldOut.length, heldOutStudies.size),
    allStudyRecall: ratio(capturedStudies.length, studies.length), hits,
    capturedStudies, capturedHeldOut,
    knownIncludedReportShare: ratio(reports, hits),
    recordsPerKnownIncludedStudy: ratio(hits, capturedStudies.length),
  };
}

export function compareMetrics(c0: Metrics, c1: Metrics): Comparison {
  const difference = (a: string[], b: string[]) => a.filter((id) => !b.includes(id));
  const lostStudies = difference(c0.capturedStudies, c1.capturedStudies);
  const gainedStudies = difference(c1.capturedStudies, c0.capturedStudies);
  const lostHeldOut = difference(c0.capturedHeldOut, c1.capturedHeldOut);
  const gainedHeldOut = difference(c1.capturedHeldOut, c0.capturedHeldOut);
  const improved = lostHeldOut.length === 0 && (gainedHeldOut.length > 0 || c1.hits < c0.hits);
  const outcome = improved ? 'improved' : lostHeldOut.length > 0 && c1.hits < c0.hits ? 'tradeoff'
    : lostHeldOut.length > 0 || c1.hits > c0.hits ? 'worse' : 'unchanged';
  return { lostStudies, gainedStudies, lostHeldOut, gainedHeldOut, improved, outcome };
}
