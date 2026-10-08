// 「?」メニューの対応表。画面（ルート）ごとに、公開ヘルプの節・解説動画の章・始められるツアーを結ぶ。
// UI にも通信にも依存しない。値は hosted/help.html と hosted/index.html の実物と topics.test.ts が照合する。
import type { MessageKey, UiLanguage } from '../i18n';
import type { RouteName } from '../../app/router';
import type { GuideTourId } from './tours';

/** トピック ID。今はルート名と 1:1 */
export type GuideTopicId = RouteName;

export interface GuideTopic {
  /** hosted/help.html 内の id（# は付けない） */
  helpAnchor: string;
  /** 解説動画（長編）の章。対応する章が無いトピックでは省略 */
  video?: { youtubeId: string; startSec: number };
  /** この画面から始められるツアー */
  tourId?: GuideTourId;
}

/** 公開済みの解説動画（長編）の YouTube ID。上げ直したら章の開始秒と hosted/ の埋め込みも直す */
export const GUIDE_VIDEO_ID = 'RqUFlmncuIE';

/** 動画の章の開始秒（YouTube の説明欄のチャプターから 2026-10-08 に取得。分 * 60 + 秒） */
export const GUIDE_VIDEO_CHAPTERS = {
  intro: 0,
  setup: 66,
  project: 174,
  protocol: 250,
  blocks: 360,
  seeds: 444,
  draft: 526,
  validation: 668,
  expand: 782,
  edit: 896,
  export: 1018,
  done: 1116,
  history: 1157,
  outro: 1219,
} as const;

type ChapterName = keyof typeof GUIDE_VIDEO_CHAPTERS;

function chapter(name: ChapterName): { youtubeId: string; startSec: number } {
  return { youtubeId: GUIDE_VIDEO_ID, startSec: GUIDE_VIDEO_CHAPTERS[name] };
}

export const GUIDE_TOPICS: Record<GuideTopicId, GuideTopic> = {
  home: { helpAnchor: 'project', video: chapter('project'), tourId: 'getting-started' },
  protocol: { helpAnchor: 'protocol', video: chapter('protocol'), tourId: 'getting-started' },
  blocks: { helpAnchor: 'blocks', video: chapter('blocks') },
  seeds: { helpAnchor: 'seeds', video: chapter('seeds') },
  draft: { helpAnchor: 'draft', video: chapter('draft') },
  expand: { helpAnchor: 'expand', video: chapter('expand') },
  edit: { helpAnchor: 'edit', video: chapter('edit') },
  export: { helpAnchor: 'export', video: chapter('export') },
  done: { helpAnchor: 'done', video: chapter('done') },
  history: { helpAnchor: 'history', video: chapter('history') },
  settings: { helpAnchor: 'setup', video: chapter('setup') },
};

/** 見出しの文言キー（ja / en の両方の辞書にある） */
export const GUIDE_TOPIC_TITLE_KEYS: Record<GuideTopicId, MessageKey> = {
  home: 'guide.topicHome',
  protocol: 'guide.topicProtocol',
  blocks: 'guide.topicBlocks',
  seeds: 'guide.topicSeeds',
  draft: 'guide.topicDraft',
  expand: 'guide.topicExpand',
  edit: 'guide.topicEdit',
  export: 'guide.topicExport',
  done: 'guide.topicDone',
  history: 'guide.topicHistory',
  settings: 'guide.topicSettings',
};

export const HELP_PAGE_URL = 'https://youkiti.github.io/sr-query-builder-plugin/help.html';

export function isGuideTopicId(value: unknown): value is GuideTopicId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(GUIDE_TOPICS, value);
}

/** ルート名からトピック ID を引く（今は同じ文字列） */
export function topicForRoute(route: RouteName): GuideTopicId {
  return route;
}

/** 公開ヘルプの該当節の URL。hosted/lang.js は ?lang= を読む */
export function buildHelpUrl(topicId: GuideTopicId, lang: UiLanguage): string {
  return `${HELP_PAGE_URL}?lang=${lang}#${GUIDE_TOPICS[topicId].helpAnchor}`;
}

/** 解説動画の該当章を、開始秒を付けて開く URL */
export function buildVideoUrl(video: { youtubeId: string; startSec: number }): string {
  return `https://youtu.be/${video.youtubeId}?t=${video.startSec}`;
}
