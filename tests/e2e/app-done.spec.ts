/**
 * #/done 画面スモーク（Tier 2 + Tier 3 a11y）。
 * docs/ui-deep-test-plan.md Phase B。
 */

import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { injectAppStub } from './fixtures/appStub';
import { fullStateScenario } from './fixtures/scenarios/fullState';

const APP_URL = '/app/app.html#/done';

test.describe('app-done (#/done)', () => {
  test('外部 DB リンクが target=_blank で 4 件出る', async ({ page }) => {
    await injectAppStub(page, fullStateScenario());
    await page.goto(APP_URL);

    await expect(page.locator('#app-content h2')).toHaveText('完了');
    const links = page.locator('.done__links a');
    await expect(links).toHaveCount(4);
    const count = await links.count();
    for (let i = 0; i < count; i++) {
      await expect(links.nth(i)).toHaveAttribute('target', '_blank');
    }
    // Embase (Dialog) 案内が含まれる
    await expect(page.locator('.done__links a', { hasText: 'Embase (Dialog)' })).toHaveCount(1);
    // nbib DL 誘導メッセージ（PubMed リンクも出る）
    await expect(page.locator('.done__pubmed-link a')).toBeVisible();
  });

  test('a11y: axe violation zero', async ({ page }) => {
    await injectAppStub(page, fullStateScenario());
    await page.goto(APP_URL);
    await expect(page.locator('#app-content h2')).toHaveText('完了');
    const result = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze();
    expect(result.violations, JSON.stringify(result.violations, null, 2)).toEqual([]);
  });
});
