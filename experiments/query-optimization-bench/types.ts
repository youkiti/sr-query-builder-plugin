import type { PubmedFormula } from '../../src/lib/search-formula-md';
import type { QueryOptimizationResult } from '../../src/app/services/queryOptimizationService';

export const CASES = [
  { id: 'r1-mindfulness-smoking', pmcid: 'PMC9009295', searchDate: '2021-04-15' },
  { id: 'r2-pdr-prognostic', pmcid: 'PMC9943918', searchDate: '2022-05-27' },
  { id: 'r3-vascular-bleeding', pmcid: 'PMC9936832', searchDate: '2022-03-31' },
] as const;

export const PROFILES = [
  { id: 'default', maxHits: 10000, maxIterations: 5 },
  { id: 'tight-1000', maxHits: 1000, maxIterations: 5 },
] as const;

export interface StudyGroup {
  id: string;
  members: { studyId: string; pmids: string[] }[];
  pmids: string[];
}

export interface FrozenSeeds {
  seed: number;
  selections: { groupId: string; pmid: string; year: number | null }[];
}

export interface GoldAudit {
  includedStudyCount: number;
  includedPmidCount: number;
  overlapPmids: string[];
  sharedPmids: { pmid: string; studies: string[] }[];
  withoutPmid: string[];
  unmappedPmids: string[];
  publicationYears: Record<string, number | null>;
  exclusions: { withoutPmid: number; unresolvedMapping: number; outsideDate: number | null };
  // false は、人が共有 PMID による群の扱いを確認した場合だけ設定する。
  manual_review: boolean;
  reviewNote: string;
  dateValidation: 'pending';
}

export interface BenchCase {
  id: string;
  pmcid: string;
  searchDate: string;
  license: string;
  protocolPath: string;
  gold: StudyGroup[];
  heldOut: string[];
  seeds: FrozenSeeds;
}

export type SearchMeasurement =
  | { status: 'success'; hits: number; capturedPmids: string[] }
  | { status: 'failure'; error: string };

export interface Metrics {
  heldOutRecall: number | null;
  allStudyRecall: number | null;
  hits: number;
  capturedStudies: string[];
  capturedHeldOut: string[];
  knownIncludedReportShare: number | null;
  recordsPerKnownIncludedStudy: number | null;
}

export interface Comparison {
  lostStudies: string[];
  gainedStudies: string[];
  lostHeldOut: string[];
  gainedHeldOut: string[];
  improved: boolean;
  outcome: 'improved' | 'tradeoff' | 'unchanged' | 'worse';
}

export interface ConditionResult {
  query: string;
  formula?: PubmedFormula;
  measurement: SearchMeasurement;
  metrics: Metrics | null;
}

export interface RunResult {
  id: string;
  runId: string;
  profileId: typeof PROFILES[number]['id'];
  status: 'running' | 'completed' | 'failed' | 'dry-run';
  startedAt: string;
  model: string;
  searchDate: string;
  maxHits: number;
  maxIterations: number;
  conditions: Partial<Record<'C0' | 'C1' | 'B1', ConditionResult>>;
  optimization?: QueryOptimizationResult;
  rejectedCandidates?: {
    candidateId: string;
    accepted: boolean;
    changes: QueryOptimizationResult['trials'][number]['changes'] | null;
    hits: number | null;
    metrics: Metrics | null;
    comparedToC0: Comparison | null;
    error?: string;
  }[];
  comparison?: Comparison | null;
  denominator?: { groups: StudyGroup[]; heldOut: string[]; outsideDatePmids: string[]; outsideDateGroups: string[]; manualReviewPending: boolean };
  apiCalls: { ncbi: number; llm: number };
  apiElapsedMs: { ncbi: number; llm: number };
  elapsedMs: number;
  llmLogs: string[];
  error?: string;
}
