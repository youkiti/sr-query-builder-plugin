/**
 * J3: docx / markdown ファイルアップロードの UI ジャーニー。
 *
 * 本スペックは拡張内 UI だけを検証する。実 LLM 呼び出しには入らないので、
 * submit 後の extract-protocol 連携は stub 無し（ネットワーク 401/404 になるが、
 * 画面が壊れず error 領域に文言が入ることを確認する）。
 *
 * 完全な docx → ブロック抽出の journey は Phase A の LLM stub が揃ってから実装。
 *
 * docs/ui-deep-test-plan.md §Phase D J3。
 */

import { test, expect } from '@playwright/test';
import { injectAppStub, scenarioWithProject } from './fixtures/appStub';

const APP_URL = '/app/app.html#/protocol';

test.describe('journey-docx-upload (J3, UI-only)', () => {
  test('.md ファイル選択後 submit: input.files[0] が保持される', async ({ page }) => {
    await injectAppStub(page, scenarioWithProject());
    await page.goto(APP_URL);

    await page.locator('input[name=sourceMode][value=file]').check();
    await page.locator('input#file').setInputFiles({
      name: 'protocol.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('# RQ\n\n...'),
    });

    const fileName = await page
      .locator('input#file')
      .evaluate((el: HTMLInputElement) => el.files?.[0]?.name ?? '');
    expect(fileName).toBe('protocol.md');
  });

  test('.docx ファイル選択: 拡張子に応じた振分けのため input の value に反映される', async ({
    page,
  }) => {
    await injectAppStub(page, scenarioWithProject());
    await page.goto(APP_URL);

    await page.locator('input[name=sourceMode][value=file]').check();
    await page.locator('input#file').setInputFiles({
      name: 'protocol.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: Buffer.from('PK fake docx'),
    });

    const fileName = await page
      .locator('input#file')
      .evaluate((el: HTMLInputElement) => el.files?.[0]?.name ?? '');
    expect(fileName).toBe('protocol.docx');
  });

  test('未対応拡張子: submit 時に error box に「対応形式は…」文言', async ({ page }) => {
    await injectAppStub(page, scenarioWithProject());
    await page.goto(APP_URL);

    await page.locator('input[name=sourceMode][value=file]').check();
    await page.locator('input#file').setInputFiles({
      name: 'protocol.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4'),
    });
    await page.locator('button.protocol__submit').click();

    await expect(page.locator('#protocol-error')).toContainText('対応形式');
  });
});
