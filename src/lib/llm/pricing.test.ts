import { estimateCostUsd, MODEL_PRICING } from './pricing';

describe('estimateCostUsd', () => {
  test('gemini-2.5-pro は入力 $1.25 / 出力 $10.00 per 1M で概算する', () => {
    // 1,000,000 入力 + 500,000 出力 = 1.25 + 5.00 = 6.25 USD
    expect(estimateCostUsd('gemini-2.5-pro', 1_000_000, 500_000)).toBeCloseTo(6.25, 10);
  });

  test('単価表に無いモデルは null', () => {
    expect(estimateCostUsd('gpt-5', 1000, 1000)).toBeNull();
  });

  test('トークン数が両方 null なら null', () => {
    expect(estimateCostUsd('gemini-2.5-pro', null, null)).toBeNull();
  });

  test('片方だけ取れていれば取れた側のみで概算する', () => {
    // 入力のみ 1M → 1.25 USD
    expect(estimateCostUsd('gemini-2.5-pro', 1_000_000, null)).toBeCloseTo(1.25, 10);
    // 出力のみ 1M → 10.00 USD
    expect(estimateCostUsd('gemini-2.5-pro', null, 1_000_000)).toBeCloseTo(10.0, 10);
  });

  test('既定モデル gemini-2.5-pro が単価表に存在する', () => {
    expect(MODEL_PRICING['gemini-2.5-pro']).toEqual({
      inputPerMillion: 1.25,
      outputPerMillion: 10.0,
    });
  });
});
