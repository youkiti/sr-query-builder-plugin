// ヘルプ相談の検索と偽の Anthropic 二段階応答を画面から確かめる。
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { injectAppStub } from './fixtures/appStub';
import { AI_CONSENT_VERSION } from '../../src/lib/llm/aiDisclosure';

test('ホームの相談で検索・回答・アクセシビリティ・Escape を確認する', async ({ page }) => {
  await injectAppStub(page, { extraStorage: {
    'apiKeys.anthropic': 'fake-consult-key',
    'llm.selectedModel': 'claude-opus-5-5',
    aiConsent: { anthropic: { version: AI_CONSENT_VERSION, acceptedAt: '2026-10-20T00:00:00Z' } },
  } });
  let requests = 0;
  await page.route('https://api.anthropic.com/v1/messages', async route => {
    const body = route.request().postDataJSON() as { system?: string; messages: Array<{ content: string }> };
    const selecting = body.system?.includes('質問に関連するヘルプの小節を最大3つ');
    const data = JSON.parse(body.messages[0]!.content) as { sections: Array<{ id: string }> };
    requests++;
    await route.fulfill({ json: {
      content: [{ type: 'text', text: selecting ? JSON.stringify({ sectionIds: [data.sections[0]!.id] }) : 'これは相談のテスト回答です。' }],
      stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 20 },
    } });
  });
  await page.goto('/app/app.html#/home');
  await page.waitForSelector('#app-open-tours[aria-controls]');
  const help = page.locator('#app-content h2 + .guide-help-btn');
  await help.click();
  await page.locator('[data-help-action="consult"]').click();
  const dialog = page.locator('.guide-consult__panel');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'この画面のヘルプ' })).toBeVisible();
  await dialog.getByLabel('困っていること（1,000文字まで）').fill('プロジェクトを作成したい');
  await dialog.getByRole('button', { name: 'ヘルプを検索', exact: true }).click();
  await expect(dialog.locator('.guide-consult__results .guide-consult__card').first()).toBeVisible();
  await dialog.getByRole('button', { name: 'AI に聞く', exact: true }).click();
  await expect(dialog.locator('.guide-consult__answer')).toContainText('これは相談のテスト回答です。');
  expect(requests).toBe(2);
  const result = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze();
  expect(result.violations, JSON.stringify(result.violations, null, 2)).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(help).toBeFocused();
});