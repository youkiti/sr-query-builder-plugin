import type { EutilsDeps } from '../../src/lib/ncbi/eutils';
import type { LlmProviderFactory } from '../../src/app/services/llmProviderService';
import { searchOutsideCandidates } from '../../src/app/services/expandService';
import type { ConfirmationAudit, RunResult } from './types';

const EMPTY = (status: ConfirmationAudit['status'], reason: string | null, extra: Partial<ConfirmationAudit> = {}): ConfirmationAudit => ({
  status, reason, marginHits: null, outsidePmids: [], lostInspectedPmids: [], total: 0,
  heldOutStudiesAmongCandidates: [], nonGoldCandidates: 0, ...extra,
});

/**
 * outside check（margin 探索）で「人が確認する必要がある候補」の件数だけを数える。
 * **候補は自動調整へフィードバックしない**（採否も readjustment もしない）。
 * gold PMID との対応付け（heldOutStudiesAmongCandidates / nonGoldCandidates）は、
 * 検索・LLM 呼び出しがすべて終わったあと、この集計のためだけに事後に行う
 * （searchOutsideCandidates の existingPmids には常にシード PMID のみを渡し、gold を渡さない）。
 */
export async function computeConfirmation(result: RunResult,
  protocol: { researchQuestion: string; inclusionCriteria: string; exclusionCriteria: string },
  seedPmids: readonly string[], deps: { eutils: EutilsDeps; llmFactory: LlmProviderFactory }): Promise<ConfirmationAudit> {
  const optimization = result.optimization;
  const best = optimization?.best;
  if (!best || !(optimization?.status === 'achieved' || optimization?.status === 'needs_review')) {
    return EMPTY('skipped', '有効な最良式が無いか、状態が achieved/needs_review ではありません');
  }
  const seedSet = new Set(seedPmids);
  const heldTrials = optimization.trials.filter((trial) => trial.kind === 'proposal' && trial.held);
  const lostInspectedPmids = [...new Set(heldTrials.flatMap((trial) => trial.impact?.inspected.map((item) => item.pmid) ?? []))]
    .filter((pmid) => !seedSet.has(pmid));

  let outside;
  try {
    outside = await searchOutsideCandidates({
      formula: best.formula,
      researchQuestion: protocol.researchQuestion,
      inclusionCriteria: protocol.inclusionCriteria,
      exclusionCriteria: protocol.exclusionCriteria,
      // シード PMID だけを既知集合として渡す。gold（held-out を含む）は絶対に渡さない
      // ―― outside check は自動調整の入力に gold を漏らさないための境界。
      existingPmids: seedSet,
      eutils: deps.eutils,
      llmFactory: deps.llmFactory,
    });
  } catch (err) {
    return EMPTY('error', err instanceof Error ? err.message : String(err), { lostInspectedPmids, total: lostInspectedPmids.length });
  }

  const outsidePmids = outside.candidates.map((candidate) => candidate.pmid);
  const combined = new Set([...outsidePmids, ...lostInspectedPmids]);
  const groups = result.denominator?.groups ?? [];
  const heldOutIds = new Set(result.denominator?.heldOut ?? []);
  // ここで初めて gold（held-out 群）へ対応付ける。自動調整・outside check の判断には一切使っていない。
  const heldOutStudiesAmongCandidates = groups.filter((group) => heldOutIds.has(group.id)).flatMap((group) => group.members)
    .filter((study) => study.pmids.some((pmid) => combined.has(pmid))).map((study) => study.studyId);
  const goldPmids = new Set(groups.flatMap((group) => group.pmids));
  const nonGoldCandidates = [...combined].filter((pmid) => !goldPmids.has(pmid)).length;

  return {
    status: 'ready', reason: null, marginHits: outside.marginHits, outsidePmids, lostInspectedPmids,
    total: combined.size, heldOutStudiesAmongCandidates, nonGoldCandidates,
  };
}
