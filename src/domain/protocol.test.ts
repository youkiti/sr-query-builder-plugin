import { MAX_BLOCK_COUNT, MIN_BLOCK_COUNT } from './protocol';

describe('block count constraints', () => {
  test('MIN は 1、MAX は 5（SPIDER フレームワーク上限）', () => {
    expect(MIN_BLOCK_COUNT).toBe(1);
    expect(MAX_BLOCK_COUNT).toBe(5);
  });
});
