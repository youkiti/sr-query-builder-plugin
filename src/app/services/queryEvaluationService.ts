import { checkSearchLines, type LineHitResult } from '@/features/validation/checkSearchLines';
import { checkFinalQuery, type FinalQueryResult } from '@/features/validation/checkFinalQuery';
import { expandFormula } from '@/features/validation/expandFormula';
import type { EutilsDeps } from '@/lib/ncbi';
import type { PubmedFormula } from '@/lib/search-formula-md';
import { nowIso } from '@/utils/iso8601';

export type MeasurementStatus = 'success' | 'failure';

export type EvaluatedLine = Omit<LineHitResult, 'hitCount' | 'error'> & (
  | { status: 'success'; hitCount: number; error: null }
  | { status: 'failure'; hitCount: null; error: string }
);

export type EvaluatedFinalQuery =
  | (Omit<FinalQueryResult, 'captureRate'> & {
      status: 'success';
      error: null;
      /** 成功時の null はシード 0 件による未計測だけを表す。 */
      captureRate: number | null;
    })
  | {
      status: 'failure';
      error: string;
      /** 展開自体が失敗した場合だけ null。通信失敗時は展開済みの式を保持する。 */
      finalQuery: string | null;
      totalHits: null;
      captureRate: null;
      capturedPmids: null;
      missedPmids: null;
    };

export interface QueryEvaluation {
  /** ブロック順・ID・式・結合構造を含む固定入力の SHA-256。 */
  fingerprint: string;
  /** 全計測の終了時刻（ISO 8601）。 */
  measuredAt: string;
  status: MeasurementStatus;
  seedPmids: string[];
  lineHits: EvaluatedLine[];
  finalQuery: EvaluatedFinalQuery;
}

export interface QueryEvaluationDeps {
  eutils: EutilsDeps;
  now?: () => string;
}

/**
 * 式と適格判定済みの固定シード PMID を実測する。保存先・store を持たず、結果だけを返す。
 * 既存の行計測・最終式検証に厳密な件数検査を伝播し、測定失敗を実測 0 件と区別する。
 */
export async function evaluateQuery(
  formula: PubmedFormula,
  seedPmids: readonly string[],
  deps: QueryEvaluationDeps
): Promise<QueryEvaluation> {
  // 待機中に呼び出し元が入力を変更しても、fingerprint と計測対象を一致させる。
  const fixedFormula: PubmedFormula = {
    blocks: formula.blocks.map(({ id, expression, isCombination }) => ({ id, expression, isCombination })),
    combinationExpression: formula.combinationExpression,
  };
  const fixedSeeds = [...new Set(seedPmids)];
  const bytes = new TextEncoder().encode(JSON.stringify(fixedFormula));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const fingerprint = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const eutils = { ...deps.eutils, strictCounts: true };
  const lines = await checkSearchLines(fixedFormula, eutils);
  const lineHits: EvaluatedLine[] = lines.map((line) => line.error === null
    ? { ...line, status: 'success', error: null }
    : { ...line, status: 'failure', hitCount: null, error: line.error });
  let finalQuery: EvaluatedFinalQuery;
  let expandedQuery: string | null = null;
  try {
    expandedQuery = expandFormula(fixedFormula);
    const lastBlock = fixedFormula.blocks[fixedFormula.blocks.length - 1];
    const lastLine = lines[lines.length - 1];
    const precomputed = lastBlock?.isCombination && lastLine?.blockId === lastBlock.id
      && lastLine.error === null && lastLine.expandedQuery === expandedQuery
      ? { expandedQuery: lastLine.expandedQuery, hitCount: lastLine.hitCount }
      : undefined;
    const measured = await checkFinalQuery(fixedFormula, fixedSeeds, eutils, precomputed);
    finalQuery = {
      ...measured,
      captureRate: fixedSeeds.length === 0 ? null : measured.captureRate,
      status: 'success',
      error: null,
    };
  } catch (err) {
    finalQuery = {
      status: 'failure',
      error: err instanceof Error ? err.message : String(err),
      finalQuery: expandedQuery,
      totalHits: null,
      captureRate: null,
      capturedPmids: null,
      missedPmids: null,
    };
  }
  return {
    fingerprint,
    measuredAt: (deps.now ?? nowIso)(),
    status: lineHits.some((line) => line.status === 'failure') || finalQuery.status === 'failure'
      ? 'failure' : 'success',
    seedPmids: fixedSeeds,
    lineHits,
    finalQuery,
  };
}
