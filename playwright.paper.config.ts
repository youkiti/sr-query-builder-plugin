/**
 * 論文の図（英語の画面）を撮る専用の Playwright 設定。
 *
 * ストア掲載用の playwright.shots.config.ts（1280x800・日本語・hosted/screenshots/ へ出力）とは
 * 分けてある。`npm run shots` はこの spec を拾わず、`npm run shots:paper` はストア用の 5 枚に
 * 触れない。
 *
 * - viewport は 1280 CSS px、deviceScaleFactor 2（PNG は 2 倍の画素数。印刷でも文字が潰れない）
 * - ブラウザは既定で Edge（ARM64 の Windows では同梱の Chromium がエミュレーションで止まりやすい）。
 *   `PAPER_FIG_CHANNEL=chromium` で同梱の Chromium に切り替えられる
 * - ポートは E2E（4400）・ストア撮影（4401）と重ならない 4402（`PAPER_FIG_PORT` で上書き可）
 */

import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.PAPER_FIG_PORT ?? 4402);
const BASE_URL = `http://localhost:${PORT}`;
const CHANNEL = process.env.PAPER_FIG_CHANNEL ?? 'msedge';

export default defineConfig({
  testDir: './tests/paper-figures',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'paper',
      use: {
        ...devices['Desktop Chrome'],
        ...(CHANNEL === 'chromium' ? {} : { channel: CHANNEL }),
        viewport: { width: 1280, height: 900 },
        deviceScaleFactor: 2,
      },
    },
  ],
  webServer: {
    command: `npm run dev && node tools/playwright-server.js --port ${PORT}`,
    url: `${BASE_URL}/popup/popup.html`,
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
