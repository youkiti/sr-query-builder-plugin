import type { PubmedFormula } from '../../src/lib/search-formula-md';
import type { QueryOptimizationResult } from '../../src/app/services/queryOptimizationService';
import { DEFAULT_OPTIMIZATION_MAX_HITS } from '../../src/app/services/queryOptimizationSettingsService';

/** 事前登録した development ケースと、将来追加する confirmation ケースを区別する（選定は事後に行う）。 */
export type CaseRole = 'development' | 'confirmation';

export const CASES = [
  { id: 'r1-mindfulness-smoking', pmcid: 'PMC9009295', searchDate: '2021-04-15', role: 'development' },
  { id: 'r2-pdr-prognostic', pmcid: 'PMC9943918', searchDate: '2022-05-27', role: 'development' },
  { id: 'r3-vascular-bleeding', pmcid: 'PMC9936832', searchDate: '2022-03-31', role: 'development' },
] as const satisfies readonly { id: string; pmcid: string; searchDate: string; role: CaseRole }[];

export const PROFILES = [
  { id: 'default', maxHits: DEFAULT_OPTIMIZATION_MAX_HITS, maxIterations: 5, postHoc: false },
  { id: 'tight-1000', maxHits: 1000, maxIterations: 5, postHoc: true },
] as const;

export interface StudyGroup {
  id: string;
  members: { studyId: string; pmids: string[] }[];
  pmids: string[];
}

/** 乱数分割と手動の名前付き集合は識別フィールドを混在させない。 */
export type FrozenSeeds = ({ seed: number; name?: never } | { name: string; seed?: never }) & {
  selections: { groupId: string; pmid: string; year: number | null }[];
};

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

/** C0 の出所。凍結 fixture を使ったときだけ id/sha256/variant/draftIndex を持つ。 */
export interface C0Reference {
  source: 'live' | 'frozen';
  id?: string;
  sha256?: string;
  variant?: 'criteria-only' | 'seeded';
  draftIndex?: number;
}

/** 1 候補（proposal trial）の採否監査。judged against 直前の基準式（採用済み直近候補、無ければ C0）。 */
export interface AdoptionTrialAudit {
  candidateId: string;
  accepted: boolean;
  /** レビュー保留（held）だった試行か。 */
  held: boolean;
  hitsBefore: number | null;
  hitsAfter: number | null;
  /** 直前の基準式 → この候補で失った held-out 研究名。計測できないときは空配列（0 件確定の意味ではない。error を見ること）。 */
  lostHeldOut: string[];
  gainedHeldOut: string[];
  /** 計測に失敗したときだけ設定。設定時は lostHeldOut/gainedHeldOut を「0 件だった」と読まない。 */
  error?: string;
}

/** C0→C1 の間に採用されたすべての候補の有害採用（held-out を失った採用）監査。 */
export interface AdoptionAudit {
  adopted: number;
  /** 比較元または候補自身の metrics が無く、比較できなかった採用件数。 */
  unscoredAdopted: number;
  /** manualReviewPending または比較できない採用があるときは採点を保留し null。 */
  harmfulAdopted: number | null;
  trials: AdoptionTrialAudit[];
}

/**
 * outside check（margin 探索）による確認負荷の集計。**候補は自動調整へフィードバックしない**
 * （採否も readjustment もしない、件数を数えるだけ）。gold への対応付け（heldOutStudiesAmongCandidates）は
 * この集計のためだけに、実行後・事後に行う。
 */
export interface ConfirmationAudit {
  status: 'ready' | 'error' | 'skipped';
  reason: string | null;
  marginHits: number | null;
  outsidePmids: string[];
  /** held（レビュー保留）だった候補の impact.inspected から、シード PMID を除いた PMID。 */
  lostInspectedPmids: string[];
  /** outsidePmids ∪ lostInspectedPmids の件数。 */
  total: number;
  /** 候補集合と PMID が交わる held-out 群の研究 id。 */
  heldOutStudiesAmongCandidates: string[];
  /** 候補集合のうち gold PMID に含まれない件数（参考値）。 */
  nonGoldCandidates: number;
}

/**
 * issue #128 の手順 4「固定提案による replay」の適用記録。`optimize_query` の応答を
 * fixture から固定して流したことを示す。存在すれば自由生成ではなく replay run。
 */
export interface ReplaySummary {
  name: string;
  /** 適用した fixture 内容（responses・c0 参照を含む）から計算したハッシュ。compare.ts の突合に使う。 */
  sha256: string;
  /** fixture に用意されていた応答の総数。 */
  responseCount: number;
  /** 実際に `optimize_query` へ返した応答の数（使い切る前に他の理由で停止すれば responseCount 未満）。 */
  usedCount: number;
  /** 用意した応答をすべて使い切って停止したか。 */
  exhausted: boolean;
}

/** LLM 呼び出しの使用量とコスト概算。失敗した呼び出しも calls に数え、tokens は null。 */
export interface LlmUsage {
  calls: number;
  tokensIn: number;
  tokensOut: number;
  /** 1 回でも価格表に無いモデル呼び出しがあるか、または成功時のトークン数が両方不明なら null（unpricedCalls / untrackedCalls を参照）。 */
  costUsd: number | null;
  unpricedCalls: number;
  untrackedCalls: number;
}

export interface RunResult {
  id: string;
  runId: string;
  // 登録済みの default/tight-1000 に加え、--max-hits 指定時は `custom-<n>` を動的に発行するため string。
  profileId: string;
  status: 'running' | 'completed' | 'failed' | 'dry-run';
  startedAt: string;
  model: string;
  searchDate: string;
  maxHits: number;
  maxIterations: number;
  /** 使用した gitHEAD（取得失敗時は null）。 */
  gitCommit?: string | null;
  label?: string;
  /** 実行時に作業ツリーが汚れていたか（取得失敗時は null）。 */
  gitDirty?: boolean | null;
  /** C0 が凍結 fixture 由来か、その場で生成した live かを記録する。 */
  c0?: C0Reference;
  /** 使用したシード分割の id（既定は `s20260912`）。 */
  seedSplit?: string;
  /** development/confirmation の別（selection は別途）。 */
  role?: CaseRole;
  /** tight-1000 または --max-hits による事後探索条件かどうか。 */
  postHoc?: boolean;
  /** C0→C1 で採用された候補のうち、held-out 捕捉を失った「有害な採用」の監査。 */
  adoptionAudit?: AdoptionAudit;
  /** outside check（margin 探索）による、人が確認すべき候補件数の集計。 */
  confirmation?: ConfirmationAudit;
  /** LLM 呼び出しの使用量とコスト概算。 */
  llmUsage?: LlmUsage;
  /** 固定提案の replay で実行した run のときだけ設定する。 */
  replay?: ReplaySummary;
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
