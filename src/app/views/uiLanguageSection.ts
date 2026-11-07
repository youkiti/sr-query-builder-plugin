import { getUiLanguage, isUiLanguage, localizeDom, setUiLanguage } from '@/lib/i18n';
import { saveUiLanguage } from '@/lib/i18n/uiLanguageStore';

/**
 * 設定画面と Options で共用する表示言語の選択。
 * 見出しの階層は置き場所で違う（設定画面は h2 の下の h3、Options は h1 の下の h2）ので、
 * 呼び出し側が渡す。階層を飛ばすと axe の heading-order に反する。
 */
export function buildUiLanguageSection(doc: Document, headingLevel: 'h2' | 'h3' = 'h3'): HTMLElement {
  const section = doc.createElement('section');
  section.className = 'settings__section';
  section.innerHTML = `
    <${headingLevel} data-i18n="settings.language"></${headingLevel}>
    <p data-i18n="settings.languageDescription"></p>
    <label for="ui-language" data-i18n="settings.language"></label>
    <select id="ui-language" aria-describedby="ui-language-description">
      <option value="ja" data-i18n="settings.languageJa"></option>
      <option value="en" data-i18n="settings.languageEn"></option>
    </select>
  `;
  section.querySelector('p')!.id = 'ui-language-description';
  const select = section.querySelector('select')!;
  select.value = getUiLanguage();
  select.addEventListener('change', () => {
    const language = select.value;
    if (!isUiLanguage(language)) return;
    setUiLanguage(language);
    doc.getElementById('ui-language')?.focus();
    localizeDom(section);
    void saveUiLanguage(language);
  });
  localizeDom(section);
  return section;
}
