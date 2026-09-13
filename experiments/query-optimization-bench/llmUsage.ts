import { estimateCostUsd } from '../../src/lib/llm/pricing';
import type { LlmUsage } from './types';

/**
 * LLM 呼び出し 1 回ごとの使用量を積み上げる。run.ts / freezeC0.ts の両方で
 * `loggedFactory` の `onUsage` から呼ぶことを想定する。失敗した呼び出しも
 * calls に数え、tokens は null のまま加算しない（0 として扱わない）。
 * 1 回でも価格表に無いモデルを含めば、以後 costUsd は恒久的に null のまま。
 */
export function createLlmUsageTracker(): { usage: LlmUsage; record: (model: string, tokensIn: number | null, tokensOut: number | null) => void } {
  const usage: LlmUsage = { calls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, unpricedCalls: 0 };
  return {
    usage,
    record: (model, tokensIn, tokensOut) => {
      usage.calls += 1;
      if (tokensIn != null) usage.tokensIn += tokensIn;
      if (tokensOut != null) usage.tokensOut += tokensOut;
      // 失敗呼び出し（tokens 両方 null）は課金対象のトークンが無いので 0 円加算とし、
      // 「価格表に無いモデル」判定の対象にはしない（1 回の失敗が run 全体のコストを恒久的に不明にしない）。
      if (tokensIn === null && tokensOut === null) return;
      const cost = estimateCostUsd(model, tokensIn, tokensOut);
      if (cost === null) {
        usage.unpricedCalls += 1;
        usage.costUsd = null;
      } else if (usage.costUsd !== null) {
        usage.costUsd += cost;
      }
    },
  };
}
