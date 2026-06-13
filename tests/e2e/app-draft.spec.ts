/**
 * #/draft 画面スモーク（Tier 2 + Tier 3 a11y）。
 * docs/ui-deep-test-plan.md Phase B。
 */

import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { injectAppStub } from './fixtures/appStub';
import { fullStateScenario, FULL_APP_STATE } from './fixtures/scenarios/fullState';

const APP_URL = '/app/app.html#/draft';

test.describe('app-draft (#/draft)', () => {
  test('既存 formula 無し相当: 「生成する」ボタンが出る', async ({ page }) => {
    await injectAppStub(
      page,
      fullStateScenario({
        preloadedState: {
          ...(await import('./fixtures/scenarios/fullState')).FULL_APP_STATE,
          currentFormulaVersionId: null,
          currentFormulaMarkdown: null,
        },
      })
    );
    await page.goto(APP_URL);

    // currentFormulaVersionId が null かつ blocks 承認済みなので /draft は通る
    const btn = page.locator('.draft__actions button');
    await expect(btn).toHaveText(/生成する/);
    // 既存 formula の <pre> は出ない
    await expect(page.locator('.draft__formula')).toHaveCount(0);
  });

  test('既存 formula 有り: 「再生成する」ボタンと pre が両方出る', async ({ page }) => {
    await injectAppStub(page, fullStateScenario());
    await page.goto(APP_URL);

    const btn = page.locator('.draft__actions button');
    await expect(btn).toHaveText(/再生成する/);
    await expect(page.locator('.draft__formula')).toBeVisible();
    await expect(page.locator('.draft__formula')).toContainText('ARDS');
  });

  test('draftRun=running 中: ボタン無効 + 進捗と経過時間が出る', async ({ page }) => {
    await injectAppStub(
      page,
      fullStateScenario({
        preloadedState: {
          ...FULL_APP_STATE,
          draftRun: {
            status: 'running',
            progressLabel: 'MeSH を提案中（ブロック 1/2）',
            startedAtMs: Date.now() - 65_000,
            error: null,
          },
        },
      })
    );
    await page.goto(APP_URL);

    const btn = page.locator('.draft__actions button');
    await expect(btn).toBeDisabled();
    await expect(btn).toHaveText('生成中…');
    const status = page.locator('.draft__status');
    await expect(status).toContainText('MeSH を提案中（ブロック 1/2）');
    await expect(status).toContainText('経過 1分');
    // 1 秒ごとの ticker で経過表示が更新される
    const initial = await status.textContent();
    await expect
      .poll(async () => status.textContent(), { timeout: 5_000 })
      .not.toBe(initial);
  });

  test('draftRun=error: エラーボックスが見える状態で表示される', async ({ page }) => {
    await injectAppStub(
      page,
      fullStateScenario({
        preloadedState: {
          ...FULL_APP_STATE,
          draftRun: {
            status: 'error',
            progressLabel: '',
            startedAtMs: Date.now() - 10_000,
            error: 'Gemini API failed: HTTP 503',
          },
        },
      })
    );
    await page.goto(APP_URL);

    const errorBox = page.locator('.draft__error');
    await expect(errorBox).toBeVisible();
    await expect(errorBox).toContainText('生成に失敗しました');
    await expect(errorBox).toContainText('HTTP 503');
    // 失敗後は再試行できる
    await expect(page.locator('.draft__actions button')).toBeEnabled();
  });

  test('a11y: axe violation zero', async ({ page }) => {
    await injectAppStub(page, fullStateScenario());
    await page.goto(APP_URL);
    await expect(page.locator('.draft__actions button')).toBeVisible();
    const result = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze();
    expect(result.violations, JSON.stringify(result.violations, null, 2)).toEqual([]);
  });
});
