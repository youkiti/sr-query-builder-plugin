import { createHelpButton, mountHelpButtons, topicTitle } from './helpButton';
import { setUiLanguage } from '../../lib/i18n';

let content: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = '<main id="app-content"></main>';
  content = document.getElementById('app-content')!;
});
afterEach(() => { setUiLanguage('ja'); });

test('ボタンは textContent が空で、ヘルプの属性とトピックの aria-label を持つ', () => {
  const button = createHelpButton(document, 'protocol');
  expect(button.tagName).toBe('BUTTON');
  expect(button.type).toBe('button');
  expect(button.className).toBe('guide-help-btn');
  expect(button.dataset.help).toBe('protocol');
  expect(button.getAttribute('aria-haspopup')).toBe('dialog');
  expect(button.getAttribute('aria-expanded')).toBe('false');
  expect(button.getAttribute('aria-label')).toBe('プロトコル入力 のヘルプ');
  expect(button.textContent).toBe('');
});

test('英語では aria-label も英語になる', () => {
  setUiLanguage('en');
  expect(topicTitle('settings')).toBe('Settings');
  expect(createHelpButton(document, 'settings').getAttribute('aria-label')).toBe('Help: Settings');
});

test('最初の h2 の直後の兄弟に 1 つだけ差し、h2 の中身は変えない。何度呼んでも増えない', () => {
  content.innerHTML = '<h2>ホーム</h2><h2>二つ目</h2>';
  mountHelpButtons(content, 'home');
  mountHelpButtons(content, 'home');
  const headings = content.querySelectorAll('h2');
  expect(headings[0]!.textContent).toBe('ホーム');
  expect(headings[0]!.querySelector('button')).toBeNull();
  expect(headings[0]!.nextElementSibling!.classList.contains('guide-help-btn')).toBe(true);
  expect(headings[1]!.previousElementSibling!.classList.contains('guide-help-btn')).toBe(true);
  expect(headings[1]!.nextElementSibling).toBeNull();
  expect(content.querySelectorAll('.guide-help-btn')).toHaveLength(1);
});

test('ルートが変わればトピックを付け替える。言語が変われば aria-label を更新する', () => {
  content.innerHTML = '<h2>見出し</h2>';
  mountHelpButtons(content, 'home');
  mountHelpButtons(content, 'blocks');
  const buttons = content.querySelectorAll<HTMLElement>('.guide-help-btn');
  expect(buttons).toHaveLength(1);
  expect(buttons[0]!.dataset.help).toBe('blocks');
  setUiLanguage('en');
  mountHelpButtons(content, 'blocks');
  expect(buttons[0]!.getAttribute('aria-label')).toBe('Help: Approve blocks');
});

test('h2 が無ければ何もしない', () => {
  content.innerHTML = '<h3>見出し</h3><p>本文</p>';
  mountHelpButtons(content, 'home');
  expect(content.querySelector('.guide-help-btn')).toBeNull();
});

test('先頭の見出しが入れ替わったら、取り残された「?」を片づけて新しい見出しの直後に差す', () => {
  content.innerHTML = '<h2 id="a">A</h2>';
  mountHelpButtons(content, 'home');
  content.prepend(Object.assign(document.createElement('h2'), { id: 'first', textContent: '先頭' }));
  mountHelpButtons(content, 'home');
  expect(content.querySelectorAll('.guide-help-btn')).toHaveLength(1);
  expect(document.getElementById('first')!.nextElementSibling!.classList.contains('guide-help-btn')).toBe(true);
  expect(document.getElementById('a')!.nextElementSibling).toBeNull();
});

test('見出しの子にあるボタンは対象の兄弟ではないので外す', () => {
  content.innerHTML = '<h2>見出し<button class="guide-help-btn" data-help="home" data-help-for="heading"></button></h2>';
  mountHelpButtons(content, 'home');
  expect(content.querySelector('h2')!.querySelector('button')).toBeNull();
  expect(content.querySelectorAll('.guide-help-btn')).toHaveLength(1);
});

test('data-help-topic の要素にも直後へ差す。h2 自身が持つ場合は属性のトピックを使い、ルートのトピックでは上書きしない', () => {
  content.innerHTML = '<h2>見出し</h2><div id="panel" data-help-topic="seeds"><p>本文</p></div><div id="bad" data-help-topic="nope"></div>';
  mountHelpButtons(content, 'home');
  mountHelpButtons(content, 'home');
  const panelButton = document.getElementById('panel')!.nextElementSibling as HTMLElement;
  expect(panelButton.classList.contains('guide-help-btn')).toBe(true);
  expect(panelButton.dataset.help).toBe('seeds');
  expect(document.getElementById('panel')!.querySelector('.guide-help-btn')).toBeNull();
  expect(document.getElementById('bad')!.nextElementSibling).toBeNull();
  expect(content.querySelectorAll('.guide-help-btn')).toHaveLength(2);
  content.innerHTML = '<h2 data-help-topic="export">出力</h2>';
  mountHelpButtons(content, 'home');
  mountHelpButtons(content, 'home');
  const buttons = content.querySelectorAll<HTMLElement>('.guide-help-btn');
  expect(buttons).toHaveLength(1);
  expect(buttons[0]!.dataset.help).toBe('export');
});

test('同じ対象の直後に複数あれば 1 つに減らす', () => {
  content.innerHTML = '<h2>見出し</h2><button class="guide-help-btn" data-help="home" data-help-for="heading"></button><button class="guide-help-btn" data-help="home" data-help-for="heading"></button>';
  mountHelpButtons(content, 'home');
  expect(content.querySelectorAll('.guide-help-btn')).toHaveLength(1);
});
