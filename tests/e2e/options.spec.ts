/**
 * Options 画面のスモーク（Tier 2 + Tier 3 a11y）。
 * docs/ui-deep-test-plan.md §Phase G — MVP 実装向けケース。
 */

import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { injectOptionsStub } from './fixtures/optionsStub';

const OPTIONS_URL = '/options/options.html';

test.describe('options (MVP 現実装)', () => {
  test('Opt-1: ストレージ空 → 両 input 空 + 未設定 status', async ({ page }) => {
    await injectOptionsStub(page);
    await page.goto(OPTIONS_URL);

    // 読み込み完了を待つ（初期の "読み込み中…" が差し替わるまで）
    await expect(page.locator('#options-status')).toHaveText(
      'Gemini: 未設定 / OpenRouter: 未設定 / NCBI: 未設定（3 req/s 枠）'
    );
    await expect(page.locator('#gemini-api-key')).toHaveValue('');
    await expect(page.locator('#ncbi-api-key')).toHaveValue('');
  });

  test('Opt-2: 両キー保存済み → 生値復元 + 保存済み status', async ({ page }) => {
    await injectOptionsStub(page, {
      storage: {
        'apiKeys.gemini': 'gem-test-123',
        'apiKeys.ncbi': 'ncbi-test-456',
      },
    });
    await page.goto(OPTIONS_URL);

    await expect(page.locator('#options-status')).toHaveText(
      'Gemini: 保存済み / OpenRouter: 未設定 / NCBI: 保存済み'
    );
    // 現実装は raw 値で復元（マスクはしない）
    await expect(page.locator('#gemini-api-key')).toHaveValue('gem-test-123');
    await expect(page.locator('#ncbi-api-key')).toHaveValue('ncbi-test-456');
  });

  test('Opt-3: 空のまま保存ボタン → "保存しました。"', async ({ page }) => {
    await injectOptionsStub(page);
    await page.goto(OPTIONS_URL);

    await expect(page.locator('#options-status')).toContainText('未設定');
    await page.locator('#save-keys').click();
    await expect(page.locator('#options-status')).toHaveText('保存しました。');
  });

  test('input は type=password + autocomplete=off', async ({ page }) => {
    await injectOptionsStub(page);
    await page.goto(OPTIONS_URL);

    await expect(page.locator('#gemini-api-key')).toHaveAttribute('type', 'password');
    await expect(page.locator('#gemini-api-key')).toHaveAttribute('autocomplete', 'off');
    await expect(page.locator('#ncbi-api-key')).toHaveAttribute('type', 'password');
    await expect(page.locator('#ncbi-api-key')).toHaveAttribute('autocomplete', 'off');
  });

  test('a11y: axe violation zero', async ({ page }) => {
    await injectOptionsStub(page);
    await page.goto(OPTIONS_URL);
    await expect(page.locator('#options-status')).not.toHaveText('読み込み中…');
    const result = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze();
    expect(result.violations, JSON.stringify(result.violations, null, 2)).toEqual([]);
  });
});
