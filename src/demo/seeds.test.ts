import { applyDemoSeed, DEMO_SEED_NAMES, DEMO_PROJECT_TITLE } from './seeds';
import { installDemoFetch } from './fetchMock';
import { installDemoIdentity } from './identity';

/**
 * seeds.ts の各プリセットが例外なく完走し、返す `Partial<AppState>` が
 * scenario.ts の不変条件（捕捉率 80% → 100% 等）と一致することを確認する。
 * Sheets への実書き込み自体は sheetStore.test.ts / eutilsMock.test.ts 側で検証済み。
 */
beforeAll(() => {
  installDemoIdentity();
  installDemoFetch();
});

describe('DEMO_PROJECT_TITLE', () => {
  it('架空データであることが分かる文言を含む', () => {
    expect(DEMO_PROJECT_TITLE).toContain('デモ');
  });
});

describe('applyDemoSeed', () => {
  it('未知の名前は目立つエラーを投げる', async () => {
    await expect(applyDemoSeed('存在しない章')).rejects.toThrow(/未知の demoSeed/);
  });

  it.each(DEMO_SEED_NAMES)('%s は例外なく完走する', async (name) => {
    await expect(applyDemoSeed(name)).resolves.toBeDefined();
  });

  it('04-protocol はプロトコル未入力（差分なし）を返す', async () => {
    const state = await applyDemoSeed('04-protocol');
    expect(state.protocolDraft).toBeUndefined();
    expect(state.blocksDraft).toBeUndefined();
  });

  it('05-blocks は未承認の protocolDraft/blocksDraft を返す', async () => {
    const state = await applyDemoSeed('05-blocks');
    expect(state.protocolDraftPersisted).toBe(false);
    expect(state.blocksDraft?.blocks.map((b) => b.blockLabel)).toEqual(['ARDS', 'ECMO', 'RCT フィルタ']);
  });

  it('08-validation は捕捉率 80% の検証結果を返す', async () => {
    const state = await applyDemoSeed('08-validation');
    expect(state.validationResult?.summary.finalQuery.captureRate).toBeCloseTo(0.8, 10);
    expect(state.validationResult?.summary.finalQuery.missedPmids).toEqual(['90000005']);
  });

  it('09-expand は 08-validation と同じ状態を返す', async () => {
    const state = await applyDemoSeed('09-expand');
    expect(state.validationResult?.summary.finalQuery.captureRate).toBeCloseTo(0.8, 10);
  });

  it('10-edit は境界事例 include 後の捕捉率低下（4/6）を返す', async () => {
    const state = await applyDemoSeed('10-edit');
    expect(state.validationResult?.summary.finalQuery.captureRate).toBeCloseTo(4 / 6, 10);
    expect(state.validationResult?.summary.finalQuery.missedPmids.sort()).toEqual([
      '90000005',
      '90000006',
    ]);
  });

  it('11-export は捕捉率 100% の検証結果を返す', async () => {
    const state = await applyDemoSeed('11-export');
    expect(state.validationResult?.summary.finalQuery.captureRate).toBe(1);
  });

  it('13-history は 11-export と同じ状態を返す', async () => {
    const state = await applyDemoSeed('13-history');
    expect(state.validationResult?.summary.finalQuery.captureRate).toBe(1);
  });
});
