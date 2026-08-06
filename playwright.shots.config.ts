/**
 * ストア掲載用スクリーンショット撮影専用の Playwright 設定。
 *
 * 役割: `tests/shots/` 配下の撮影 spec を実行し、1280x800（Chrome ウェブストアの
 * スクリーンショット規格）で `hosted/screenshots/` へ PNG を書き出す。
 *
 * 既定の playwright.config.ts（tests/e2e/ 収集・fullyParallel）とは別物として分離している:
 * - `testDir` を `tests/shots` に限定する（tests/shots/ は元々 playwright.config.ts の
 *   testDir に含まれないため、既定の `npm run test:e2e` には収集されない）
 * - viewport を 1280x800 / deviceScaleFactor=1 に固定し、PNG が CSS px と 1:1 になるようにする
 * - 撮影 spec が同一ファイル（hosted/screenshots/*.png）へ書き込むため、並行実行による
 *   競合を避けて fullyParallel: false / workers: 1 にする
 * - ポートは既定の E2E（4400）と衝突しないよう 4401（`SHOTS_PORT` 環境変数で上書き可）にする
 */

import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.SHOTS_PORT ?? 4401);
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './tests/shots',
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
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 1,
      },
    },
  ],
  webServer: {
    // dev ビルド → 静的配信。playwright.config.ts と同じ考え方（tools/playwright-server.js）
    command: `npm run dev && node tools/playwright-server.js --port ${PORT}`,
    url: `${BASE_URL}/popup/popup.html`,
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
