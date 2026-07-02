/**
 * #/blocks 画面スモーク（Tier 2 + Tier 3 a11y）。
 * docs/ui-deep-test-plan.md Phase B。
 */

import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { injectAppStub, scenarioWithProject } from './fixtures/appStub';
import { fullStateScenario, FULL_PROTOCOL_DRAFT } from './fixtures/scenarios/fullState';

const APP_URL = '/app/app.html#/blocks';

test.describe('app-blocks (#/blocks)', () => {
  test('プロトコル未入力: guard プレースホルダ', async ({ page }) => {
    await injectAppStub(page, scenarioWithProject());
    await page.goto(APP_URL);

    await expect(page.locator('#app-content .view__placeholder')).toBeVisible();
  });

  test('blocksDraft あり: 2 ブロックが li に並ぶ', async ({ page }) => {
    await injectAppStub(page, fullStateScenario());
    await page.goto(APP_URL);

    await expect(page.locator('.blocks__item')).toHaveCount(2);
    await expect(page.locator('.blocks__combination-input')).toHaveValue('#1 AND #2');
  });

  test('blocksDraft 空配列: add ボタンは押せる、approve は disabled でない（空配列は有効式）', async ({ page }) => {
    await injectAppStub(page, scenarioWithProject({
      preloadedState: {
        project: (await import('./fixtures/appStub')).PROJECT_FIXTURE,
        protocolDraft: FULL_PROTOCOL_DRAFT,
        blocksDraft: { blocks: [], combinationExpression: '' },
      },
    }));
    await page.goto(APP_URL);

    await expect(page.locator('.blocks__item')).toHaveCount(0);
    // add ボタンは常に少なくとも MIN までは有効
    await expect(page.locator('.blocks__add-row button')).toBeEnabled();
  });

  test('「下書きとして保存」で chrome.storage に保存され未承認バナーが出る', async ({ page }) => {
    await injectAppStub(page, fullStateScenario());
    await page.goto(APP_URL);

    // ブロック名を編集してから保存
    const labelInput = page.locator('.blocks__item').first().locator('input').first();
    await labelInput.fill('P (編集済み)');
    await page.getByRole('button', { name: '下書きとして保存' }).click();

    await expect(page.locator('.blocks__draft-notice')).toContainText('未承認の下書きがあります');
    const backup = await page.evaluate(
      () =>
        (window as unknown as { __appStubData: Record<string, unknown> }).__appStubData[
          'blocksDraftBackup'
        ] as { projectId: string; draft: { blocks: Array<{ blockLabel: string }> } } | undefined
    );
    expect(backup?.projectId).toBe('pid-fixture-1');
    expect(backup?.draft.blocks[0]?.blockLabel).toBe('P (編集済み)');
  });

  test('保存済み下書きはリロード相当の起動（hydrate）で復元される', async ({ page }) => {
    // 「保存後にリロード」を、バックアップ入り chrome.storage での新規起動として再現する。
    // preloadedState の blocksDraft（2 ブロック）より hydrate のバックアップ（1 ブロック）が優先される
    await injectAppStub(page, fullStateScenario({
      extraStorage: {
        blocksDraftBackup: {
          projectId: 'pid-fixture-1',
          savedAt: '2026-07-01T00:00:00Z',
          draft: {
            blocks: [
              { blockLabel: 'P (編集済み)', description: 'ARDS', aiGenerated: false, note: '' },
            ],
            combinationExpression: '#1',
          },
        },
      },
    }));
    await page.goto(APP_URL);

    await expect(page.locator('.blocks__draft-notice')).toContainText('未承認の下書きがあります');
    await expect(page.locator('.blocks__item')).toHaveCount(1);
    await expect(page.locator('.blocks__item').first().locator('input').first()).toHaveValue(
      'P (編集済み)'
    );
  });

  test('a11y: axe violation zero', async ({ page }) => {
    await injectAppStub(page, fullStateScenario());
    await page.goto(APP_URL);
    await expect(page.locator('.blocks__item').first()).toBeVisible();
    const result = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze();
    expect(result.violations, JSON.stringify(result.violations, null, 2)).toEqual([]);
  });
});
