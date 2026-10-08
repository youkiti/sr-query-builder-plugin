import { INITIAL_STATE, type AppState } from '../store';
import { computeGuideConditions } from './tourConditions';
import { guideEvents, isSatisfiedByRoute, routeGuideEvent } from './guideEvents';
import { GETTING_STARTED_ADAPTER } from './adapters/gettingStarted';
import { DRAFT_AND_OPTIMIZE_ADAPTER } from './adapters/draftAndOptimize';
import { EXPAND_SEEDS_ADAPTER } from './adapters/expandSeeds';
import { EDIT_AND_EXPORT_ADAPTER } from './adapters/editAndExport';
import { evaluateGuards } from '../guards';
import { GUIDE_TOURS } from '../../lib/guide/tours';

const createInitialState = (): AppState => INITIAL_STATE;
const project = { projectId: 'p', spreadsheetId: 's', driveFolderId: 'd', title: 't' };
const protocolDraft = {} as AppState['protocolDraft'];
const blocksDraft = { blocks: [{ blockLabel: 'a', description: '', aiGenerated: true, note: '' }], combinationExpression: '#1' };

/** ブロック承認済み（#/draft を開ける）の状態 */
const approved = (): AppState => ({
  ...createInitialState(), project, protocolDraft, protocolDraftPersisted: true, currentProtocolVersion: 1, blocksDraft,
});
/** 検索式がある（#/expand・#/edit を開ける）状態 */
const withFormula = (): AppState => ({ ...approved(), currentFormulaVersionId: 'v1', currentFormulaMarkdown: '#1 x' });

test('プロジェクトとプロトコルの有無から条件を作る。プロトコルは #/blocks を開ける条件と同じ', () => {
  const empty = createInitialState();
  expect(computeGuideConditions(empty)).toMatchObject({ 'has-project': false, 'has-protocol': false });
  const withProject: AppState = { ...empty, project };
  expect(computeGuideConditions(withProject)).toMatchObject({ 'has-project': true, 'has-protocol': false });
  const withProtocol: AppState = { ...withProject, protocolDraft };
  expect(computeGuideConditions(withProtocol)).toMatchObject({ 'has-project': true, 'has-protocol': true });
  for (const state of [empty, withProject, withProtocol]) {
    expect(computeGuideConditions(state)['has-protocol']).toBe(evaluateGuards(state).blocks.enabled);
  }
  // プロジェクトが無ければプロトコルがあっても偽（ガードがプロジェクトを先に要求するため）
  expect(computeGuideConditions({ ...empty, protocolDraft })['has-protocol']).toBe(false);
});

test('全ツアーの条件が計算され、初期状態ではツアー固有の条件が「使えない」側になる', () => {
  expect(computeGuideConditions(createInitialState())).toEqual({
    'has-project': false, 'has-protocol': false, 'blocks-approved': false,
    'blocks-unavailable': true, 'seeds-unavailable': true, 'approve-blocks-not-needed': true,
    'draft-unavailable': true, 'optimization-running': false,
    'expand-unavailable': true, 'expand-candidates-ready': false,
    'edit-unavailable': true, 'export-unavailable': true, 'formula-save-done': false,
  });
});

test('はじめての流れ: ブロックの承認済みは、#/draft を開けて、かつプロトコルが保存済みのとき', () => {
  expect(GETTING_STARTED_ADAPTER.conditions(createInitialState())).toMatchObject({ 'blocks-approved': false });
  expect(GETTING_STARTED_ADAPTER.conditions(approved())).toMatchObject({ 'blocks-approved': true });
  // 新しいプロトコルを解析した直後（未保存）は、版番号が残っていても承認済みとは見なさない
  expect(GETTING_STARTED_ADAPTER.conditions({ ...approved(), protocolDraftPersisted: false })).toMatchObject({ 'blocks-approved': false });
  expect(GETTING_STARTED_ADAPTER.conditions({ ...approved(), project: null })).toMatchObject({ 'blocks-approved': false });
  expect(GETTING_STARTED_ADAPTER.risingEvents).toEqual({ 'has-protocol': 'protocol-analyzed', 'blocks-approved': 'blocks-approved' });
});

test('はじめての流れ: 開けない画面に関わる手順を飛ばす条件は、evaluateGuards の blocks / seeds に合わせる', () => {
  const states: Record<string, AppState> = {
    initial: createInitialState(),
    projectOnly: { ...createInitialState(), project },
    analyzed: { ...createInitialState(), project, protocolDraft },
    approved: approved(),
  };
  const expected: Record<string, Record<string, boolean>> = {
    initial: { 'blocks-unavailable': true, 'seeds-unavailable': true, 'approve-blocks-not-needed': true },
    projectOnly: { 'blocks-unavailable': true, 'seeds-unavailable': false, 'approve-blocks-not-needed': true },
    analyzed: { 'blocks-unavailable': false, 'seeds-unavailable': false, 'approve-blocks-not-needed': false },
    approved: { 'blocks-unavailable': false, 'seeds-unavailable': false, 'approve-blocks-not-needed': true },
  };
  for (const [name, state] of Object.entries(states)) {
    expect([name, GETTING_STARTED_ADAPTER.conditions(state)]).toEqual([name, { ...expected[name], 'blocks-approved': name === 'approved' }]);
    const guards = evaluateGuards(state);
    expect(GETTING_STARTED_ADAPTER.conditions(state)['blocks-unavailable']).toBe(!guards.blocks.enabled);
    expect(GETTING_STARTED_ADAPTER.conditions(state)['seeds-unavailable']).toBe(!guards.seeds.enabled);
  }
});

test('検索式の作成と自動調整: #/draft を開けるかと、自動調整の実行中かを条件にする', () => {
  expect(DRAFT_AND_OPTIMIZE_ADAPTER.conditions(createInitialState())).toEqual({ 'draft-unavailable': true, 'optimization-running': false });
  const ready = DRAFT_AND_OPTIMIZE_ADAPTER.conditions(approved());
  expect(ready).toEqual({ 'draft-unavailable': false, 'optimization-running': false });
  expect(ready['draft-unavailable']).toBe(!evaluateGuards(approved()).draft.enabled);
  const running = { ...approved(), queryOptimizationRun: { status: 'running' } as AppState['queryOptimizationRun'] };
  expect(DRAFT_AND_OPTIMIZE_ADAPTER.conditions(running)['optimization-running']).toBe(true);
  const finished = { ...approved(), queryOptimizationRun: { status: 'ready' } as AppState['queryOptimizationRun'] };
  expect(DRAFT_AND_OPTIMIZE_ADAPTER.conditions(finished)['optimization-running']).toBe(false);
  expect(DRAFT_AND_OPTIMIZE_ADAPTER.risingEvents).toEqual({ 'optimization-running': 'optimization-started' });
});

test('シードの拡張: #/expand を開けるかと、候補の取得が済んでいるかを条件にする', () => {
  expect(EXPAND_SEEDS_ADAPTER.conditions(approved())).toEqual({ 'expand-unavailable': true, 'expand-candidates-ready': false });
  const ready = EXPAND_SEEDS_ADAPTER.conditions(withFormula());
  expect(ready['expand-unavailable']).toBe(!evaluateGuards(withFormula()).expand.enabled);
  expect(ready['expand-unavailable']).toBe(false);
  for (const [status, expected] of [['running', false], ['error', false], ['ready', true]] as const) {
    const state = { ...withFormula(), expandRun: { status } as AppState['expandRun'] };
    expect(EXPAND_SEEDS_ADAPTER.conditions(state)['expand-candidates-ready']).toBe(expected);
  }
  expect(EXPAND_SEEDS_ADAPTER.risingEvents).toEqual({ 'expand-candidates-ready': 'expand-candidates-fetched' });
});

test('編集と書き出し: #/edit を開けるかと、検索式の保存が完了したかを条件にする', () => {
  expect(EDIT_AND_EXPORT_ADAPTER.conditions(approved())['edit-unavailable']).toBe(true);
  const ready = EDIT_AND_EXPORT_ADAPTER.conditions(withFormula());
  expect(ready).toEqual({ 'edit-unavailable': false, 'export-unavailable': false, 'formula-save-done': false });
  // 保存済みの版が無く、編集下書きだけで #/edit に入れる状態では、#/export は開けない
  const draftOnly: AppState = {
    ...approved(), formulaEditDraft: { formulaVersionId: null, markdown: '#1 x' },
  };
  expect(EDIT_AND_EXPORT_ADAPTER.conditions(draftOnly)).toEqual({ 'edit-unavailable': false, 'export-unavailable': true, 'formula-save-done': false });
  expect(evaluateGuards(draftOnly).export.enabled).toBe(false);
  expect(ready['edit-unavailable']).toBe(!evaluateGuards(withFormula()).edit.enabled);
  for (const [status, expected] of [['saving', false], ['error', false], ['saved', true]] as const) {
    const state = { ...withFormula(), formulaSave: { formulaVersionId: 'v1', status, error: null } as AppState['formulaSave'] };
    expect(EDIT_AND_EXPORT_ADAPTER.conditions(state)['formula-save-done']).toBe(expected);
  }
  expect(EDIT_AND_EXPORT_ADAPTER.risingEvents).toEqual({ 'formula-save-done': 'formula-saved' });
});

test('状態の立ち上がりだけをイベントにする（下がるときや、変わらないときは出ない）', () => {
  const before = computeGuideConditions(createInitialState());
  const withProject = computeGuideConditions({ ...createInitialState(), project });
  expect(guideEvents(before, withProject)).toEqual([]);
  expect(guideEvents(withProject, before)).toEqual([]);

  const analyzed = computeGuideConditions({ ...createInitialState(), project, protocolDraft });
  expect(guideEvents(withProject, analyzed)).toEqual(['protocol-analyzed']);
  expect(guideEvents(analyzed, analyzed)).toEqual([]);
  expect(guideEvents(analyzed, withProject)).toEqual([]);

  const approvedConditions = computeGuideConditions(approved());
  expect(guideEvents(analyzed, approvedConditions)).toEqual(['blocks-approved']);

  const optimizing = computeGuideConditions({ ...approved(), queryOptimizationRun: { status: 'running' } as AppState['queryOptimizationRun'] });
  expect(guideEvents(approvedConditions, optimizing)).toEqual(['optimization-started']);

  const formula = computeGuideConditions(withFormula());
  const fetched = computeGuideConditions({ ...withFormula(), expandRun: { status: 'ready' } as AppState['expandRun'] });
  expect(guideEvents(formula, fetched)).toEqual(['expand-candidates-fetched']);

  const saved = computeGuideConditions({
    ...withFormula(), formulaSave: { formulaVersionId: 'v2', status: 'saved', error: null },
  });
  expect(guideEvents(formula, saved)).toEqual(['formula-saved']);
});

test('画面を開いたイベント名と、その画面を開く手順の判定', () => {
  expect(routeGuideEvent('#/protocol')).toBe('route-opened-protocol');
  expect(routeGuideEvent('#/home')).toBe('route-opened-home');
  const open = GUIDE_TOURS['getting-started'].steps.find(step => step.id === 'open-protocol')!;
  expect(isSatisfiedByRoute(open, '#/protocol')).toBe(true);
  expect(isSatisfiedByRoute(open, '#/home')).toBe(false);
  expect(isSatisfiedByRoute(GUIDE_TOURS['getting-started'].steps[0]!, '#/home')).toBe(false);
  const openDraft = GUIDE_TOURS['draft-and-optimize'].steps.find(step => step.id === 'open-draft')!;
  expect(isSatisfiedByRoute(openDraft, '#/draft')).toBe(true);
});
