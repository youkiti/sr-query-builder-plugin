/**
 * #/protocol 画面スモーク（Tier 2 + Tier 3 a11y）。
 * docs/ui-deep-test-plan.md Phase B。
 */

import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { injectAppStub, scenarioWithProject } from './fixtures/appStub';

const APP_URL = '/app/app.html#/protocol';

test.describe('app-protocol (#/protocol)', () => {
  test('プロジェクト未選択時: 警告文言が出て form は描画されない', async ({ page }) => {
    await injectAppStub(page, { authed: true });
    await page.goto(APP_URL);

    // protocolView は project 未選択時に `.protocol__warning` を出して early return する
    await expect(page.locator('.protocol__warning')).toBeVisible();
    await expect(page.locator('.protocol__warning')).toContainText('プロジェクトを選択');
    await expect(page.locator('.protocol__form')).toHaveCount(0);
  });

  test('manual モード: textarea が表示・file input は非表示', async ({ page }) => {
    await injectAppStub(page, scenarioWithProject());
    await page.goto(APP_URL);

    // 既定は manual
    const manualRadio = page.locator('input[name=sourceMode][value=manual]');
    await expect(manualRadio).toBeChecked();
    await expect(page.locator('textarea#inline')).toBeVisible();
    // file section は hidden 属性で隠れる
    await expect(page.locator('input#file')).toBeHidden();
  });

  test('file モード切替: file input が出て textarea は隠れる', async ({ page }) => {
    await injectAppStub(page, scenarioWithProject());
    await page.goto(APP_URL);

    await page.locator('input[name=sourceMode][value=file]').check();
    await expect(page.locator('input#file')).toBeVisible();
    await expect(page.locator('input#file')).toHaveAttribute('accept', /\.md.*\.markdown.*\.docx/);
    await expect(page.locator('textarea#inline')).toBeHidden();
  });

  test('file モードでファイル未選択 submit: error 文言が aria-live 領域に出る', async ({
    page,
  }) => {
    // manual の空文字は §4.2 で許容されるため、バリデーション失敗は file モードで起こす
    await injectAppStub(page, scenarioWithProject());
    await page.goto(APP_URL);

    await page.locator('input[name=sourceMode][value=file]').check();
    await page.locator('button.protocol__submit').click();
    await expect(page.locator('#protocol-error')).not.toBeEmpty();
  });

  test('manual モードで空のまま submit: §4.2 に従い LLM をスキップして空ブロックで #/blocks へ', async ({
    page,
  }) => {
    // 空文字 → extract-protocol skill は LLM を呼ばず空ドラフト（空ブロック 1 行）を返す。
    // provider.chat は呼ばれないが buildLlmProviderFactory が API キーを要求するため seed する。
    await injectAppStub(
      page,
      scenarioWithProject({ extraStorage: { 'apiKeys.gemini': 'dummy-key' } })
    );
    await page.goto(APP_URL);

    // 何も入力せず submit
    await page.locator('button.protocol__submit').click();

    // #/blocks へ遷移し、空ブロックが 1 件だけ表示される
    await expect(page).toHaveURL(/#\/blocks$/);
    await expect(page.locator('.blocks__item')).toHaveCount(1);
    // エラーは出ていない
    await expect(page.locator('#protocol-error')).toHaveCount(0);
  });

  test('a11y: axe violation zero', async ({ page }) => {
    await injectAppStub(page, scenarioWithProject());
    await page.goto(APP_URL);
    await expect(page.locator('.protocol__form')).toBeVisible();
    const result = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze();
    expect(result.violations, JSON.stringify(result.violations, null, 2)).toEqual([]);
  });
});
