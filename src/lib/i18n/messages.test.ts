import { messageAreas } from './messages';

const areas = ['common', 'shell', 'guide', 'home', 'protocol', 'blocks', 'seeds',
  'draft', 'expand', 'edit', 'export', 'done', 'history', 'settings', 'popup', 'options'];

function placeholders(value: string): string[] {
  return [...new Set(Array.from(value.matchAll(/\{(\w+)\}/g), match => match[1]!))].sort();
}

test('登録領域は指定の 16 個で、領域間のキー重複がない', () => {
  expect(Object.keys(messageAreas).sort()).toEqual(areas.sort());
  const keys = Object.values(messageAreas).flatMap(area => Object.keys(area.ja));
  expect(keys.length).toBe(new Set(keys).size);
});

test.each(Object.entries(messageAreas))('%s の日英キー・接頭辞・値・プレースホルダが揃う', (name, area) => {
  const ja: Record<string, string> = area.ja;
  const en: Record<string, string> = area.en;
  expect(Object.keys(ja).sort()).toEqual(Object.keys(en).sort());
  for (const [key, value] of Object.entries(ja)) {
    expect(key.startsWith(`${name}.`)).toBe(true);
    expect(value.length).toBeGreaterThan(0);
    expect(en[key]!.length).toBeGreaterThan(0);
    expect(placeholders(value)).toEqual(placeholders(en[key]!));
  }
});
