import { formatLocalized, translate, type UiLanguage } from '@/lib/i18n';
import type { OptimizationTrial } from '@/features/formula/skills/optimizeQuery';
import type { OptimizationOutsideCheckState, QueryOptimizationRunState } from '../store';

export type ReviewSectionState = 'no_human_decision' | 'confirmed' | 'unmet' | 'needs_decision' | 'decided' | 'unconfirmed';
type LostSampleAnnotation = NonNullable<NonNullable<OptimizationTrial['impact']>['annotation']>;

/** 参考注釈の表示・保存用集計。人の判定や採用条件には使わない。 */
export function countLostSampleAnnotations(annotation: LostSampleAnnotation): {
  likelyEligible: number; unclear: number; likelyIneligible: number; unannotated: number;
} {
  const counts = { likelyEligible: 0, unclear: 0, likelyIneligible: 0, unannotated: 0 };
  for (const pmid of new Set(annotation.requestedPmids)) {
    const item = annotation.items.find((entry) => entry.pmid === pmid);
    if (!item) counts.unannotated += 1;
    else if (item.judgement === 'likely_eligible') counts.likelyEligible += 1;
    else if (item.judgement === 'likely_ineligible') counts.likelyIneligible += 1;
    else counts.unclear += 1;
  }
  return counts;
}

export function formatLostSampleAnnotation(annotation: LostSampleAnnotation, language: UiLanguage = 'ja'): string {
  if (annotation.status === 'failure') return translate(language, 'draft.annotation.failure', { error: String(annotation.error) });
  const counts = countLostSampleAnnotations(annotation);
  return translate(language, 'draft.annotation.summary', { count: new Set(annotation.requestedPmids).size, eligible: counts.likelyEligible, unclear: counts.unclear, ineligible: counts.likelyIneligible })
    + (counts.unannotated ? translate(language, 'draft.annotation.unannotated', { count: counts.unannotated }) : '');
}
export interface OptimizationReviewSection {
  key: 'known_capture' | 'hit_target' | 'outside_check' | 'deletion_impact';
  label: string;
  state: ReviewSectionState;
  lines: string[];
  maybeCount?: number;
}

function decisionState(check: OptimizationOutsideCheckState | undefined, source: 'outside' | 'lost'): ReviewSectionState {
  const candidates = check?.candidates.filter((candidate) => candidate.source === source) ?? [];
  if (!candidates.length) return 'no_human_decision';
  if (candidates.some((candidate) => check?.decisions[candidate.pmid]?.status !== 'saved')) return 'needs_decision';
  if (candidates.some((candidate) => check?.decisions[candidate.pmid]?.decision === 'include')) return 'unmet';
  return candidates.some((candidate) => check?.decisions[candidate.pmid]?.decision === 'maybe') ? 'decided' : 'confirmed';
}

/** 表示と保存で同じ判定を使う。取得した書誌と集合全体の件数を区別する。 */
export function buildOptimizationReviewSections(run: QueryOptimizationRunState, language: UiLanguage = 'ja'): {
  sections: [OptimizationReviewSection, OptimizationReviewSection, OptimizationReviewSection, OptimizationReviewSection];
  unconfirmed: string[];
} {
  const known: OptimizationReviewSection = { key: 'known_capture', label: translate(language, 'draft.reviewSection.knownCapture'), state: 'unconfirmed', lines: [] };
  const hits: OptimizationReviewSection = { key: 'hit_target', label: translate(language, 'draft.reviewSection.hitTarget'), state: 'unconfirmed', lines: [] };
  const outside: OptimizationReviewSection = { key: 'outside_check', label: translate(language, 'draft.reviewSection.outsideCheck'), state: 'unconfirmed', lines: [] };
  const deletion: OptimizationReviewSection = { key: 'deletion_impact', label: translate(language, 'draft.reviewSection.deletionImpact'), state: 'unconfirmed', lines: [] };
  const sections: [OptimizationReviewSection, OptimizationReviewSection, OptimizationReviewSection, OptimizationReviewSection] = [known, hits, outside, deletion];
  const best = run.result?.best;
  const measured = best?.evaluation.finalQuery;
  const seeds = best?.evaluation.seedPmids.length ?? run.seedCount;
  const captured = measured?.capturedPmids;
  known.lines.push(captured && seeds !== null ? translate(language, 'draft.reviewSection.captured', { captured: captured.length, seeds: seeds })
    : translate(language, 'draft.reviewSection.captureUnmeasured', { seeds: seeds ?? translate(language, 'draft.reviewSection.unknown') }));
  known.lines.push(translate(language, 'draft.reviewSection.captureCaution'));
  if (seeds === 0) known.lines.push(translate(language, 'draft.reviewSection.noSeeds'));
  for (const trial of run.trials) {
    if (trial.kind === 'proposal' && trial.accepted && trial.before?.missedPmids?.length
      && trial.before.capturedPmids != null && trial.after?.capturedPmids != null
      && trial.before.capturedPmids.length === trial.after.capturedPmids.length) {
      known.lines.push(translate(language, 'draft.reviewSection.intermediate', { candidateId: trial.candidateId, reason: trial.reason }));
    }
  }
  const total = measured?.totalHits;
  hits.lines.push(translate(language, 'draft.reviewSection.hits', { target: run.maxHits.toLocaleString(), measured: total == null ? translate(language, 'draft.reviewSection.notMeasured') : translate(language, 'draft.reviewSection.hitCount', { count: total.toLocaleString() }), state: total == null ? translate(language, 'draft.reviewSection.notMeasured') : total <= run.maxHits ? translate(language, 'draft.reviewSection.withinTarget') : translate(language, 'draft.reviewSection.overTarget') }));
  if (run.result) {
    if (seeds && captured) known.state = captured.length < seeds || measured?.missedPmids?.length ? 'unmet' : 'confirmed';
    if (total != null) hits.state = total <= run.maxHits ? 'confirmed' : 'unmet';
    const check = run.outsideCheck;
    const candidates = check?.candidates.filter((candidate) => candidate.source === 'outside') ?? [];
    if (check?.status === 'ready') {
      outside.state = candidates.length && check.marginHits == null ? 'unconfirmed' : decisionState(check, 'outside');
      if (candidates.length && check.marginHits == null) outside.lines.push(translate(language, 'draft.reviewSection.outsideUnmeasured'));
      outside.maybeCount = candidates.filter((candidate) => check.decisions[candidate.pmid]?.status === 'saved'
        && check.decisions[candidate.pmid]?.decision === 'maybe').length;
      if (!candidates.length) outside.lines.push(translate(language, 'draft.reviewSection.noOutsideCandidates', { count: check.marginHits ?? translate(language, 'draft.reviewSection.notMeasured') }));
      else {
        const included = candidates.filter((candidate) => check.decisions[candidate.pmid]?.status === 'saved'
          && check.decisions[candidate.pmid]?.decision === 'include').length;
        outside.lines.push(translate(language, 'draft.reviewSection.outsideCandidates', { count: candidates.length, saved: candidates.filter((candidate) => check.decisions[candidate.pmid]?.status === 'saved').length }));
        if (outside.maybeCount) outside.lines.push(translate(language, 'draft.reviewSection.maybeRemaining', { count: outside.maybeCount }));
        if (included) outside.lines.push(translate(language, 'draft.reviewSection.outsideIncluded', { count: included }));
      }
    } else outside.lines.push((check?.reasonMessage != null ? formatLocalized(language, check.reasonMessage) : check?.reason) ?? (check?.status === 'running' ? translate(language, 'draft.reviewSection.outsideRunning') : translate(language, 'draft.reviewSection.outsideNotRun')));
    const held = run.trials.filter((trial) => trial.held);
    if (!held.length) {
      deletion.state = 'confirmed';
      deletion.lines.push(translate(language, 'draft.reviewSection.noHeldCandidates'));
    } else {
      const lost = check?.candidates.filter((candidate) => candidate.source === 'lost') ?? [];
      deletion.state = lost.length ? decisionState(check, 'lost') : 'unconfirmed';
      // 判定は保留候補の所属によらず PMID 単位で確認済み。集合全体の取得状況も全試行で確認する。
      if (deletion.state === 'confirmed' && !held.every((trial) => trial.impact
        && trial.impact.lostHits !== null && !trial.impact.error
        && trial.impact.inspected.length >= trial.impact.lostHits)) deletion.state = 'decided';
      if (lost.length) deletion.maybeCount = lost.filter((candidate) => check?.decisions[candidate.pmid]?.status === 'saved'
        && check?.decisions[candidate.pmid]?.decision === 'maybe').length;
      deletion.lines.push(translate(language, 'draft.reviewSection.heldCandidates', { count: held.length }));
      for (const trial of held) {
        const count = trial.impact?.inspected.length ?? 0;
        const lostHits = trial.impact?.lostHits;
        const sample = trial.impact?.sample;
        const prefix = translate(language, 'draft.reviewSection.heldLost', { candidateId: trial.candidateId, count: lostHits ?? translate(language, 'draft.reviewSection.notMeasured') });
        deletion.lines.push(sample?.method === 'all'
          ? translate(language, 'draft.reviewSection.randomSample', { prefix: prefix, count: count })
          : sample?.method === 'retrieved_subset'
            ? translate(language, 'draft.reviewSection.retrievedSample', { prefix: prefix, retrieved: sample.retrievedCount, count: count })
            : translate(language, 'draft.reviewSection.firstPapers', { prefix: prefix, count: count }));
        if (trial.impact?.annotation) deletion.lines.push(formatLostSampleAnnotation(trial.impact.annotation, language));
        if (lostHits != null && lostHits > count) deletion.lines.push(translate(language, 'draft.reviewSection.remaining', { count: lostHits - count }));
        // 標本を全件 exclude と判定しても否定できない適格文献の上限（片側 95%）。deletion.state の判定には使わない。
        const upperBound = formatUnconfirmedEligibleUpperBound(trial, language);
        if (upperBound) deletion.lines.push(upperBound);
        if (trial.impact?.error) deletion.lines.push(trial.impact.error);
      }
      if (deletion.maybeCount) deletion.lines.push(translate(language, 'draft.reviewSection.maybeRemaining', { count: deletion.maybeCount }));
      if (deletion.state === 'unmet') deletion.lines.push(translate(language, 'draft.reviewSection.lostIncluded'));
    }
  } else {
    outside.lines.push(translate(language, 'draft.reviewSection.outsideNoResult'));
    deletion.lines.push(translate(language, 'draft.reviewSection.deletionNoResult'));
  }
  return { sections, unconfirmed: sections.filter((section) => section.state !== 'confirmed')
    .map((section) => `${section.label}: ${section.lines.filter((line) => line !== translate(language, 'draft.reviewSection.captureCaution')).join(' / ')}`) };
}

/**
 * 保留候補ごとの採用ゲート。判定済みは保存済み exclude のみを数え、include があれば採用できない。
 * - 失う集合が閾値以下: 全件の書誌を取得し、全件判定済みであることを要求する
 * - 閾値超過: 抽出した PMID の全件を取得・判定済みなら押せる（集合全体の残りは未確認）
 * 既存の deletion.state（confirmed/decided/unmet 等、全保留候補をまとめて見る判定）とは別に、
 * 候補ごとに「採用して保存」を押せるかどうかだけを判定する。
 */
export const HELD_CANDIDATE_ADOPTION_LOST_HITS_THRESHOLD = 100;

/**
 * 失う集合がこの件数を超える候補は、標本の判定結果にかかわらず採用できない。
 * 標本（最大 20 件）の判定では集合全体の安全性を確かめられないため（実 API の評価で、
 * 失う集合が 1,000〜13,000 件で held-out の適格研究を 7〜10 件失う候補でも、
 * 無作為標本 20 件に適格文献が 1 件も入らなかった実測による。issue #172）。
 */
export const HELD_CANDIDATE_ADOPTION_MAX_LOST_HITS = 1000;

export interface HeldCandidateAdoptionGate {
  allowed: boolean;
  /** 標本（inspected）のうち保存済み exclude の件数。maybe は未確認として扱う。 */
  judgedCount: number;
  /** 標本（inspected）の件数。 */
  sampledCount: number;
  /** allowed=false のとき、あと何件の確認・判定が必要かを含めた理由。allowed=true なら null。 */
  reason: string | null;
  /** 失う集合が HELD_CANDIDATE_ADOPTION_MAX_LOST_HITS を超えるため、判定によらず採用できない。 */
  exceedsMaxLostHits: boolean;
}

/**
 * 標本（失う集合 lostHits 件からの非復元抽出 sampleSize 件）に適格文献が 0 件だったときの、
 * 母集団に含まれる適格件数の片側 95% 上限（超幾何分布）。表示・監査用の参考値で、採用ゲートの
 * 判定には使わない。sampleSize が 0 以下（標本なし）は null、lostHits 以上（全件確認）は 0 を返す。
 *
 * 適格件数 K のとき、標本 n 件が全件非適格になる確率は P(0|K) = C(L-K, n) / C(L, n)。
 * この上限は「P(0|K) >= 0.05 を満たす最大の K」で、二項係数を直接計算せず漸化式
 * P(0|K+1) = P(0|K) × (L-K-n) / (L-K)（P(0|0) = 1）で K を 0 から増やして求める。
 */
export function unconfirmedEligibleUpperBound(lostHits: number, sampleSize: number): number | null {
  if (sampleSize <= 0) return null;
  if (sampleSize >= lostHits) return 0;
  const populationSize = lostHits;
  const maxK = populationSize - sampleSize;
  let probabilityAllNonEligible = 1;
  let upperBound = 0;
  while (upperBound < maxK) {
    const nextProbability = probabilityAllNonEligible
      * (populationSize - upperBound - sampleSize) / (populationSize - upperBound);
    if (nextProbability < 0.05) break;
    probabilityAllNonEligible = nextProbability;
    upperBound += 1;
  }
  return upperBound;
}

/** 保留候補カード・最終レビュー・採用監査で共通して使う、否定できない適格文献上限の表示文。 */
export function formatUnconfirmedEligibleUpperBound(trial: OptimizationTrial, language: UiLanguage = 'ja'): string | null {
  const impact = trial.impact;
  if (!impact || impact.lostHits == null) return null;
  const sampleSize = impact.sample?.pmids.length ?? impact.inspected.length;
  const upperBound = unconfirmedEligibleUpperBound(impact.lostHits, sampleSize);
  if (upperBound === null || upperBound === 0) return null;
  const remaining = impact.lostHits - sampleSize;
  let text = translate(language, 'draft.reviewSection.eligibleUpperBound', { sampleSize: sampleSize, remaining: remaining, upperBound: upperBound });
  if (impact.sample?.method === 'retrieved_subset') {
    text += translate(language, 'draft.reviewSection.subsetUpperBound', { retrieved: impact.sample.retrievedCount });
  }
  return text;
}

export function evaluateHeldCandidateAdoptionGate(
  trial: OptimizationTrial,
  decisions: OptimizationOutsideCheckState['decisions'] | undefined,
  options: {
    bestCapturedPmids: readonly string[] | null | undefined;
    threshold?: number;
    language?: UiLanguage;
    unjudgedSeedPmids?: readonly string[];
  }
): HeldCandidateAdoptionGate {
  const { language = 'ja', bestCapturedPmids, threshold = HELD_CANDIDATE_ADOPTION_LOST_HITS_THRESHOLD, unjudgedSeedPmids = [] } = options;
  const impact = trial.impact;
  const sampledCount = impact?.inspected.length ?? 0;
  const judgedCount = impact?.inspected.filter((paper) => decisions?.[paper.pmid]?.status === 'saved'
    && decisions[paper.pmid]?.decision === 'exclude').length ?? 0;
  if (!trial.held || !impact || impact.lostHits === null
    || impact.failedMeasurements?.includes('lost_search') || (impact.error && !impact.failedMeasurements)) {
    return { allowed: false, judgedCount, sampledCount, exceedsMaxLostHits: false,
      reason: translate(language, 'draft.adoptionGate.lostUnmeasured') };
  }
  if (impact.lostHits > HELD_CANDIDATE_ADOPTION_MAX_LOST_HITS) {
    return { allowed: false, judgedCount, sampledCount, exceedsMaxLostHits: true,
      reason: translate(language, 'draft.adoptionGate.overLimit', { count: impact.lostHits.toLocaleString(language === 'en' ? 'en-US' : 'ja-JP'), limit: HELD_CANDIDATE_ADOPTION_MAX_LOST_HITS.toLocaleString(language === 'en' ? 'en-US' : 'ja-JP') })
        + translate(language, 'draft.adoptionGate.overLimitAdvice') };
  }
  if (impact.failedMeasurements?.includes('lost_fetch')) return { allowed: false, judgedCount, sampledCount, exceedsMaxLostHits: false,
    reason: translate(language, 'draft.adoptionGate.bibliographyUnavailable') };
  const lostKnownSeeds = impact.inspected.filter((paper) => unjudgedSeedPmids.includes(paper.pmid))
    .map((paper) => paper.pmid);
  if (lostKnownSeeds.length) return { allowed: false, judgedCount, sampledCount, exceedsMaxLostHits: false,
    reason: translate(language, 'draft.adoptionGate.unjudgedSeeds', { pmids: lostKnownSeeds.join(', ') }) };
  const includedPmids = impact.inspected.filter((paper) => decisions?.[paper.pmid]?.decision === 'include')
    .map((paper) => paper.pmid);
  if (includedPmids.length) {
    return { allowed: false, judgedCount, sampledCount, exceedsMaxLostHits: false,
      reason: translate(language, 'draft.adoptionGate.includedPapers', { pmids: includedPmids.join(', ') }) };
  }
  const heldCapturedPmids = trial.after?.capturedPmids;
  if (bestCapturedPmids == null || heldCapturedPmids == null) return { allowed: false, judgedCount, sampledCount, exceedsMaxLostHits: false,
    reason: translate(language, 'draft.adoptionGate.captureUnmeasured') };
  const missingSeeds = bestCapturedPmids.filter((pmid) => !heldCapturedPmids.includes(pmid));
  if (missingSeeds.length) return { allowed: false, judgedCount, sampledCount, exceedsMaxLostHits: false,
    reason: translate(language, 'draft.adoptionGate.lostSeeds', { pmids: missingSeeds.join(', ') }) };
  if (impact.lostHits <= threshold) {
    if (sampledCount >= impact.lostHits && judgedCount >= sampledCount) return { allowed: true, judgedCount, sampledCount, exceedsMaxLostHits: false, reason: null };
    return { allowed: false, judgedCount, sampledCount, exceedsMaxLostHits: false,
      reason: translate(language, 'draft.adoptionGate.remainingPapers', { count: impact.lostHits, judged: judgedCount, remaining: impact.lostHits - judgedCount }) };
  }
  const sampledPmids = impact.sample?.pmids ?? impact.inspected.map((paper) => paper.pmid);
  const missingBibliography = sampledPmids.filter((pmid) => !impact.inspected.some((paper) => paper.pmid === pmid));
  if (missingBibliography.length) return { allowed: false, judgedCount, sampledCount, exceedsMaxLostHits: false,
    reason: translate(language, 'draft.adoptionGate.missingBibliography', { count: sampledPmids.length, missing: missingBibliography.length }) };
  const unjudgedCount = sampledPmids.filter((pmid) => decisions?.[pmid]?.status !== 'saved'
    || decisions[pmid]?.decision !== 'exclude').length;
  if (sampledPmids.length > 0 && unjudgedCount === 0) return { allowed: true, judgedCount, sampledCount, exceedsMaxLostHits: false, reason: null };
  return { allowed: false, judgedCount, sampledCount, exceedsMaxLostHits: false,
    reason: translate(language, 'draft.adoptionGate.unjudgedSample', { count: sampledPmids.length, judged: sampledPmids.length - unjudgedCount, remaining: unjudgedCount, unconfirmed: impact.lostHits - judgedCount }) };
}
