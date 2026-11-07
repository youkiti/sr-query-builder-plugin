import { messageAreas } from './messages';

// 英語のツアーは画面の英語ラベルを “…” で引く。画面の文言を変えたのにツアーが古いまま、
// という食い違いをここで止める。
const tourEntries = Object.entries(messageAreas.guide.en).filter(([key]) => key.startsWith('guide.tour'));

/** 画面の英語ラベルとして引用してよい形の集合。先頭の絵文字・記号と末尾のコロン、「見出し: {値}」の値の部分を外した形も含める。 */
function screenLabels(): Set<string> {
  const labels = new Set<string>();
  for (const [name, area] of Object.entries(messageAreas)) {
    if (name === 'guide') continue;
    for (const value of Object.values(area.en) as string[]) {
      const trimmed = value.replace(/^[^\p{L}\p{N}①-⑳]+/u, '').trim();
      labels.add(value.trim());
      labels.add(trimmed);
      labels.add(trimmed.replace(/[:：]\s*$/, ''));
      const heading = trimmed.match(/^(.+?)[:：]\s*\{\w+\}$/);
      if (heading) labels.add(heading[1]!);
    }
  }
  return labels;
}

// 画面ではまだ日本語のまま出る語（最終レビューの区分名は service 層が日本語で作る）。
// 英語のツアーでは 「…」 (訳) の形で引く。英語化されたら “…” に替えてここから外す。
const japaneseOnScreen = new Set(['既知文献の捕捉', '目安件数', '外側の確認', '削除影響の確認']);

test('英語のツアーが “…” で引く語は、すべて画面の英語の文言にある', () => {
  const labels = screenLabels();
  const missing: string[] = [];
  for (const [key, text] of tourEntries) {
    for (const match of text.matchAll(/“([^”]+)”/g)) {
      if (!labels.has(match[1]!)) missing.push(`${key}: ${match[1]}`);
    }
  }
  expect(missing).toEqual([]);
});

test('英語のツアーに残る 「…」 は、画面で日本語のまま出る語だけ', () => {
  const unexpected: string[] = [];
  for (const [key, text] of tourEntries) {
    for (const match of text.matchAll(/「([^」]+)」/g)) {
      if (!japaneseOnScreen.has(match[1]!)) unexpected.push(`${key}: ${match[1]}`);
    }
  }
  expect(unexpected).toEqual([]);
});
