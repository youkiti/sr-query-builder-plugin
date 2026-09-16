import type { OptimizationTrial } from '@/features/formula/skills/optimizeQuery';
import type { OptimizationOutsideCheckState, QueryOptimizationRunState } from '../store';

export type ReviewSectionState = 'confirmed' | 'unmet' | 'needs_decision' | 'decided' | 'unconfirmed';
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

export function formatLostSampleAnnotation(annotation: LostSampleAnnotation): string {
  if (annotation.status === 'failure') return `AI の参考注釈を取得できませんでした（${annotation.error}）。人の判定には影響しません。`;
  const counts = countLostSampleAnnotations(annotation);
  return `AI の参考注釈（採否には使いません）: 標本 ${new Set(annotation.requestedPmids).size} 件中 適格らしい ${counts.likelyEligible} 件・判断不能 ${counts.unclear} 件・非適格らしい ${counts.likelyIneligible} 件`
    + (counts.unannotated ? `・未注釈 ${counts.unannotated} 件` : '');
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
  if (candidates.some((candidate) => check?.decisions[candidate.pmid]?.status !== 'saved')) return 'needs_decision';
  if (candidates.some((candidate) => check?.decisions[candidate.pmid]?.decision === 'include')) return 'unmet';
  return candidates.some((candidate) => check?.decisions[candidate.pmid]?.decision === 'maybe') ? 'decided' : 'confirmed';
}

/** 表示と保存で同じ判定を使う。取得した書誌と集合全体の件数を区別する。 */
export function buildOptimizationReviewSections(run: QueryOptimizationRunState): {
  sections: [OptimizationReviewSection, OptimizationReviewSection, OptimizationReviewSection, OptimizationReviewSection];
  unconfirmed: string[];
} {
  const known: OptimizationReviewSection = { key: 'known_capture', label: '既知文献の捕捉', state: 'unconfirmed', lines: [] };
  const hits: OptimizationReviewSection = { key: 'hit_target', label: '目安件数', state: 'unconfirmed', lines: [] };
  const outside: OptimizationReviewSection = { key: 'outside_check', label: '外側の確認', state: 'unconfirmed', lines: [] };
  const deletion: OptimizationReviewSection = { key: 'deletion_impact', label: '削除影響の確認', state: 'unconfirmed', lines: [] };
  const sections: [OptimizationReviewSection, OptimizationReviewSection, OptimizationReviewSection, OptimizationReviewSection] = [known, hits, outside, deletion];
  const best = run.result?.best;
  const measured = best?.evaluation.finalQuery;
  const seeds = best?.evaluation.seedPmids.length ?? run.seedCount;
  const captured = measured?.capturedPmids;
  known.lines.push(captured && seeds !== null ? `既知シード ${captured.length}/${seeds} 件捕捉`
    : `既知シード捕捉は未測定（対象 ${seeds ?? '不明'} 件）`);
  known.lines.push('既知シードの捕捉は、未知の適格研究の網羅性を保証するものではありません。');
  if (seeds === 0) known.lines.push('検証対象シードがないため、捕捉の確認はできていません。');
  for (const trial of run.trials) {
    if (trial.kind === 'proposal' && trial.accepted && trial.before?.missedPmids?.length
      && trial.before.capturedPmids != null && trial.after?.capturedPmids != null
      && trial.before.capturedPmids.length === trial.after.capturedPmids.length) {
      known.lines.push(`中間手 ${trial.candidateId}: ${trial.reason}`);
    }
  }
  const total = measured?.totalHits;
  hits.lines.push(`目安件数 ${run.maxHits.toLocaleString()} 件に対して実測 ${total == null ? '未測定' : `${total.toLocaleString()} 件`}（${total == null ? '未測定' : total <= run.maxHits ? '目安以下' : '目安超過'}）`);
  if (run.result) {
    if (seeds && captured) known.state = captured.length < seeds || measured?.missedPmids?.length ? 'unmet' : 'confirmed';
    if (total != null) hits.state = total <= run.maxHits ? 'confirmed' : 'unmet';
    const check = run.outsideCheck;
    const candidates = check?.candidates.filter((candidate) => candidate.source === 'outside') ?? [];
    if (check?.status === 'ready') {
      outside.state = decisionState(check, 'outside');
      outside.maybeCount = candidates.filter((candidate) => check.decisions[candidate.pmid]?.status === 'saved'
        && check.decisions[candidate.pmid]?.decision === 'maybe').length;
      if (!candidates.length) outside.lines.push(`拡張式の外側 ${check.marginHits ?? '未測定'} 件から判定候補は選ばれませんでした。網羅性の保証ではありません`);
      else {
        const included = candidates.filter((candidate) => check.decisions[candidate.pmid]?.status === 'saved'
          && check.decisions[candidate.pmid]?.decision === 'include').length;
        outside.lines.push(`外側の判定候補 ${candidates.length} 件、保存済み ${candidates.filter((candidate) => check.decisions[candidate.pmid]?.status === 'saved').length} 件`);
        if (outside.maybeCount) outside.lines.push(`maybe で保存した候補 ${outside.maybeCount} 件は未確認として残ります`);
        if (included) outside.lines.push(`式の外側に include した文献が ${included} 件あります。保護して再調整してください`);
      }
    } else outside.lines.push(check?.reason ?? (check?.status === 'running' ? '外側の確認を実行中です' : '外側の確認は未実行です'));
    const held = run.trials.filter((trial) => trial.held);
    if (!held.length) {
      deletion.state = 'confirmed';
      deletion.lines.push('保留した候補はありません（採用した変更の失う集合はすべて 0 件）');
    } else {
      const lost = check?.candidates.filter((candidate) => candidate.source === 'lost') ?? [];
      deletion.state = lost.length ? decisionState(check, 'lost') : 'unconfirmed';
      // 判定は保留候補の所属によらず PMID 単位で確認済み。集合全体の取得状況も全試行で確認する。
      if (deletion.state === 'confirmed' && !held.every((trial) => trial.impact
        && trial.impact.lostHits !== null && !trial.impact.error
        && trial.impact.inspected.length >= trial.impact.lostHits)) deletion.state = 'decided';
      if (lost.length) deletion.maybeCount = lost.filter((candidate) => check?.decisions[candidate.pmid]?.status === 'saved'
        && check?.decisions[candidate.pmid]?.decision === 'maybe').length;
      deletion.lines.push(`保留した候補 ${held.length} 件の削除影響の確認`);
      for (const trial of held) {
        const count = trial.impact?.inspected.length ?? 0;
        const lostHits = trial.impact?.lostHits;
        const sample = trial.impact?.sample;
        const prefix = `保留候補 ${trial.candidateId}: 失う集合 ${lostHits ?? '未測定'} 件`;
        deletion.lines.push(sample?.method === 'all'
          ? `${prefix}から無作為抽出した ${count} 件の書誌を確認`
          : sample?.method === 'retrieved_subset'
            ? `${prefix}のうち取得できた ${sample.retrievedCount} 件から無作為抽出した ${count} 件の書誌を確認（集合全体からの無作為抽出ではありません）`
            : `${prefix}のうち書誌を確認できたのは先頭 ${count} 件`);
        if (trial.impact?.annotation) deletion.lines.push(formatLostSampleAnnotation(trial.impact.annotation));
        if (lostHits != null && lostHits > count) deletion.lines.push(`残り ${lostHits - count} 件は未確認`);
        // 標本を全件 exclude と判定しても否定できない適格文献の上限（片側 95%）。deletion.state の判定には使わない。
        const upperBound = formatUnconfirmedEligibleUpperBound(trial);
        if (upperBound) deletion.lines.push(upperBound);
        if (trial.impact?.error) deletion.lines.push(trial.impact.error);
      }
      if (deletion.maybeCount) deletion.lines.push(`maybe で保存した候補 ${deletion.maybeCount} 件は未確認として残ります`);
      if (deletion.state === 'unmet') deletion.lines.push('失う文献に include した文献があります。保護して再調整してください');
    }
  } else {
    outside.lines.push('実行結果がないため外側の確認は未確認です');
    deletion.lines.push('実行結果がないため削除影響の確認は未確認です');
  }
  return { sections, unconfirmed: sections.filter((section) => section.state !== 'confirmed')
    .map((section) => `${section.label}: ${section.lines.filter((line) => !line.startsWith('既知シードの捕捉は、')).join(' / ')}`) };
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
export function formatUnconfirmedEligibleUpperBound(trial: OptimizationTrial): string | null {
  const impact = trial.impact;
  if (!impact || impact.lostHits == null) return null;
  const sampleSize = impact.sample?.pmids.length ?? impact.inspected.length;
  const upperBound = unconfirmedEligibleUpperBound(impact.lostHits, sampleSize);
  if (upperBound === null || upperBound === 0) return null;
  const remaining = impact.lostHits - sampleSize;
  let text = `標本 ${sampleSize} 件をすべて exclude と判定しても、残り ${remaining} 件に適格文献が最大 ${upperBound} 件（片側 95% 上限）含まれる可能性を否定できません。`;
  if (impact.sample?.method === 'retrieved_subset') {
    text += `（取得できた ${impact.sample.retrievedCount} 件からの抽出のため、集合全体に対する上限ではありません）`;
  }
  return text;
}

export function evaluateHeldCandidateAdoptionGate(
  trial: OptimizationTrial,
  decisions: OptimizationOutsideCheckState['decisions'] | undefined,
  options: {
    bestCapturedPmids: readonly string[] | null | undefined;
    threshold?: number;
    unjudgedSeedPmids?: readonly string[];
  }
): HeldCandidateAdoptionGate {
  const { bestCapturedPmids, threshold = HELD_CANDIDATE_ADOPTION_LOST_HITS_THRESHOLD, unjudgedSeedPmids = [] } = options;
  const impact = trial.impact;
  const sampledCount = impact?.inspected.length ?? 0;
  const judgedCount = impact?.inspected.filter((paper) => decisions?.[paper.pmid]?.status === 'saved'
    && decisions[paper.pmid]?.decision === 'exclude').length ?? 0;
  if (!trial.held || !impact || impact.lostHits === null
    || impact.failedMeasurements?.includes('lost_search') || (impact.error && !impact.failedMeasurements)) {
    return { allowed: false, judgedCount, sampledCount, exceedsMaxLostHits: false,
      reason: '失う集合を実測できていないため採用できません。' };
  }
  if (impact.lostHits > HELD_CANDIDATE_ADOPTION_MAX_LOST_HITS) {
    return { allowed: false, judgedCount, sampledCount, exceedsMaxLostHits: true,
      reason: `失う集合 ${impact.lostHits.toLocaleString('ja-JP')} 件が上限 ${HELD_CANDIDATE_ADOPTION_MAX_LOST_HITS.toLocaleString('ja-JP')} 件を超えるため、`
        + 'この候補は採用できません。標本の判定では集合全体に適格文献が無いことを確かめられません。再調整するか除外してください。' };
  }
  if (impact.failedMeasurements?.includes('lost_fetch')) return { allowed: false, judgedCount, sampledCount, exceedsMaxLostHits: false,
    reason: '失う集合の書誌を取得できていないため採用できません。' };
  const lostKnownSeeds = impact.inspected.filter((paper) => unjudgedSeedPmids.includes(paper.pmid))
    .map((paper) => paper.pmid);
  if (lostKnownSeeds.length) return { allowed: false, judgedCount, sampledCount, exceedsMaxLostHits: false,
    reason: `失う文献に未判定の既知シードがあるため採用できません（PMID: ${lostKnownSeeds.join(', ')}）。` };
  const includedPmids = impact.inspected.filter((paper) => decisions?.[paper.pmid]?.decision === 'include')
    .map((paper) => paper.pmid);
  if (includedPmids.length) {
    return { allowed: false, judgedCount, sampledCount, exceedsMaxLostHits: false,
      reason: `失う文献に include と判定した文献があるため採用できません（PMID: ${includedPmids.join(', ')}）。` };
  }
  const heldCapturedPmids = trial.after?.capturedPmids;
  if (bestCapturedPmids == null || heldCapturedPmids == null) return { allowed: false, judgedCount, sampledCount, exceedsMaxLostHits: false,
    reason: '最良候補と保留候補の既知シード捕捉を比較できません（未測定）。採用できません。' };
  const missingSeeds = bestCapturedPmids.filter((pmid) => !heldCapturedPmids.includes(pmid));
  if (missingSeeds.length) return { allowed: false, judgedCount, sampledCount, exceedsMaxLostHits: false,
    reason: `最良候補が捕捉している既知シードを失うため採用できません（PMID: ${missingSeeds.join(', ')}）。` };
  if (impact.lostHits <= threshold) {
    if (sampledCount >= impact.lostHits && judgedCount >= sampledCount) return { allowed: true, judgedCount, sampledCount, exceedsMaxLostHits: false, reason: null };
    return { allowed: false, judgedCount, sampledCount, exceedsMaxLostHits: false,
      reason: `失う集合 ${impact.lostHits} 件のうち exclude と判定して保存したのは ${judgedCount} 件です（あと ${impact.lostHits - judgedCount} 件の確認が必要です）。` };
  }
  const sampledPmids = impact.sample?.pmids ?? impact.inspected.map((paper) => paper.pmid);
  const missingBibliography = sampledPmids.filter((pmid) => !impact.inspected.some((paper) => paper.pmid === pmid));
  if (missingBibliography.length) return { allowed: false, judgedCount, sampledCount, exceedsMaxLostHits: false,
    reason: `抽出した標本 ${sampledPmids.length} 件のうち ${missingBibliography.length} 件の書誌が未取得です。全件の書誌取得と exclude 判定の保存が必要です。` };
  const unjudgedCount = sampledPmids.filter((pmid) => decisions?.[pmid]?.status !== 'saved'
    || decisions[pmid]?.decision !== 'exclude').length;
  if (sampledPmids.length > 0 && unjudgedCount === 0) return { allowed: true, judgedCount, sampledCount, exceedsMaxLostHits: false, reason: null };
  return { allowed: false, judgedCount, sampledCount, exceedsMaxLostHits: false,
    reason: `標本 ${sampledPmids.length} 件のうち ${sampledPmids.length - unjudgedCount} 件しか判定されていません（あと ${unjudgedCount} 件の判定が必要です。集合全体では残り ${impact.lostHits - judgedCount} 件が未確認のままです）。` };
}
