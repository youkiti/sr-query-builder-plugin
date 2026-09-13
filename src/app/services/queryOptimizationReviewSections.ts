import type { OptimizationOutsideCheckState, QueryOptimizationRunState } from '../store';

export type ReviewSectionState = 'confirmed' | 'unmet' | 'needs_decision' | 'unconfirmed';
export interface OptimizationReviewSection {
  key: 'known_capture' | 'hit_target' | 'outside_check' | 'deletion_impact';
  label: string;
  state: ReviewSectionState;
  lines: string[];
}

function decisionState(check: OptimizationOutsideCheckState | undefined, source: 'outside' | 'lost'): ReviewSectionState {
  const candidates = check?.candidates.filter((candidate) => candidate.source === source) ?? [];
  if (candidates.some((candidate) => check?.decisions[candidate.pmid]?.status !== 'saved')) return 'needs_decision';
  return candidates.some((candidate) => check?.decisions[candidate.pmid]?.decision === 'include') ? 'unmet' : 'confirmed';
}

/** 表示と保存で同じ判定を使う。取得した先頭の書誌と集合全体の件数を区別する。 */
export function buildOptimizationReviewSections(run: QueryOptimizationRunState): {
  sections: [OptimizationReviewSection, OptimizationReviewSection, OptimizationReviewSection, OptimizationReviewSection];
  unconfirmed: string[];
} {
  const known: OptimizationReviewSection = { key: 'known_capture', label: '既知文献の捕捉', state: 'unconfirmed', lines: [] };
  const hits: OptimizationReviewSection = { key: 'hit_target', label: '件数目標', state: 'unconfirmed', lines: [] };
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
  const total = measured?.totalHits;
  hits.lines.push(`最大件数 ${run.maxHits.toLocaleString()} 件に対して実測 ${total == null ? '未測定' : `${total.toLocaleString()} 件`}（${total == null ? '上限到達は未確認' : total <= run.maxHits ? '上限以下' : '上限超過'}）`);
  if (run.result) {
    if (seeds && captured) known.state = captured.length < seeds || measured?.missedPmids?.length ? 'unmet' : 'confirmed';
    if (total != null) hits.state = total <= run.maxHits ? 'confirmed' : 'unmet';
    const check = run.outsideCheck;
    const candidates = check?.candidates.filter((candidate) => candidate.source === 'outside') ?? [];
    if (check?.status === 'ready') {
      outside.state = decisionState(check, 'outside');
      if (!candidates.length) outside.lines.push(`拡張式の外側 ${check.marginHits ?? '未測定'} 件から判定候補は選ばれませんでした。網羅性の保証ではありません`);
      else {
        const included = candidates.filter((candidate) => check.decisions[candidate.pmid]?.status === 'saved'
          && check.decisions[candidate.pmid]?.decision === 'include').length;
        outside.lines.push(`外側の判定候補 ${candidates.length} 件、保存済み ${candidates.filter((candidate) => check.decisions[candidate.pmid]?.status === 'saved').length} 件`);
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
      deletion.lines.push(`保留した候補 ${held.length} 件の削除影響の確認`);
      for (const trial of held) {
        const count = trial.impact?.inspected.length ?? 0;
        const lostHits = trial.impact?.lostHits;
        deletion.lines.push(`保留候補 ${trial.candidateId}: 失う集合 ${lostHits ?? '未測定'} 件のうち書誌を確認できたのは先頭 ${count} 件`);
        if (lostHits != null && lostHits > count) deletion.lines.push(`残り ${lostHits - count} 件は未確認`);
        if (trial.impact?.error) deletion.lines.push(trial.impact.error);
      }
      if (deletion.state === 'unmet') deletion.lines.push('失う文献に include した文献があります。保護して再調整してください');
    }
  } else {
    outside.lines.push('実行結果がないため外側の確認は未確認です');
    deletion.lines.push('実行結果がないため削除影響の確認は未確認です');
  }
  return { sections, unconfirmed: sections.filter((section) => section.state !== 'confirmed')
    .map((section) => `${section.label}: ${section.lines.filter((line) => !line.startsWith('既知シードの捕捉は、')).join(' / ')}`) };
}
