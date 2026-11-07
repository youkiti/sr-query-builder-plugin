// 実物のヘルプと小さな HTML で小節の境界・言語分離・不要情報の除去を検証する。
import { readFileSync } from 'fs';
import { join } from 'path';
import { GUIDE_TOPICS } from '../src/lib/guide/topics';
import { loadHelpSections } from '../src/lib/help-consult/load';
import type { HelpSection } from '../src/lib/help-consult/types';

// CommonJS の webpack ローダーを本番と共用する。
// eslint-disable-next-line @typescript-eslint/no-var-requires
const loader = require('../tools/webpack/help-sections.cjs') as {
  (this: { resourceQuery: string }, html: string): string;
  parseHelpSections(html: string, lang: string): HelpSection[];
};
const html = readFileSync(join(__dirname, '../hosted/help.html'), 'utf8');

test.each(['ja', 'en'] as const)('実物の %s は重複のない26小節を必要時に読み、案内先をすべて含む', async lang => {
  const sections = loader.parseHelpSections(html, lang);
  expect(await loadHelpSections(lang)).toEqual(sections);
  expect(sections).toHaveLength(26);
  expect(new Set(sections.map(section => section.id)).size).toBe(26);
  expect(sections.filter(section => section.kind === 'section')).toHaveLength(16);
  expect(sections.filter(section => section.kind === 'troubleshooting')).toHaveLength(4);
  expect(sections.filter(section => section.kind === 'faq')).toHaveLength(6);
  for (const section of sections) {
    expect(section.title.trim()).not.toBe('');
    expect(section.sectionTitle.trim()).not.toBe('');
    expect(section.body.trim()).not.toBe('');
    expect(section.when.length).toBeGreaterThanOrEqual(2);
    expect(section.when.length).toBeLessThanOrEqual(4);
    expect(section.body).not.toMatch(/http|こんなとき|When to read this|help-when/);
    if (lang === 'en') {
      expect(section.body).not.toMatch(/[ぁ-んァ-ヶ]/);
    } else {
      expect(section.body).toMatch(/[ぁ-んァ-ヶ]/);
      expect(section.body).not.toContain('This tool drafts PubMed queries');
    }
  }
  for (const topic of Object.values(GUIDE_TOPICS)) {
    expect(sections.map(section => section.id)).toContain(topic.helpAnchor);
  }
});

test('入れ子の span・実体参照を処理し、節外・動画・コメント・スクリプト・表示 URL を除く', () => {
  const source = '<nav>対象外</nav><section id="sample"><h2><span class="ja">親<span>の</span>見出し</span>'
    + '<span class="en">Parent heading</span></h2><div class="help-when"><p class="help-when-label">こんなとき</p>'
    + '<ul><li><span class="ja">困ったとき</span><span class="en">When stuck</span></li></ul></div>'
    + '<p class="chapter-video">動画の文字</p><p><span class="ja">本文</span><span class="en">Body</span>'
    + ' &amp; &#65; &#x42; &lt;name&gt; https://example.test/private</p>'
    + '<script>秘密</script><style>非表示</style><!-- コメント --></section>'
    + '<section id="troubleshooting"><h2>章</h2><h3 id="first">最初</h3><p>一つ目</p>'
    + '<h3 id="last">最後</h3><p>二つ目</p></section>'
    + '<section id="faq"><h2>質問</h2><details class="faq" id="faq-one"><summary>問い</summary><p>答え</p></details></section>';
  const ja = loader.parseHelpSections(source, 'ja');
  expect(ja[0]).toEqual({
    id: 'sample', kind: 'section', sectionId: 'sample', sectionTitle: '親の見出し', title: '親の見出し',
    when: ['困ったとき'], body: '本文 & A B <name>',
  });
  expect(loader.parseHelpSections(source, 'en')[0]?.body).toBe('Body & A B <name>');
  expect(ja.slice(1).map(section => [section.id, section.kind, section.body])).toEqual([
    ['first', 'troubleshooting', '一つ目'], ['last', 'troubleshooting', '二つ目'], ['faq-one', 'faq', '答え'],
  ]);
  const emitted = loader.call({ resourceQuery: '?help-sections&lang=ja' }, source);
  expect(JSON.parse(emitted.slice('module.exports = '.length, -1))).toEqual(ja);
  expect(() => loader.parseHelpSections(source, 'fr')).toThrow();
});
