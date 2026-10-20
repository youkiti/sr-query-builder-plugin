import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { injectAppStub, scenarioWithProject } from './fixtures/appStub';

// 中止と同意を一つの操作列で確認し、送信数は route の記録だけから数える。
test('初回の中止では送らず、再操作で同意した後にだけ AI へ送る', async ({ page }) => {
  await injectAppStub(page, scenarioWithProject({ extraStorage: {
    aiConsent: {}, 'apiKeys.gemini': 'fake-key', 'llm.selectedModel': 'gemini-3.5-flash',
  } }));
  await page.route('**/www.googleapis.com/**', async (route) => {
    await route.fulfill({ status: 200, json: { id: 'fake-file', webViewLink: 'https://example.test/file' } });
  });
  let sent = 0;
  await page.route('**/generativelanguage.googleapis.com/**', async (route) => {
    sent += 1;
    await route.fulfill({ status: 400, json: { error: { message: 'テスト用の応答' } } });
  });
  await page.goto('/app/app.html#/protocol');
  await page.locator('textarea#inline').fill('成人の糖尿病治療に関する研究プロトコル');
  await page.locator('.protocol__submit').click();
  const dialog = page.getByRole('dialog', { name: 'AI へ送る前に確認してください' });
  await expect(dialog).toBeVisible();
  expect(sent).toBe(0);
  const accessibility = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze();
  expect(accessibility.violations).toEqual([]);
  await dialog.getByRole('button', { name: '送らずに中止する' }).click();
  await expect(page.locator('#protocol-error')).toContainText('AI への送信に同意しなかったため中止しました');
  expect(sent).toBe(0);
  await page.locator('.protocol__submit').click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '同意して続ける' }).click();
  await expect.poll(() => sent).toBe(1);
  await expect(dialog).toHaveCount(0);
});
