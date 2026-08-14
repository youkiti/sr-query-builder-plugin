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
    const btn = page.locator('.draft__generate');
    await expect(btn).toHaveText(/生成して検証する/);
    // 既存 formula の <pre> は出ない
    await expect(page.locator('.draft__formula')).toHaveCount(0);
  });

  test('既存 formula 有り: 「再生成して再検証する」ボタンと pre が両方出る', async ({ page }) => {
    await injectAppStub(page, fullStateScenario());
    await page.goto(APP_URL);

    const btn = page.locator('.draft__generate');
    await expect(btn).toHaveText(/再生成して再検証する/);
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
            phase: 'generating',
            progressLabel: 'MeSH を提案中（ブロック 1/2）',
            startedAtMs: Date.now() - 65_000,
            error: null,
            blockHits: [],
          },
        },
      })
    );
    await page.goto(APP_URL);

    const btn = page.locator('.draft__generate');
    await expect(btn).toBeDisabled();
    await expect(btn).toHaveText('実行中…');
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
            phase: 'generating',
            progressLabel: '',
            startedAtMs: Date.now() - 10_000,
            error: 'Gemini API failed: HTTP 503',
            blockHits: [],
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
    await expect(page.locator('.draft__generate')).toBeEnabled();
  });

  test('a11y: axe violation zero', async ({ page }) => {
    await injectAppStub(page, fullStateScenario());
    await page.goto(APP_URL);
    await expect(page.locator('.draft__generate')).toBeVisible();
    const result = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze();
    expect(result.violations, JSON.stringify(result.violations, null, 2)).toEqual([]);
  });
});

test.describe('#/draft 再検証・破棄確認の入口（issue #40）', () => {
  test('検証成功後（エラー無し）でも「検証のみ再実行」ボタンが常に出る（症状 A）', async ({ page }) => {
    await injectAppStub(page, fullStateScenario());
    await page.goto(APP_URL);

    await expect(page.locator('.draft__generate')).toBeVisible();
    await expect(page.locator('.draft__revalidate')).toBeVisible();
  });

  test('手編集版（user_edit）で再生成を押すと破棄確認が出て、「やめる」で式は変わらない（症状 B）', async ({
    page,
  }) => {
    await injectAppStub(
      page,
      fullStateScenario({
        preloadedState: { ...FULL_APP_STATE, currentFormulaCreatedBy: 'user_edit' },
      })
    );
    await page.goto(APP_URL);

    const confirm = page.locator('.draft__discard-confirm');
    await expect(confirm).toBeHidden();
    await page.locator('.draft__generate').click();
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText('破棄');
    await expect(confirm).toContainText(String(FULL_APP_STATE.currentFormulaVersionId));
    // 経路を特定しない文言であること（#/edit を名指ししない。レビュー指摘対応）
    await expect(confirm).not.toContainText('#/edit');
    // window.confirm が提供していたフォーカス移動を自前で用意している
    // （レビュー指摘対応: キーボード / スクリーンリーダー利用者への通知手段）
    await expect(confirm.locator('.draft__discard-confirm-btn')).toBeFocused();

    await confirm.locator('.draft__discard-cancel').click();
    await expect(confirm).toBeHidden();
    // 「やめる」は開いたきっかけの生成ボタンへフォーカスを戻す（レビュー指摘対応:
    // 戻さないとフォーカスが行き場を失って body に落ち、キーボード利用者が
    // 文書先頭へ飛ばされる）
    await expect(page.locator('.draft__generate')).toBeFocused();
    // キャンセルなので式は変わっていない（バージョン表示がそのまま残る）
    await expect(page.locator('.draft__info')).toContainText(
      String(FULL_APP_STATE.currentFormulaVersionId)
    );
  });

  test('a11y: 破棄確認 UI 表示中も axe violation zero', async ({ page }) => {
    await injectAppStub(
      page,
      fullStateScenario({
        preloadedState: { ...FULL_APP_STATE, currentFormulaCreatedBy: 'user_edit' },
      })
    );
    await page.goto(APP_URL);
    await page.locator('.draft__generate').click();
    await expect(page.locator('.draft__discard-confirm')).toBeVisible();
    const result = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze();
    expect(result.violations, JSON.stringify(result.violations, null, 2)).toEqual([]);
  });
});
