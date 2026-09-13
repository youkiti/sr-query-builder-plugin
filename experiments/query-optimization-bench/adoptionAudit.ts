import type { PubmedFormula } from '../../src/lib/search-formula-md';
import type { EutilsDeps } from '../../src/lib/ncbi/eutils';
import { expandFormula } from '../../src/features/validation/expandFormula';
import { createEvalFetch, evaluateSearch } from './ncbiEval';
import { calculateMetrics, compareMetrics } from './metrics';
import type { AdoptionAudit, AdoptionTrialAudit, Metrics, RunResult } from './types';

interface Measured {
  hits: number | null;
  metrics: Metrics | null;
  error?: string;
}

/**
 * C0 → C1 の間に採用されたすべての候補について、直前の基準式（その候補より前で最後に
 * 採用された候補、無ければ C0）と比べて held-out 捕捉を失っていないかを監査する。
 * 「有害な採用」= 採用されたのに held-out を 1 件でも失った候補。
 *
 * C0 の測定・既存の rejectedCandidates（却下候補の事後計測）は再利用し、
 * 同じ gold クエリを重複して投げない。manualReviewPending のときは採点そのものを保留する
 * （metrics を作らず、harmfulAdopted も null にする）。
 */
export async function computeAdoptionAudit(result: RunResult, eutils: EutilsDeps): Promise<AdoptionAudit> {
  const proposals = result.optimization?.trials.filter((trial) => trial.kind === 'proposal') ?? [];
  const manualReviewPending = result.denominator?.manualReviewPending ?? false;
  if (proposals.length === 0) {
    return { adopted: 0, harmfulAdopted: manualReviewPending ? null : 0, trials: [] };
  }
  if (!result.denominator) throw new Error(`${result.id}: 保存済みの分母がありません`);
  const { groups, heldOut } = result.denominator;
  const pmids = [...new Set(groups.flatMap((group) => group.pmids))];
  const dated = { ...eutils, fetch: createEvalFetch(result.searchDate, eutils.fetch, () => undefined) };

  const cache = new Map<string, Measured>();
  const c0 = result.conditions.C0;
  if (c0) cache.set('C0', { hits: c0.measurement.status === 'success' ? c0.measurement.hits : null, metrics: c0.metrics });
  // 最後に採用された候補は best.formula と同一のはずなので、C1 の測定結果をそのまま再利用する。
  const lastAcceptedId = [...proposals].reverse().find((trial) => trial.accepted)?.candidateId;
  const c1 = result.conditions.C1;
  if (lastAcceptedId && c1) cache.set(lastAcceptedId, { hits: c1.measurement.status === 'success' ? c1.measurement.hits : null, metrics: c1.metrics });

  const measure = async (candidateId: string, formula: PubmedFormula): Promise<Measured> => {
    const cached = cache.get(candidateId);
    if (cached) return cached;
    const rejected = result.rejectedCandidates?.find((candidate) => candidate.candidateId === candidateId && !candidate.error);
    if (rejected) {
      const reused: Measured = { hits: rejected.hits, metrics: rejected.metrics };
      cache.set(candidateId, reused);
      return reused;
    }
    let measured: Measured;
    try {
      const measurement = await evaluateSearch(expandFormula(formula), pmids, dated);
      const metrics = measurement.status === 'success' && !manualReviewPending
        ? calculateMetrics(groups, heldOut, measurement.capturedPmids, measurement.hits) : null;
      measured = measurement.status === 'success' ? { hits: measurement.hits, metrics } : { hits: null, metrics: null, error: measurement.error };
    } catch (err) {
      measured = { hits: null, metrics: null, error: err instanceof Error ? err.message : String(err) };
    }
    cache.set(candidateId, measured);
    return measured;
  };

  let priorId = 'C0';
  let priorFormula = c0?.formula;
  let adopted = 0;
  let harmfulAdopted: number | null = manualReviewPending ? null : 0;
  const trials: AdoptionTrialAudit[] = [];
  for (const trial of proposals) {
    const before: Measured = priorFormula ? await measure(priorId, priorFormula) : { hits: null, metrics: null, error: 'C0 の式がありません' };
    const after = await measure(trial.candidateId, trial.formula);
    const comparison = before.metrics && after.metrics ? compareMetrics(before.metrics, after.metrics) : null;
    trials.push({
      candidateId: trial.candidateId, accepted: trial.accepted, held: trial.held ?? false,
      hitsBefore: before.hits, hitsAfter: after.hits,
      lostHeldOut: comparison?.lostHeldOut ?? [], gainedHeldOut: comparison?.gainedHeldOut ?? [],
      ...(after.error ? { error: after.error } : {}),
    });
    if (trial.accepted) {
      adopted += 1;
      if (harmfulAdopted !== null && comparison && comparison.lostHeldOut.length > 0) harmfulAdopted += 1;
      priorId = trial.candidateId;
      priorFormula = trial.formula;
    }
  }
  return { adopted, harmfulAdopted, trials };
}
