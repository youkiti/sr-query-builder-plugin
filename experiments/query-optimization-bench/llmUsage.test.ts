/** @jest-environment node */
import { createLlmUsageTracker } from './llmUsage';

test('トークンとコストを積算し、失敗呼び出しは calls だけ増やして tokens は加算しない', () => {
  const tracker = createLlmUsageTracker();
  tracker.record('gemini-2.5-pro', 1_000_000, 1_000_000); // $1.25 + $10.00
  tracker.record('gemini-2.5-pro', null, null); // 失敗呼び出し
  expect(tracker.usage).toEqual({ calls: 2, tokensIn: 1_000_000, tokensOut: 1_000_000, costUsd: 11.25, unpricedCalls: 0 });
});

test('価格表に無いモデルが 1 回でもあれば costUsd は恒久的に null（unpricedCalls に数える）', () => {
  const tracker = createLlmUsageTracker();
  tracker.record('gemini-2.5-pro', 1000, 1000);
  expect(tracker.usage.costUsd).not.toBeNull();
  tracker.record('unknown-model', 500, 500);
  expect(tracker.usage.costUsd).toBeNull();
  expect(tracker.usage.unpricedCalls).toBe(1);
  // 未価格化のあとに価格表内のモデルを呼んでも null から回復しない。
  tracker.record('gemini-2.5-pro', 1000, 1000);
  expect(tracker.usage.costUsd).toBeNull();
  expect(tracker.usage.calls).toBe(3);
  expect(tracker.usage.tokensIn).toBe(2500);
});
