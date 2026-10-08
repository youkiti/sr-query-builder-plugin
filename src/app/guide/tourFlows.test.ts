import { createTourRunner } from './tourRunner';
import { computeGuideConditions } from './tourConditions';
import { guideEvents } from './guideEvents';
import { INITIAL_STATE, type AppState } from '../store';
import { createEmptyGuideProgress, type GuideProgress } from '../../lib/guide/tourProgress';
import * as storage from '../../lib/guide/guideProgressStore';
import { setUiLanguage } from '../../lib/i18n';

// 実物のツアー定義と実物の条件計算で、手順を省略したときに最後まで進めて完了できることを確かめる。
jest.mock('../../lib/guide/guideProgressStore');

const project = { projectId: 'p', spreadsheetId: 's', driveFolderId: 'd', title: 't' };
let progress: GuideProgress;
let listeners: Set<() => void>;
let state: AppState;
let route: string;
let runner: ReturnType<typeof createTourRunner>;

const card = (): HTMLElement | null => document.querySelector('.guide-tour-card');
const action = (name: string): HTMLButtonElement => document.querySelector(`[data-guide-action="${name}"]`)!;
const step = (): string | undefined => card()?.dataset.guideStep;
const position = (): string => card()?.querySelectorAll('p')[1]?.textContent ?? '';

/** 状態を差し替え、立ち上がりのイベントをランナーへ渡す（実際の initGuide と同じ順序）。 */
function setState(next: AppState): void {
  const before = computeGuideConditions(state);
  state = next;
  guideEvents(before, computeGuideConditions(state)).forEach(event => runner.handleEvent(event));
}
function openRoute(next: string): void {
  route = next;
  runner.handleEvent(`route-opened-${next.slice(2)}` as never);
}

beforeEach(() => {
  setUiLanguage('ja');
  document.body.replaceChildren();
  progress = createEmptyGuideProgress(); listeners = new Set(); route = '#/home'; state = INITIAL_STATE;
  jest.mocked(storage.getGuideProgress).mockImplementation(() => progress);
  jest.mocked(storage.updateGuideProgress).mockImplementation(update => { progress = update(progress); });
  jest.mocked(storage.subscribeGuideProgressChange).mockImplementation(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; });
  runner = createTourRunner({
    computeConditions: () => computeGuideConditions(state), currentRoute: () => route, navigate: jest.fn(),
  });
});
afterEach(() => { runner.stop(); });

test('プロトコル未解析で始めて「押さずに次へ」で進むと、開けない画面の手順は飛ばされ、完了できる（プロジェクトなし）', () => {
  runner.start('getting-started');
  expect(step()).toBe('welcome');
  // 開けない画面（blocks・seeds）の手順は分母に入らない
  expect(position()).toBe('1 / 4');
  action('next').click();
  expect(step()).toBe('open-protocol');
  expect(position()).toBe('2 / 4');
  openRoute('#/protocol');
  expect(step()).toBe('enter-protocol');
  expect(position()).toBe('3 / 4');
  action('skip').click();
  expect(step()).toBe('finish');
  expect(position()).toBe('4 / 4');
  action('next').click();
  expect(card()).toBeNull();
  expect(progress.tours['getting-started']?.status).toBe('done');
});

test('プロトコル未解析でもプロジェクトがあれば、シード論文の手順は残り、そこまで進んで完了できる', () => {
  state = { ...INITIAL_STATE, project };
  runner.start('getting-started');
  expect(position()).toBe('1 / 6');
  action('next').click();
  openRoute('#/protocol');
  expect(step()).toBe('enter-protocol');
  action('skip').click();
  expect(step()).toBe('open-seeds');
  expect(position()).toBe('4 / 6');
  openRoute('#/seeds');
  expect(step()).toBe('add-seeds');
  action('next').click();
  expect(step()).toBe('finish');
  expect(position()).toBe('6 / 6');
  action('next').click();
  expect(progress.tours['getting-started']?.status).toBe('done');
});

test('保存済みバージョンが無く #/edit だけ開ける状態で、保存を省略すると、エクスポートの手順は飛ばされ、完了できる', () => {
  state = {
    ...INITIAL_STATE, project, protocolDraft: {} as AppState['protocolDraft'], protocolDraftPersisted: true,
    currentProtocolVersion: 1,
    blocksDraft: { blocks: [{ blockLabel: 'a', description: '', aiGenerated: true, note: '' }], combinationExpression: '#1' },
    formulaEditDraft: { formulaVersionId: null, markdown: '#1 x' },
  };
  runner.start('edit-and-export');
  expect(step()).toBe('open-edit');
  expect(position()).toBe('1 / 5');
  openRoute('#/edit');
  expect(step()).toBe('edit-blocks');
  action('next').click();
  expect(step()).toBe('inspect-block');
  action('next').click();
  expect(step()).toBe('save-version');
  expect(position()).toBe('4 / 5');
  action('skip').click();
  expect(step()).toBe('finish');
  expect(position()).toBe('5 / 5');
  action('next').click();
  expect(card()).toBeNull();
  expect(progress.tours['edit-and-export']?.status).toBe('done');
});

test('保存済みバージョンがあれば、エクスポートの手順も表示される', () => {
  state = {
    ...INITIAL_STATE, project, protocolDraft: {} as AppState['protocolDraft'], protocolDraftPersisted: true,
    currentProtocolVersion: 1,
    blocksDraft: { blocks: [{ blockLabel: 'a', description: '', aiGenerated: true, note: '' }], combinationExpression: '#1' },
    currentFormulaVersionId: 'v1', currentFormulaMarkdown: '#1 x',
  };
  runner.start('edit-and-export');
  expect(position()).toBe('1 / 8');
  openRoute('#/edit');
  action('next').click();
  action('next').click();
  expect(step()).toBe('save-version');
  action('skip').click();
  expect(step()).toBe('open-export');
  openRoute('#/export');
  expect(step()).toBe('run-export');
  action('next').click();
  expect(step()).toBe('convert-databases');
  action('next').click();
  expect(step()).toBe('finish');
});

test('保存で #/export が開けるようになったら、保存の完了イベントで進み、エクスポートの手順が現れる', () => {
  const base: AppState = {
    ...INITIAL_STATE, project, protocolDraft: {} as AppState['protocolDraft'], protocolDraftPersisted: true,
    currentProtocolVersion: 1,
    blocksDraft: { blocks: [{ blockLabel: 'a', description: '', aiGenerated: true, note: '' }], combinationExpression: '#1' },
    formulaEditDraft: { formulaVersionId: null, markdown: '#1 x' },
  };
  state = base;
  runner.start('edit-and-export');
  openRoute('#/edit');
  action('next').click();
  action('next').click();
  expect(step()).toBe('save-version');
  setState({
    ...base, currentFormulaVersionId: 'v2', currentFormulaMarkdown: '#1 x',
    formulaSave: { formulaVersionId: 'v2', status: 'saved', error: null },
  });
  expect(step()).toBe('open-export');
});
