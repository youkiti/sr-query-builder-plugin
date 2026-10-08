import { createHelpMenu } from './helpMenu';
import { createHelpButton } from './helpButton';
import { setUiLanguage } from '../../lib/i18n';
import { GUIDE_TOURS } from '../../lib/guide/tours';
import { GUIDE_TOPICS, type GuideTopicId } from '../../lib/guide/topics';
import { useTestTours } from '../../../tests/fixtures/guideTours';

useTestTours([GUIDE_TOURS['getting-started']]);

const start = jest.fn();
const openTourList = jest.fn();
let menu: ReturnType<typeof createHelpMenu>;

const menuElement = (): HTMLElement | null => document.querySelector('.guide-help-menu');
const items = (): HTMLElement[] => Array.from(menuElement()?.querySelectorAll<HTMLElement>('a, button') ?? []);
const labels = (): string[] => items().map(item => item.textContent ?? '');
const mountButton = (topic: GuideTopicId): HTMLButtonElement => {
  const button = createHelpButton(document, topic);
  document.getElementById('heading')!.append(button);
  return button;
};

beforeEach(() => {
  document.body.innerHTML = '<main id="app-content"><h2 id="heading">見出し</h2></main>';
  start.mockReset(); openTourList.mockReset();
  menu = createHelpMenu(document, { conditions: () => ({ 'has-project': true }), start, openTourList });
});
afterEach(() => { menu.destroy(); setUiLanguage('ja'); });

test('「?」を押すとメニューが開き、最初の項目にフォーカスし、aria-expanded を true にする', () => {
  const button = mountButton('home');
  button.click();
  const element = menuElement()!;
  expect(element.getAttribute('role')).toBe('dialog');
  expect(element.getAttribute('aria-label')).toBe('ホーム');
  expect(button.getAttribute('aria-expanded')).toBe('true');
  expect(document.activeElement).toBe(items()[0]);
  expect(labels()).toEqual(['ヘルプを読む', 'この機能の動画を見る', 'ここからツアーを始める', 'ツアーの一覧']);
});

test('リンクの href と target / rel。言語は現在の表示言語', () => {
  mountButton('home').click();
  const [read, video] = items() as HTMLAnchorElement[];
  expect(read!.href).toBe('https://youkiti.github.io/sr-query-builder-plugin/help.html?lang=ja#project');
  expect(video!.href).toBe('https://youtu.be/RqUFlmncuIE?t=174');
  for (const anchor of [read!, video!]) {
    expect(anchor.target).toBe('_blank');
    expect(anchor.rel).toBe('noopener noreferrer');
  }
  setUiLanguage('en');
  menu.refresh();
  expect((items()[0] as HTMLAnchorElement).href).toContain('?lang=en#project');
});

test('ツアーが無いトピックでは「ここからツアーを始める」を出さない', () => {
  mountButton('settings').click();
  expect(labels()).toEqual(['ヘルプを読む', 'この機能の動画を見る', 'ツアーの一覧']);
  expect((items()[1] as HTMLAnchorElement).href).toBe('https://youtu.be/RqUFlmncuIE?t=66');
});

describe('ツアーが今は使えないとき', () => {
  useTestTours([]);
  test('「ここからツアーを始める」を出さない', () => {
    mountButton('home').click();
    expect(labels()).toEqual(['ヘルプを読む', 'この機能の動画を見る', 'ツアーの一覧']);
  });
});

test('動画の無いトピックでは動画の項目を出さない', () => {
  const saved = GUIDE_TOPICS.blocks.video;
  delete GUIDE_TOPICS.blocks.video;
  try {
    mountButton('blocks').click();
    expect(labels()).toEqual(['ヘルプを読む', 'ツアーの一覧']);
  } finally {
    GUIDE_TOPICS.blocks.video = saved;
  }
});

test('「ここからツアーを始める」でメニューを閉じてそのツアーを始める', () => {
  const button = mountButton('protocol');
  button.click();
  items().find(item => item.dataset.helpAction === 'start-tour')!.click();
  expect(start).toHaveBeenCalledWith('getting-started');
  expect(menuElement()).toBeNull();
  expect(button.getAttribute('aria-expanded')).toBe('false');
});

test('「ツアーの一覧」でメニューを閉じて一覧を開く。同じクリックを外側のクリックとして扱う購読者へ伝えない', () => {
  const outside = jest.fn();
  document.addEventListener('click', outside);
  try {
    mountButton('home').click();
    outside.mockClear();
    items().find(item => item.dataset.helpAction === 'tour-list')!.click();
    expect(openTourList).toHaveBeenCalledTimes(1);
    expect(menuElement()).toBeNull();
    expect(outside).not.toHaveBeenCalled();
  } finally {
    document.removeEventListener('click', outside);
  }
});

test('リンクを選ぶとメニューを閉じる', () => {
  mountButton('home').click();
  items()[0]!.addEventListener('click', event => event.preventDefault());
  items()[0]!.click();
  expect(menuElement()).toBeNull();
});

test('同じ「?」をもう一度押すと閉じる', () => {
  const button = mountButton('home');
  button.click();
  button.click();
  expect(menuElement()).toBeNull();
  expect(button.getAttribute('aria-expanded')).toBe('false');
});

test('別の「?」を押すと付け替える', () => {
  const first = mountButton('home');
  const other = document.createElement('h2');
  document.getElementById('app-content')!.append(other);
  const second = createHelpButton(document, 'settings');
  other.append(second);
  first.click();
  second.click();
  expect(document.querySelectorAll('.guide-help-menu')).toHaveLength(1);
  expect(menuElement()!.getAttribute('aria-label')).toBe('設定');
  expect(first.getAttribute('aria-expanded')).toBe('false');
  expect(second.getAttribute('aria-expanded')).toBe('true');
});

test('Esc で閉じて「?」へフォーカスを戻す。閉じているときの Esc は何もしない', () => {
  const button = mountButton('home');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  expect(document.activeElement).not.toBe(button);
  button.click();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(menuElement()).toBeNull();
  expect(document.activeElement).toBe(button);
  expect(button.getAttribute('aria-expanded')).toBe('false');
});

test('外側のクリックで閉じる。メニューの中の余白のクリックでは閉じない', () => {
  mountButton('home').click();
  menuElement()!.click();
  expect(menuElement()).not.toBeNull();
  document.body.click();
  expect(menuElement()).toBeNull();
});

test('言語切替で文面と aria-label を更新し、フォーカス中の項目を保つ', () => {
  mountButton('home').click();
  items()[1]!.focus();
  setUiLanguage('en');
  menu.refresh();
  expect(labels()).toEqual(['Read the help', 'Watch the video for this feature', 'Start a tour from here', 'All tours']);
  expect(menuElement()!.getAttribute('aria-label')).toBe('Home');
  expect(document.activeElement).toBe(items()[1]);
});

test('閉じているときの refresh は何もしない。同じトピックの「?」が無くなったら閉じる', () => {
  menu.refresh();
  expect(menuElement()).toBeNull();
  const button = mountButton('home');
  button.click();
  button.remove();
  menu.refresh();
  expect(menuElement()).toBeNull();
});

test('描き直しでボタンが同じトピックの新しい要素に替わっても、メニューは開いたまま付け替える', () => {
  const old = mountButton('home');
  old.click();
  items()[1]!.focus();
  old.remove();
  const next = mountButton('home');
  menu.refresh();
  expect(menuElement()).not.toBeNull();
  expect(next.getAttribute('aria-expanded')).toBe('true');
  expect(document.activeElement).toBe(items()[1]);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(menuElement()).toBeNull();
  expect(document.activeElement).toBe(next);
});

test('ボタンが一時的に無い状態の refresh(false) では閉じず、差し直し後の refresh で付け替える', () => {
  const old = mountButton('home');
  old.click();
  old.remove();
  menu.refresh(false);
  expect(menuElement()).not.toBeNull();
  const next = mountButton('home');
  menu.refresh();
  expect(menuElement()).not.toBeNull();
  expect(next.getAttribute('aria-expanded')).toBe('true');
});

test('トピックを読めないボタンでは開いても閉じる', () => {
  const button = mountButton('home');
  button.click();
  button.dataset.help = 'nope';
  menu.refresh();
  expect(menuElement()).toBeNull();
});

test('不明なトピックの「?」では開かない', () => {
  const button = createHelpButton(document, 'home');
  button.dataset.help = 'nope';
  document.getElementById('heading')!.append(button);
  button.click();
  expect(menuElement()).toBeNull();
});

test('開いている間の resize / scroll で位置を計算し直し、後始末で購読を外す', () => {
  const button = mountButton('home');
  button.click();
  jest.spyOn(button, 'getBoundingClientRect').mockReturnValue({ top: 10, bottom: 34, left: 100, right: 124, width: 24, height: 24, x: 100, y: 10, toJSON: () => ({}) });
  window.dispatchEvent(new Event('resize'));
  expect(menuElement()!.style.top).toBe('38px');
  menu.destroy();
  expect(menuElement()).toBeNull();
  button.click();
  expect(menuElement()).toBeNull();
});
