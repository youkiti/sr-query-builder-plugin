import { readFileSync } from 'fs';
import { join } from 'path';
import {
  GUIDE_TOPICS, GUIDE_TOPIC_TITLE_KEYS, GUIDE_VIDEO_CHAPTERS, GUIDE_VIDEO_ID, HELP_PAGE_URL,
  buildHelpUrl, buildVideoUrl, isGuideTopicId, topicForRoute, type GuideTopicId,
} from './topics';
import { isGuideTourId } from './tours';
import { ROUTES, ROUTE_LABELS } from '../../app/router';
import { ja } from '../i18n/ja';
import { en } from '../i18n/en';

const root = join(__dirname, '..', '..', '..');
const helpHtml = readFileSync(join(root, 'hosted', 'help.html'), 'utf8');
const indexHtml = readFileSync(join(root, 'hosted', 'index.html'), 'utf8');
const topicIds = Object.keys(GUIDE_TOPICS) as GuideTopicId[];

test('全トピックの helpAnchor が hosted/help.html に id として実在する', () => {
  for (const topicId of topicIds) {
    const { helpAnchor } = GUIDE_TOPICS[topicId];
    expect(helpHtml).toContain(`id="${helpAnchor}"`);
    expect(helpHtml).toMatch(new RegExp(`<section id="${helpAnchor}">`));
  }
});

test('動画 ID が hosted/help.html と hosted/index.html の埋め込みと一致する', () => {
  const embed = `youtube-nocookie.com/embed/${GUIDE_VIDEO_ID}`;
  expect(helpHtml).toContain(embed);
  expect(indexHtml).toContain(embed);
  for (const topicId of topicIds) {
    const { video } = GUIDE_TOPICS[topicId];
    if (video) expect(video.youtubeId).toBe(GUIDE_VIDEO_ID);
  }
});

test('章の開始秒が昇順で、トピックの動画が章の値を指す', () => {
  const seconds = Object.values(GUIDE_VIDEO_CHAPTERS);
  expect(seconds[0]).toBe(0);
  expect([...seconds].sort((a, b) => a - b)).toEqual(seconds);
  expect(new Set(seconds).size).toBe(seconds.length);
  for (const topicId of topicIds) {
    const { video } = GUIDE_TOPICS[topicId];
    if (video) expect(seconds).toContain(video.startSec);
  }
});

test('hosted/help.html の ?t= リンクはすべて章の開始秒のどれかで、章の節ごとに 1 つある', () => {
  const seconds: number[] = Object.values(GUIDE_VIDEO_CHAPTERS);
  const links = Array.from(helpHtml.matchAll(/https:\/\/youtu\.be\/([\w-]+)\?t=(\d+)/g));
  expect(links.length).toBeGreaterThan(0);
  for (const [, id, sec] of links) {
    expect(id).toBe(GUIDE_VIDEO_ID);
    expect(seconds).toContain(Number(sec));
  }
  // 節の見出しの直後に、その節に対応する章のリンクがある
  const sectionChapters: Record<string, number> = {
    setup: GUIDE_VIDEO_CHAPTERS.setup, project: GUIDE_VIDEO_CHAPTERS.project,
    protocol: GUIDE_VIDEO_CHAPTERS.protocol, blocks: GUIDE_VIDEO_CHAPTERS.blocks,
    seeds: GUIDE_VIDEO_CHAPTERS.seeds, draft: GUIDE_VIDEO_CHAPTERS.draft,
    expand: GUIDE_VIDEO_CHAPTERS.expand, edit: GUIDE_VIDEO_CHAPTERS.edit,
    export: GUIDE_VIDEO_CHAPTERS.export, done: GUIDE_VIDEO_CHAPTERS.done,
    history: GUIDE_VIDEO_CHAPTERS.history,
  };
  for (const [anchor, sec] of Object.entries(sectionChapters)) {
    const section = helpHtml.split(`<section id="${anchor}">`)[1]!.split('</section>')[0]!;
    expect(section).toContain(`https://youtu.be/${GUIDE_VIDEO_ID}?t=${sec}`);
  }
});

test('hosted/help.html に操作ツアーの節と目次の項目がある', () => {
  expect(helpHtml).toContain('<section id="tours">');
  expect(helpHtml).toContain('href="#tours"');
});

test('ROUTES の全ルートにトピックがあり、ツアー ID は登録済み', () => {
  for (const route of ROUTES) {
    const topicId = topicForRoute(route);
    expect(isGuideTopicId(topicId)).toBe(true);
    expect(GUIDE_TOPICS[topicId]).toBeDefined();
  }
  expect(topicIds.sort()).toEqual([...ROUTES].sort());
  for (const topicId of topicIds) {
    const { tourId } = GUIDE_TOPICS[topicId];
    if (tourId !== undefined) expect(isGuideTourId(tourId)).toBe(true);
  }
});

test('isGuideTopicId は登録済みのトピック ID だけを通す', () => {
  expect(isGuideTopicId('home')).toBe(true);
  for (const value of ['', 'unknown', 'toString', null, undefined, 1]) expect(isGuideTopicId(value)).toBe(false);
});

test('トピックの見出しキーが ja / en にあり、ja は ROUTE_LABELS と一致する', () => {
  for (const topicId of topicIds) {
    const key = GUIDE_TOPIC_TITLE_KEYS[topicId];
    expect(key).toBe(`guide.topic${topicId.charAt(0).toUpperCase()}${topicId.slice(1)}`);
    expect(ja[key]).toBe(ROUTE_LABELS[topicId]);
    expect(en[key].length).toBeGreaterThan(0);
  }
});

test('buildHelpUrl / buildVideoUrl の出力', () => {
  expect(HELP_PAGE_URL).toBe('https://youkiti.github.io/sr-query-builder-plugin/help.html');
  expect(buildHelpUrl('home', 'ja')).toBe(`${HELP_PAGE_URL}?lang=ja#project`);
  expect(buildHelpUrl('settings', 'en')).toBe(`${HELP_PAGE_URL}?lang=en#setup`);
  expect(buildVideoUrl({ youtubeId: 'abc', startSec: 12 })).toBe('https://youtu.be/abc?t=12');
  expect(buildVideoUrl(GUIDE_TOPICS.home.video!)).toBe('https://youtu.be/RqUFlmncuIE?t=174');
});
