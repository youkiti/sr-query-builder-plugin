import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('版の目印が残る公開ページでも、Chrome API を使わず言語を切り替えられる', () => {
  document.body.innerHTML = '<div data-lang-switch></div><span class="ja">対象: v<span data-app-version>__APP_VERSION__</span></span>';
  const original = globalThis.chrome;
  Object.defineProperty(globalThis, 'chrome', { value: undefined, configurable: true, writable: true });
  try {
    const script = readFileSync(resolve('hosted/lang.js'), 'utf8');
    expect(() => window.eval(script)).not.toThrow();
    document.dispatchEvent(new Event('DOMContentLoaded'));
    document.querySelector<HTMLButtonElement>('[data-lang-choice="en"]')!.click();
    expect(document.documentElement.dataset.lang).toBe('en');
    expect(document.querySelector('[data-app-version]')!.textContent).toBe('__APP_VERSION__');
  } finally {
    Object.defineProperty(globalThis, 'chrome', { value: original, configurable: true, writable: true });
    document.body.innerHTML = '';
  }
});
