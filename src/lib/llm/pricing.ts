/**
 * LLM のモデル別単価表と概算コスト計算。
 * requirements.md §10（コスト見積もり）に対応し、LLMApiLog.cost_estimate_usd を埋める。
 */

/** 入力・出力それぞれの USD / 100 万トークン単価 */
export interface ModelPricing {
  /** 入力 1M トークンあたりの USD */
  inputPerMillion: number;
  /** 出力 1M トークンあたりの USD */
  outputPerMillion: number;
}

/**
 * モデル名 → 単価の対応表。
 * 2026-06 時点の概算。価格改定時に要更新。
 * 未知のモデルは表に載せず、cost_estimate_usd は null のままにする。
 */
export const MODEL_PRICING: Readonly<Record<string, ModelPricing>> = {
  // Gemini 2.5 Pro: 入力 $1.25 / 出力 $10.00（per 1M tokens）
  'gemini-2.5-pro': { inputPerMillion: 1.25, outputPerMillion: 10.0 },
};

/**
 * tokens_in / tokens_out からモデル単価で概算コスト（USD）を計算する。
 * - 単価表に無いモデル、またはトークン数が両方とも null の場合は null を返す。
 * - 片方のトークン数だけ取れている場合は、取れている側のみで概算する。
 */
export function estimateCostUsd(
  model: string,
  tokensIn: number | null,
  tokensOut: number | null
): number | null {
  const pricing = MODEL_PRICING[model];
  if (pricing === undefined) {
    return null;
  }
  if (tokensIn === null && tokensOut === null) {
    return null;
  }
  const inputCost = ((tokensIn ?? 0) / 1_000_000) * pricing.inputPerMillion;
  const outputCost = ((tokensOut ?? 0) / 1_000_000) * pricing.outputPerMillion;
  return inputCost + outputCost;
}
