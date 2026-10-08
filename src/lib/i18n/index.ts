// ツアー関連の文言を現在の表示言語で引く実行時辞書。
// - t(key): 現在言語の辞書から文言を引く。未定義キーは ja にフォールバックし、
//   ja にも無ければキー文字列をそのまま返す（表示が空になるのを防ぐ）
// - 言語の切り替えは setUiLanguage で行い、onUiLanguageChange の購読者へ同期通知する
// - 保存は uiLanguageStore.ts が担う（本モジュールは storage に依存しない）
import { en } from './en';
import { ja, type MessageKey } from './ja';

export type { MessageKey };

/** UI 表示言語 */
export type UiLanguage = 'ja' | 'en';

export function isUiLanguage(value: unknown): value is UiLanguage {
  return value === 'ja' || value === 'en';
}

let currentLanguage: UiLanguage = 'ja';

const listeners = new Set<(language: UiLanguage) => void>();

/** 現在の表示言語 */
export function getUiLanguage(): UiLanguage {
  return currentLanguage;
}

/** 表示言語を切り替え、変化があれば購読者へ同期通知する（同値なら何もしない） */
export function setUiLanguage(language: UiLanguage): void {
  if (language === currentLanguage) {
    return;
  }
  currentLanguage = language;
  for (const listener of [...listeners]) {
    listener(language);
  }
}

/** 言語切替の購読（戻り値で解除） */
export function onUiLanguageChange(listener: (language: UiLanguage) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 現在言語の文言を返す。params は `{name}` 形式のプレースホルダを全置換する。 */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  // 実行時は Partial として扱い、未知キーは ja → キー文字列の順で倒す。
  const dict: Partial<Record<MessageKey, string>> = currentLanguage === 'en' ? en : ja;
  let text = dict[key] ?? ja[key] ?? key;
  if (params !== undefined) {
    for (const [name, value] of Object.entries(params)) {
      text = text.split(`{${name}}`).join(String(value));
    }
  }
  return text;
}
