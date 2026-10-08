import { getUiLanguage, isUiLanguage, onUiLanguageChange, setUiLanguage, t, type MessageKey } from './index';
import { ja } from './ja';
import { en } from './en';

afterEach(() => { setUiLanguage('ja'); });

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
    expect(key.startsWith('guide.')).toBe(true);
    expect(en[key as MessageKey].length).toBeGreaterThan(0);
  }
});
