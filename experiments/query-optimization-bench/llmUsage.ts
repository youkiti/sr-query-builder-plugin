import { estimateCostUsd } from '../../src/lib/llm/pricing';
import type { LlmUsage } from './types';

/**
 * LLM 呼び出し 1 回ごとの使用量を積み上げる。
 * `loggedFactory` の `onUsage` から呼ぶ。失敗した呼び出しも
 * calls に数え、tokens は null のまま加算しない（0 として扱わない）。
 * 1 回でも価格表に無いモデルを含めば、以後 costUsd は恒久的に null のまま。
 */
export function createLlmUsageTracker(): { usage: LlmUsage; record: (model: string, tokensIn: number | null, tokensOut: number | null, succeeded: boolean) => void } {
  const usage: LlmUsage = { calls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, unpricedCalls: 0, untrackedCalls: 0 };
  return {
    usage,
    record: (model, tokensIn, tokensOut, succeeded) => {
      usage.calls += 1;
      if (!succeeded) return;
      if (tokensIn != null) usage.tokensIn += tokensIn;
      if (tokensOut != null) usage.tokensOut += tokensOut;
      // 成功してもトークン数が返らなければ、費用を過小評価せず欠測として残す。
      if (tokensIn === null && tokensOut === null) {
        usage.untrackedCalls += 1;
        usage.costUsd = null;
        return;
      }
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
