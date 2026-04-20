/**
 * Playwright 設定。
 *
 * 役割: docs/ui-review-strategy.md §3 Tier 2 / Tier 3 の実 Chromium スモークと
 * @axe-core/playwright を実行する。
 *
 * 構成:
 * - tests/e2e 配下を spec として収集
 * - webServer で `npm run dev`（webpack dev ビルド）→ 静的サーバを起動
 * - localhost:4400 を baseURL として popup.html / app.html / options.html を読む
 *
 * Chromium が未インストールの場合は `npx playwright install chromium` を先に実行する。
 */

import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 4400);
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    // 失敗時のみ trace を残す。dist/ + chromium を抱えるためサイズに注意
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    // dev ビルド → 静的配信。webServer.url のヘルスチェック (HTTP 200) でレディと判定
    command: `npm run dev && node tools/playwright-server.js --port ${PORT}`,
    url: `${BASE_URL}/popup/popup.html`,
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
