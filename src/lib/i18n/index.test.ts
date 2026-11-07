import { formatLocalized, getUiLanguage, localizeDom, isUiLanguage, onUiLanguageChange, setUiLanguage, t, translate, type MessageKey } from './index';
import { ja } from './ja';
import { en } from './en';

afterEach(() => { setUiLanguage('ja'); });

test('指定言語で文言と生の文字列を整形し、現在言語を変えない', () => {
  setUiLanguage('en');
  expect(translate('ja', 'draft.unmet.overTarget', { target: 10, measured: 20 })).toBe('目安件数 10 件を超えています（実測 20 件）');
  expect(formatLocalized('en', { key: 'draft.unmet.overTarget', params: { target: 10, measured: 20 } })).toBe('Target hit count 10 exceeded (measured 20 hits)');
  expect(formatLocalized('en', '翻訳できない例外')).toBe('翻訳できない例外');
  expect(getUiLanguage()).toBe('en');
  expect(t('guide.next')).toBe(translate('en', 'guide.next'));
});

test('指定言語でも未定義キーと未指定・繰り返しのプレースホルダを従来どおり扱う', () => {
  const key = 'draft.testFallback' as MessageKey;
  (ja as Record<string, string>)[key] = '{name} と {name} が {count} 件';
  try {
    expect(translate('en', key, { name: 'A', count: 2 })).toBe('A と A が 2 件');
    expect(translate('ja', key)).toBe('{name} と {name} が {count} 件');
  } finally {
    delete (ja as Record<string, string>)[key];
  }
  expect(translate('en', key)).toBe(key);
  expect(formatLocalized('ja', { key })).toBe(key);
});

test('既定は ja で、切り替えると辞書が変わり、同じ言語への切り替えは通知しない', () => {
  expect(getUiLanguage()).toBe('ja');
  expect(t('guide.next')).toBe('次へ');
  const listener = jest.fn();
  const off = onUiLanguageChange(listener);
  setUiLanguage('en');
  expect(getUiLanguage()).toBe('en');
  expect(t('guide.next')).toBe('Next');
  setUiLanguage('en');
  expect(listener).toHaveBeenCalledTimes(1);
  expect(listener).toHaveBeenCalledWith('en');
  off();
  setUiLanguage('ja');
  expect(listener).toHaveBeenCalledTimes(1);
});

test('未定義キーは ja、それも無ければキー文字列を返す', () => {
  const key = 'guide.unknownKey' as MessageKey;
  expect(t(key)).toBe('guide.unknownKey');
  setUiLanguage('en');
  expect(t(key)).toBe('guide.unknownKey');
  const jaOnly = 'guide.jaOnly' as MessageKey;
  (ja as Record<string, string>)[jaOnly] = '日本語だけ';
  try {
    expect(t(jaOnly)).toBe('日本語だけ');
  } finally {
    delete (ja as Record<string, string>)[jaOnly];
  }
});

test('プレースホルダを全置換する', () => {
  const key = 'guide.placeholderTest' as MessageKey;
  (ja as Record<string, string>)[key] = '{name} と {name} が {count} 件';
  try {
    expect(t(key, { name: 'A', count: 2 })).toBe('A と A が 2 件');
    expect(t(key)).toBe('{name} と {name} が {count} 件');
  } finally {
    delete (ja as Record<string, string>)[key];
  }
});

test('購読の途中で解除されても、残りの購読者へ通知する', () => {
  const calls: string[] = [];
  const offFirst = onUiLanguageChange(() => { calls.push('first'); offFirst(); });
  const offSecond = onUiLanguageChange(() => { calls.push('second'); });
  setUiLanguage('en');
  expect(calls).toEqual(['first', 'second']);
  offSecond();
});

test('言語値の判定と、ja と en のキー集合の一致', () => {
  expect(isUiLanguage('ja')).toBe(true);
  expect(isUiLanguage('en')).toBe(true);
  for (const value of ['fr', '', null, undefined, 1]) expect(isUiLanguage(value)).toBe(false);
  expect(Object.keys(en).sort()).toEqual(Object.keys(ja).sort());
  for (const key of Object.keys(ja)) {
    expect(en[key as MessageKey].length).toBeGreaterThan(0);
  }
});


test('localizeDom はテキストと対象属性を現在言語で更新する', () => {
  const root = document.createElement('div');
  root.innerHTML = `<span data-i18n="home.title"></span>
    <input data-i18n-placeholder="guide.next" data-i18n-title="guide.done"
      data-i18n-aria-label="settings.language"><b>保持</b>`;
  localizeDom(root);
  expect(root.querySelector('span')?.textContent).toBe('ホーム');
  setUiLanguage('en');
  localizeDom(root);
  expect(root.querySelector('span')?.textContent).toBe('Home');
  expect(root.querySelector('input')?.getAttribute('placeholder')).toBe('Next');
  expect(root.querySelector('input')?.title).toBe('Done');
  expect(root.querySelector('input')?.getAttribute('aria-label')).toBe('Display language');
  expect(root.querySelector('b')?.textContent).toBe('保持');
});
