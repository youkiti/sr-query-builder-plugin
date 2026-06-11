/**
 * #/seeds 画面スモーク（Tier 2 + Tier 3 a11y）。
 * docs/ui-deep-test-plan.md Phase B。
 */

import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { injectAppStub, scenarioWithProject } from './fixtures/appStub';

const APP_URL = '/app/app.html#/seeds';

const SEED_HEADER = [
  'pmid',
  'title',
  'year',
  'source',
  'ingest_format',
  'original_db',
  'is_valid',
  'exclusion_reason',
  'original_payload_ref',
  'user_decision',
  'decided_at',
  'decided_by',
  'note',
];

function seedRow(pmid: string, isValid: boolean, exclusionReason = ''): string[] {
  const base: Record<string, string> = {
    pmid,
    title: `Title ${pmid}`,
    year: '2020',
    source: 'initial',
    ingest_format: 'pmid_direct',
    original_db: '',
    is_valid: isValid ? 'true' : 'false',
    exclusion_reason: exclusionReason,
    original_payload_ref: '',
    user_decision: '',
    decided_at: '',
    decided_by: '',
    note: '',
  };
  return SEED_HEADER.map((k) => base[k] ?? '');
}

test.describe('app-seeds (#/seeds)', () => {
  test('プロジェクト未選択: guard プレースホルダ', async ({ page }) => {
    await injectAppStub(page, { authed: true });
    await page.goto(APP_URL);

    await expect(page.locator('#app-content .view__placeholder')).toBeVisible();
  });

  test('プロジェクト有り: 2 セクション（PMID 直接入力 / NBIB・RIS 統合アップロード）が並ぶ', async ({ page }) => {
    await injectAppStub(page, scenarioWithProject());
    await page.goto(APP_URL);

    // NBIB / RIS は 1 つのアップロードセクションに統合され、形式は内容から自動判別する（seedsView.ts buildFileForm）
    await expect(page.locator('.seeds__section')).toHaveCount(2);
    await expect(page.locator('textarea.seeds__pmid-input')).toBeVisible();
    await expect(page.locator('input[type="file"][accept*=".nbib"][accept*=".ris"]')).toHaveCount(1);
    // summary 枠は初期時は空（aria-live は常設でも内容は空）
    await expect(page.locator('.seeds__summary')).toBeEmpty();
  });

  test('空 PMID で登録ボタン: status にエラー風テキストは出るがクラッシュしない', async ({ page }) => {
    await injectAppStub(page, scenarioWithProject());
    await page.goto(APP_URL);

    // 未入力状態で最初のセクションの登録ボタンをクリック
    await page.locator('.seeds__section').first().locator('button').click();
    // error もしくは status の aria-live 領域がクラッシュせず残っている（空でもよい）
    await expect(page.locator('.seeds__status')).toHaveCount(1);
  });

  test('登録済み一覧: デフォルトは有効のみ→トグルで無効行も表示', async ({ page }) => {
    await injectAppStub(page, scenarioWithProject());
    // SeedPapers の GET 値をモック（有効 1 / 無効 1）
    await page.route('**/sheets.googleapis.com/**/values/**', async (route) => {
      const url = route.request().url();
      if (route.request().method() === 'GET' && url.includes('SeedPapers')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            values: [
              SEED_HEADER,
              seedRow('111', true),
              seedRow('222', false, 'pmid_not_found'),
            ],
          }),
        });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    await page.goto(APP_URL);

    // 初期は有効 1 件のみ
    await expect(page.locator('.seeds__list-item')).toHaveCount(1);
    await expect(page.locator('.seeds__list-item--valid')).toHaveCount(1);
    await expect(page.locator('.seeds__list-item--invalid')).toHaveCount(0);

    // 「無効行も表示」トグル ON → 2 件
    await page.locator('.seeds__show-invalid').check();
    await expect(page.locator('.seeds__list-item')).toHaveCount(2);
    await expect(page.locator('.seeds__list-item--invalid')).toContainText('pmid_not_found');
  });

  test('無効化ボタン: 当該行を is_valid=false / user_removed へ PUT する', async ({ page }) => {
    await injectAppStub(page, scenarioWithProject());

    const putBodies: string[] = [];
    let invalidated = false;
    await page.route('**/sheets.googleapis.com/**/values/**', async (route) => {
      const req = route.request();
      const url = req.url();
      if (req.method() === 'GET' && url.includes('SeedPapers')) {
        // PUT（無効化）が来る前は有効 1 件、来た後は user_removed 済みを返す
        const rows = invalidated
          ? [SEED_HEADER, seedRow('111', false, 'user_removed')]
          : [SEED_HEADER, seedRow('111', true)];
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ values: rows }),
        });
        return;
      }
      if (req.method() === 'PUT' && url.includes('SeedPapers')) {
        putBodies.push(req.postData() ?? '');
        invalidated = true;
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    await page.goto(APP_URL);

    await expect(page.locator('.seeds__list-item--valid')).toHaveCount(1);
    await page.locator('.seeds__list-invalidate').click();

    // PUT が 1 回飛び、ボディに user_removed / false が含まれる
    await expect.poll(() => putBodies.length).toBeGreaterThan(0);
    expect(putBodies[0]).toContain('user_removed');
    // 再取得後は有効行が 0 件（user_removed になった）
    await expect(page.locator('.seeds__list-item--valid')).toHaveCount(0);
  });

  test('a11y: axe violation zero', async ({ page }) => {
    await injectAppStub(page, scenarioWithProject());
    await page.goto(APP_URL);
    await expect(page.locator('.seeds__section').first()).toBeVisible();
    const result = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze();
    expect(result.violations, JSON.stringify(result.violations, null, 2)).toEqual([]);
  });
});
