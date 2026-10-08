import { INITIAL_STATE, type AppState } from '../store';
import { computeGuideConditions } from './tourConditions';
import { guideEvents, isSatisfiedByRoute, routeGuideEvent } from './guideEvents';
import { GETTING_STARTED_ADAPTER } from './adapters/gettingStarted';
import { evaluateGuards } from '../guards';
import { GUIDE_TOURS } from '../../lib/guide/tours';

const createInitialState = (): AppState => INITIAL_STATE;
const project = { projectId: 'p', spreadsheetId: 's', driveFolderId: 'd', title: 't' };

test('プロジェクトとプロトコルの有無から条件を作る。プロトコルは #/blocks を開ける条件と同じ', () => {
  const empty = createInitialState();
  expect(computeGuideConditions(empty)).toEqual({ 'has-project': false, 'has-protocol': false });
  const withProject: AppState = { ...empty, project };
  expect(computeGuideConditions(withProject)).toEqual({ 'has-project': true, 'has-protocol': false });
  const withProtocol: AppState = { ...withProject, protocolDraft: {} as AppState['protocolDraft'] };
  expect(computeGuideConditions(withProtocol)).toEqual({ 'has-project': true, 'has-protocol': true });
  for (const state of [empty, withProject, withProtocol]) {
    expect(computeGuideConditions(state)['has-protocol']).toBe(evaluateGuards(state).blocks.enabled);
  }
  // プロジェクトが無ければプロトコルがあっても偽（ガードがプロジェクトを先に要求するため）
  expect(computeGuideConditions({ ...empty, protocolDraft: {} as AppState['protocolDraft'] })['has-protocol']).toBe(false);
});

test('このツアー固有の条件・イベントは今は無い', () => {
  expect(GETTING_STARTED_ADAPTER.conditions(createInitialState())).toEqual({});
  expect(GETTING_STARTED_ADAPTER.risingEvents).toEqual({});
});

test('状態の立ち上がりだけをイベントにする（固有の対応が無ければ何も出ない）', () => {
  const before = computeGuideConditions(createInitialState());
  const after = computeGuideConditions({ ...createInitialState(), project });
  expect(guideEvents(before, after)).toEqual([]);
  expect(guideEvents(after, before)).toEqual([]);
});

test('画面を開いたイベント名と、その画面を開く手順の判定', () => {
  expect(routeGuideEvent('#/protocol')).toBe('route-opened-protocol');
  expect(routeGuideEvent('#/home')).toBe('route-opened-home');
  const open = GUIDE_TOURS['getting-started'].steps.find(step => step.id === 'open-protocol')!;
  expect(isSatisfiedByRoute(open, '#/protocol')).toBe(true);
  expect(isSatisfiedByRoute(open, '#/home')).toBe(false);
  expect(isSatisfiedByRoute(GUIDE_TOURS['getting-started'].steps[0]!, '#/home')).toBe(false);
});
