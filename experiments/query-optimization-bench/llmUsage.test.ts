/** @jest-environment node */
import { createLlmUsageTracker } from './llmUsage';

test('トークンとコストを積算し、失敗呼び出しは calls だけ増やして tokens は加算しない', () => {
  const tracker = createLlmUsageTracker();
  tracker.record('gemini-2.5-pro', 1_000_000, 1_000_000, true); // $1.25 + $10.00
  tracker.record('gemini-2.5-pro', null, null, false); // 失敗呼び出し
  expect(tracker.usage).toEqual({ calls: 2, tokensIn: 1_000_000, tokensOut: 1_000_000, costUsd: 11.25, unpricedCalls: 0, untrackedCalls: 0 });
});

test('価格表に無いモデルが 1 回でもあれば costUsd は恒久的に null（unpricedCalls に数える）', () => {
  const tracker = createLlmUsageTracker();
  tracker.record('gemini-2.5-pro', 1000, 1000, true);
  expect(tracker.usage.costUsd).not.toBeNull();
  tracker.record('unknown-model', 500, 500, true);
  expect(tracker.usage.costUsd).toBeNull();
  expect(tracker.usage.unpricedCalls).toBe(1);
  // 未価格化のあとに価格表内のモデルを呼んでも null から回復しない。
  tracker.record('gemini-2.5-pro', 1000, 1000, true);
  expect(tracker.usage.costUsd).toBeNull();
  expect(tracker.usage.calls).toBe(3);
  expect(tracker.usage.tokensIn).toBe(2500);
});


test('成功時にトークンが両方不明なら恒久的に欠測とし、失敗とは区別する', () => {
  const tracker = createLlmUsageTracker();
  tracker.record('unknown', null, null, false);
  expect(tracker.usage).toMatchObject({ calls: 1, costUsd: 0, untrackedCalls: 0, unpricedCalls: 0 });
  tracker.record('gemini-2.5-pro', null, null, true);
  tracker.record('gemini-2.5-pro', null, null, true);
  tracker.record('gemini-2.5-pro', 100, 100, true);
  expect(tracker.usage).toMatchObject({ calls: 4, costUsd: null, untrackedCalls: 2, unpricedCalls: 0 });
});
