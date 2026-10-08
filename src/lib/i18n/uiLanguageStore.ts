import { isUiLanguage, type UiLanguage } from './index';

/** chrome.storage.local に表示言語を保存するキー */
export const UI_LANGUAGE_STORAGE_KEY = 'uiLanguage';

function hasLocalStorage(): boolean {
  return typeof chrome !== 'undefined' && Boolean(chrome.storage?.local);
}

/** 保存値が無いときの既定。ブラウザの UI 言語が ja で始まれば ja、それ以外は en。chrome.i18n が無ければ ja。 */
export function defaultUiLanguage(): UiLanguage {
  if (typeof chrome === 'undefined' || typeof chrome.i18n?.getUILanguage !== 'function') {
    return 'ja';
  }
  return chrome.i18n.getUILanguage().startsWith('ja') ? 'ja' : 'en';
}

/** 保存された表示言語を読む。無い・壊れている・読めないときは既定を返す。 */
export async function loadUiLanguage(): Promise<UiLanguage> {
  if (!hasLocalStorage()) {
    return defaultUiLanguage();
  }
  try {
    const stored = (await chrome.storage.local.get(UI_LANGUAGE_STORAGE_KEY))[UI_LANGUAGE_STORAGE_KEY];
    return isUiLanguage(stored) ? stored : defaultUiLanguage();
  } catch (error) {
    console.warn('[i18n] 表示言語の読み込みに失敗:', error);
    return defaultUiLanguage();
  }
}

/** 表示言語を保存する。失敗しても画面は止めず警告だけ残す。 */
export async function saveUiLanguage(language: UiLanguage): Promise<void> {
  if (!hasLocalStorage()) {
    return;
  }
  try {
    await chrome.storage.local.set({ [UI_LANGUAGE_STORAGE_KEY]: language });
  } catch (error) {
    console.warn('[i18n] 表示言語の保存に失敗:', error);
  }
}
