// 相談の小窓を偽の小節・通信・保存領域で検証する。
import { openHelpConsult } from './index';
import { consultHelp } from '@/lib/help-consult/consult';
import { loadHelpSections } from '@/lib/help-consult/load';
import { AI_CONSENT_VERSION } from '@/lib/llm/aiDisclosure';
import { HELP_CONSULT_CONSENT_VERSION } from '../../services/aiConsentService';
import { chromeLlmHostPermissions } from '@/lib/llm/hostPermissions';
import type { ConsultResult } from '@/lib/help-consult/types';
import { setUiLanguage, t } from '@/lib/i18n';
import { createHelpMenu } from '../helpMenu';
import { createHelpButton } from '../helpButton';
import { SAMPLE_TOUR, useTestTours } from '../../../../tests/fixtures/guideTours';

jest.mock('@/lib/help-consult/consult', () => ({ consultHelp: jest.fn() }));
jest.mock('@/lib/help-consult/load', () => ({ loadHelpSections: jest.fn() }));
jest.mock('@/lib/llm/hostPermissions', () => ({
  ...jest.requireActual('@/lib/llm/hostPermissions'),
  chromeLlmHostPermissions: jest.fn(),
}));
const consult = jest.mocked(consultHelp);
const load = jest.mocked(loadHelpSections);
const contains = jest.fn();
const start = jest.fn();
useTestTours([SAMPLE_TOUR]);
let close: () => void;
let data: Record<string, unknown>;
const flush = async (): Promise<void> => {
  for (let index = 0; index < 30; index++) {
    await Promise.resolve();
  }
};
function click(label: string): void {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(node => node.textContent === label);
  expect(button).toBeDefined();
  button!.click();
}
function input(value = 'プロジェクトの作成方法'): void {
  const question = document.querySelector<HTMLTextAreaElement>('.guide-consult textarea')!;
  question.value = value;
  question.dispatchEvent(new Event('input'));
}
const ask = (): HTMLButtonElement => Array.from(document.querySelectorAll('button')).find(node => node.textContent === t('guide.consultAsk'))!;
const panel = (): HTMLElement => document.querySelector('.guide-consult__panel')!;
function setup(initial: Record<string, unknown> = {}): HTMLElement {
  data = { aiConsent: { anthropic: { version: AI_CONSENT_VERSION } }, 'apiKeys.anthropic': 'fake-key', ...initial };
  const store = {
    read: async <T>(key: string): Promise<T | undefined> => data[key] as T | undefined,
    write: async (items: Record<string, unknown>): Promise<void> => { Object.assign(data, items); },
  };
  const trigger = document.createElement('button');
  trigger.textContent = '?';
  document.body.append(trigger);
  trigger.focus();
  close = openHelpConsult(document, trigger, { store, route: 'home', start, conditions: () => ({}) });
  return trigger;
}
beforeEach(() => {
  setUiLanguage('ja');
  start.mockReset();
  contains.mockResolvedValue(true);
  jest.mocked(chromeLlmHostPermissions).mockReturnValue({ contains, request: jest.fn() });
  load.mockResolvedValue([
    { id: 'project-create', kind: 'section', sectionId: 'project', sectionTitle: 'プロジェクト',
      title: 'プロジェクトを作成', when: ['作成したい'], body: 'プロジェクトの作成方法' },
  ]);
  consult.mockReset();
});
afterEach(() => {
  close?.();
  document.body.replaceChildren();
  setUiLanguage('ja');
});
test('メニューの最後の相談から小窓を開く', async () => {
  const button = createHelpButton(document, 'home');
  document.body.append(button);
  const menu = createHelpMenu(document, {
    conditions: () => ({}), start: jest.fn(), openTourList: jest.fn(), openConsult: () => { setup(); },
  });
  button.click();
  expect(document.querySelector('.guide-help-menu')?.lastElementChild?.getAttribute('data-help-action')).toBe('consult');
  click('相談する');
  await flush();
  expect(document.querySelector('.guide-help-menu')).toBeNull();
  expect(panel().getAttribute('aria-modal')).toBe('true');
  menu.destroy();
});
test('初期表示は現在の章のヘルプで、キーなしでも端末内検索と公開下書きを使える', async () => {
  setup({ 'apiKeys.anthropic': '' });
  await flush();
  expect(panel().textContent).toContain('この画面のヘルプ');
  expect(panel().querySelector('a')?.href).toBe('https://youkiti.github.io/sr-query-builder-plugin/help.html?lang=ja#project');
  expect(ask().disabled).toBe(true);
  expect(document.getElementById(ask().getAttribute('aria-describedby')!)?.textContent).toContain('設定画面で API キーを登録');
  input();
  click('ヘルプを検索');
  expect(panel().querySelector('.guide-consult__card h4')?.textContent).toBe('プロジェクトを作成');
  expect(consult).not.toHaveBeenCalled();
  const draft = panel().querySelector<HTMLTextAreaElement>('textarea[readonly]')!;
  expect(draft.value).toContain('Screen: home');
  expect(draft.value).toContain('プロジェクトの作成方法');
  const link = Array.from(panel().querySelectorAll('a')).find(node => node.textContent === 'GitHub で Issue を作る')!;
  const url = new URL(link.href);
  expect(url.origin + url.pathname).toBe('https://github.com/youkiti/sr-query-builder-plugin/issues/new');
  expect(url.searchParams.get('body')).toBe(draft.value);
  expect(link.target).toBe('_blank');
  expect(link.rel).toBe('noopener noreferrer');
});
test.each(['ja', 'en'] as const)('%s の検索後も見出しの階層を保ち、AI 部分に見出しを置く', async lang => {
  setUiLanguage(lang);
  setup();
  await flush();
  const headings = (): HTMLElement[] => Array.from(panel().querySelectorAll('h2, h3, h4'));
  expect(headings()[1]?.textContent).toBe(t('guide.consultCurrent'));
  input();
  click(t('guide.consultSearch'));
  expect(headings().map(node => node.tagName)).toEqual(['H2', 'H3', 'H4', 'H3', 'H3']);
  expect(headings()[1]?.textContent).toBe(lang === 'ja' ? '検索結果' : 'Search results');
  expect(headings()[1]?.hidden).toBe(false);
  expect(headings()[3]?.textContent).toBe(lang === 'ja' ? 'AI に聞く' : 'Ask AI');
  expect(headings()[3]?.nextElementSibling?.tagName).toBe('P');
});
test('すべてのボタンに相談用スタイルを付け、AI への送信だけを強調する', async () => {
  setup();
  await flush();
  const buttons = Array.from(panel().querySelectorAll('button'));
  expect(buttons.length).toBe(6);
  for (const button of buttons) {
    expect(button.classList.contains('guide-consult__btn')).toBe(true);
    expect(button.classList.contains('guide-consult__btn--primary')).toBe(button === ask());
  }
  const header = panel().querySelector('.guide-consult__header')!;
  expect(header.querySelector('h2')?.textContent).toBe(t('guide.consultTitle'));
  expect(header.querySelector('button')?.textContent).toBe(t('guide.consultClose'));
});
test('任意の送信許可が無い場合は社名付きの理由を示して送らない', async () => {
  contains.mockResolvedValue(false);
  setup();
  await flush();
  input();
  expect(ask().disabled).toBe(true);
  expect(panel().textContent).toContain('設定画面で Anthropic への送信を許可');
  expect(contains).toHaveBeenCalledWith({ origins: ['https://api.anthropic.com/*'] });
});
test('質問が空のときと読み込み中は理由付きで送信できない', async () => {
  setup();
  expect(ask().disabled).toBe(true);
  expect(panel().textContent).toContain('読み込み中');
  await flush();
  expect(ask().disabled).toBe(true);
  expect(panel().textContent).toContain('質問を入力');
});
test('既存同意で一問一答し、回答を文字として表示し、質問の変更で消す', async () => {
  consult.mockResolvedValue({ status: 'success', providerId: 'anthropic', model: 'fake', sectionIds: ['project-create'],
    answer: '<img src=x onerror=alert(1)>' });
  setup();
  await flush();
  input();
  click('AI に聞く');
  await flush();
  expect(document.querySelector('.confirmation-modal')).toBeNull();
  const answer = panel().querySelector('.guide-consult__answer')!;
  expect(answer.textContent).toContain('<img src=x onerror=alert(1)>');
  expect(answer.querySelector('img')).toBeNull();
  expect(answer.textContent).toContain('AI の回答は誤ることがあります');
  expect(answer.querySelector('a')?.href).toContain('#project-create');
  expect(consult).toHaveBeenCalledTimes(1);
  input('別の質問');
  expect(answer.textContent).toBe('');
});
test.each<ConsultResult>([
  { status: 'no_match' },
  ...(['rate_limited', 'auth', 'timeout', 'aborted', 'network', 'invalid_response', 'truncated', 'unknown',
    'permission_missing', 'no_key'] as const).map(kind => ({ status: 'failure' as const, kind })),
])('該当なしと各失敗の文言を表示する: %j', async result => {
  consult.mockResolvedValue(result);
  setup();
  await flush();
  input();
  click('AI に聞く');
  await flush();
  const key = result.status === 'failure' ? result.kind : 'no_match';
  expect(panel().querySelector('.guide-consult__answer')?.textContent).toBe(t(`guide.consult_${key}`, { company: 'Anthropic' }));
  expect(consult).toHaveBeenCalledTimes(1);
});
test.each(['中止', '閉じる'])('%s で問い合わせの signal を中止する', async label => {
  consult.mockImplementation(params => new Promise(resolve => {
    params.signal?.addEventListener('abort', () => resolve({ status: 'failure', kind: 'aborted' }));
  }));
  setup();
  await flush();
  input();
  click('AI に聞く');
  await flush();
  expect(ask().disabled).toBe(true);
  expect(panel().textContent).toContain('送信中');
  const signal = consult.mock.calls[0]![0].signal!;
  click(label);
  await flush();
  expect(signal.aborted).toBe(true);
  if (label === '中止') {
    expect(panel().textContent).toContain('問い合わせを中止しました');
  } else {
    expect(document.querySelector('.guide-consult')).toBeNull();
  }
});
test('相談用同意を断ったら送らず、受けたら独立したキーへ記録する', async () => {
  consult.mockResolvedValue({ status: 'no_match' });
  setup({ aiConsent: {} });
  await flush();
  input();
  click('AI に聞く');
  await flush();
  expect(document.querySelector('.confirmation-modal')?.textContent).toContain('api.anthropic.com');
  click('送らずに中止する');
  await flush();
  expect(consult).not.toHaveBeenCalled();
  expect(data.aiConsentHelpConsult).toBeUndefined();
  click('AI に聞く');
  await flush();
  click('同意して続ける');
  await flush();
  expect(data.aiConsentHelpConsult).toEqual({ anthropic: {
    version: HELP_CONSULT_CONSENT_VERSION, acceptedAt: expect.any(String),
  } });
  expect(data.aiConsent).toEqual({});
  expect(consult).toHaveBeenCalledTimes(1);
  click('AI に聞く');
  await flush();
  expect(document.querySelector('.confirmation-modal')).toBeNull();
  expect(consult).toHaveBeenCalledTimes(2);
});
test('Escape で閉じ、背景の inert と元のフォーカスを戻す。Tab は循環する', async () => {
  const trigger = setup();
  await flush();
  expect(trigger.inert).toBe(true);
  const copy = Array.from(panel().querySelectorAll('button')).find(node => node.textContent === '文面をコピー')!;
  copy.focus();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
  expect(document.activeElement?.textContent).toBe('閉じる');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
  expect(document.activeElement).toBe(copy);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(document.querySelector('.guide-consult')).toBeNull();
  expect(trigger.inert).not.toBe(true);
  expect(document.activeElement).toBe(trigger);
});
test('英語表示でも相談用の文言とリンク言語を使う', async () => {
  setUiLanguage('en');
  setup({ aiConsent: {}, 'apiKeys.anthropic': '', 'apiKeys.gemini': 'fake' });
  await flush();
  expect(panel().textContent).toContain('Help for this screen');
  expect(panel().textContent).toContain('Gemini API free tier');
  expect(panel().querySelector('a')?.href).toContain('?lang=en');
  input();
  click('Ask AI');
  await flush();
  expect(document.querySelector('.confirmation-modal')?.textContent).toContain('Only your question');
  click('Cancel without sending');
  await flush();
});
test('対応するツアーを始めると小窓を閉じる', async () => {
  setup();
  await flush();
  click('ツアーを始める');
  expect(start).toHaveBeenCalledWith('getting-started');
  expect(document.querySelector('.guide-consult')).toBeNull();
});
test('対応が無い小節の検索結果にはツアーを出さない', async () => {
  setup();
  await flush();
  input();
  click('ヘルプを検索');
  expect(panel().querySelector('.guide-consult__results')?.textContent).not.toContain('ツアーを始める');
});
test('文面をコピーすると表示中の公開下書きを渡す', async () => {
  const writeText = jest.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  setup();
  await flush();
  input('メール user@example.com を伏せる');
  click('文面をコピー');
  await flush();
  const draft = panel().querySelector<HTMLTextAreaElement>('textarea[readonly]')!;
  expect(writeText).toHaveBeenCalledWith(draft.value);
  expect(draft.value).not.toContain('user@example.com');
  expect(panel().textContent).toContain('コピーしました');
});