// ビルド時に生成する言語別のヘルプ小節を、呼び出されたときだけ読む。
import type { HelpLanguage, HelpSection } from './types';

export async function loadHelpSections(lang: HelpLanguage): Promise<HelpSection[]> {
  if (lang === 'ja') {
    return (await import(/* webpackChunkName: "help-sections-ja" */ '../../../hosted/help.html?help-sections&lang=ja')).default;
  }
  return (await import(/* webpackChunkName: "help-sections-en" */ '../../../hosted/help.html?help-sections&lang=en')).default;
}
