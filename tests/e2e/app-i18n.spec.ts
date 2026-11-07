import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { injectAppStub } from './fixtures/appStub';

test('設定で選んだ表示言語が画面遷移と再読み込み後も使われ、日本語へ戻せる', async ({ page }) => {
  await injectAppStub(page, { authed: true });
  // 共通スタブのメモリ内 storage に、この spec 内だけ再読み込み用の保存を足す。
  await page.addInitScript(() => {
    const root = window as unknown as { chrome: typeof chrome };
    const attach = (stub: typeof chrome): typeof chrome => {
      const local = stub.storage.local;
      const get = local.get.bind(local);
      const set = local.set.bind(local);
      local.get = (async (keys: string | string[] | null) => {
        const result = await get(keys);
        const language = sessionStorage.getItem('test-ui-language');
        if (language && (keys === null || keys === 'uiLanguage' ||
          (Array.isArray(keys) && keys.includes('uiLanguage')))) result.uiLanguage = language;
        return result;
      }) as typeof local.get;
      local.set = (async (items: Record<string, unknown>) => {
        if (typeof items.uiLanguage === 'string') sessionStorage.setItem('test-ui-language', items.uiLanguage);
        await set(items);
      }) as typeof local.set;
      return stub;
    };
    let stub = root.chrome;
    if (stub?.storage?.local) stub = attach(stub);
    Object.defineProperty(root, 'chrome', {
      configurable: true,
      get: () => stub,
      set: (value: typeof chrome) => { stub = value?.storage?.local ? attach(value) : value; },
    });
  });
  await page.goto('/app/app.html#/settings');
  await page.locator('#ui-language').selectOption('en');
  await expect(page.locator('#app-content h2')).toHaveText('Settings');
  await expect(page.locator('#app-sidebar')).toContainText('Search block approval');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.locator('#app-home-link').click();
  await expect(page.locator('#app-content h2')).toHaveText('Home');
  await page.reload();
  await expect(page.locator('#app-content h2')).toHaveText('Home');
  await expect(page.locator('#app-sidebar')).toContainText('Search block approval');
  await page.locator('#app-settings-link').click();
  await expect(page.locator('#ui-language')).toHaveValue('en');
  const result = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze();
  expect(result.violations, JSON.stringify(result.violations, null, 2)).toEqual([]);
  await page.locator('#ui-language').selectOption('ja');
  await expect(page.locator('#app-content h2')).toHaveText('設定');
  await expect(page.locator('#app-sidebar')).toContainText('ブロック承認');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
  await page.locator('#app-home-link').click();
  await expect(page.locator('#app-content h2')).toHaveText('ホーム');
});
