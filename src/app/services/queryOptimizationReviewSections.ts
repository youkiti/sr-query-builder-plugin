import type { OptimizationTrial } from '@/features/formula/skills/optimizeQuery';
import type { OptimizationOutsideCheckState, QueryOptimizationRunState } from '../store';

export type ReviewSectionState = 'confirmed' | 'unmet' | 'needs_decision' | 'decided' | 'unconfirmed';
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
        if (lostHits != null && lostHits > count) deletion.lines.push(`残り ${lostHits - count} 件は未確認`);
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

export interface HeldCandidateAdoptionGate {
  allowed: boolean;
  /** 標本（inspected）のうち保存済み exclude の件数。maybe は未確認として扱う。 */
  judgedCount: number;
  /** 標本（inspected）の件数。 */
  sampledCount: number;
  /** allowed=false のとき、あと何件の確認・判定が必要かを含めた理由。allowed=true なら null。 */
  reason: string | null;
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
    return { allowed: false, judgedCount, sampledCount,
      reason: '失う集合を実測できていないため採用できません。' };
  }
  if (impact.failedMeasurements?.includes('lost_fetch')) return { allowed: false, judgedCount, sampledCount,
    reason: '失う集合の書誌を取得できていないため採用できません。' };
  const lostKnownSeeds = impact.inspected.filter((paper) => unjudgedSeedPmids.includes(paper.pmid))
    .map((paper) => paper.pmid);
  if (lostKnownSeeds.length) return { allowed: false, judgedCount, sampledCount,
    reason: `失う文献に未判定の既知シードがあるため採用できません（PMID: ${lostKnownSeeds.join(', ')}）。` };
  const includedPmids = impact.inspected.filter((paper) => decisions?.[paper.pmid]?.decision === 'include')
    .map((paper) => paper.pmid);
  if (includedPmids.length) {
    return { allowed: false, judgedCount, sampledCount,
      reason: `失う文献に include と判定した文献があるため採用できません（PMID: ${includedPmids.join(', ')}）。` };
  }
  const heldCapturedPmids = trial.after?.capturedPmids;
  if (bestCapturedPmids == null || heldCapturedPmids == null) return { allowed: false, judgedCount, sampledCount,
    reason: '最良候補と保留候補の既知シード捕捉を比較できません（未測定）。採用できません。' };
  const missingSeeds = bestCapturedPmids.filter((pmid) => !heldCapturedPmids.includes(pmid));
  if (missingSeeds.length) return { allowed: false, judgedCount, sampledCount,
    reason: `最良候補が捕捉している既知シードを失うため採用できません（PMID: ${missingSeeds.join(', ')}）。` };
  if (impact.lostHits <= threshold) {
    if (sampledCount >= impact.lostHits && judgedCount >= sampledCount) return { allowed: true, judgedCount, sampledCount, reason: null };
    return { allowed: false, judgedCount, sampledCount,
      reason: `失う集合 ${impact.lostHits} 件のうち exclude と判定して保存したのは ${judgedCount} 件です（あと ${impact.lostHits - judgedCount} 件の確認が必要です）。` };
  }
  const sampledPmids = impact.sample?.pmids ?? impact.inspected.map((paper) => paper.pmid);
  const missingBibliography = sampledPmids.filter((pmid) => !impact.inspected.some((paper) => paper.pmid === pmid));
  if (missingBibliography.length) return { allowed: false, judgedCount, sampledCount,
    reason: `抽出した標本 ${sampledPmids.length} 件のうち ${missingBibliography.length} 件の書誌が未取得です。全件の書誌取得と exclude 判定の保存が必要です。` };
  const unjudgedCount = sampledPmids.filter((pmid) => decisions?.[pmid]?.status !== 'saved'
    || decisions[pmid]?.decision !== 'exclude').length;
  if (sampledPmids.length > 0 && unjudgedCount === 0) return { allowed: true, judgedCount, sampledCount, reason: null };
  return { allowed: false, judgedCount, sampledCount,
    reason: `標本 ${sampledPmids.length} 件のうち ${sampledPmids.length - unjudgedCount} 件しか判定されていません（あと ${unjudgedCount} 件の判定が必要です。集合全体では残り ${impact.lostHits - judgedCount} 件が未確認のままです）。` };
}
