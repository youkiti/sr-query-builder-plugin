import { INITIAL_STATE, createStore } from './store';

describe('createStore', () => {
  test('既定で INITIAL_STATE を返す', () => {
    const store = createStore();
    expect(store.getState()).toEqual(INITIAL_STATE);
  });

  test('initial を渡すとそれが初期状態になる', () => {
    const store = createStore({
      route: 'protocol',
      project: { projectId: 'p', spreadsheetId: 's', driveFolderId: 'd', title: 'T' },
      cumulativeCostUsd: 1.23,
      blocksDraft: null,
      protocolDraftPersisted: false,
      protocolDraft: null,
      currentProtocolVersion: null,
      currentFormulaVersionId: null,
      currentFormulaMarkdown: null,
      draftRun: null,
      expandRun: null,
      validationResult: null,
      missedAnalysis: null,
      excessFilterProposal: null,
      editAutoSave: null,
      blocksDraftSavedAt: null,
      hydrateError: null,
    });
    expect(store.getState().route).toBe('protocol');
  });

  test('setState で状態を更新し、リスナを通知する', () => {
    const store = createStore();
    const listener = jest.fn();
    store.subscribe(listener);
    store.setState((s) => ({ ...s, cumulativeCostUsd: 0.5 }));
    expect(store.getState().cumulativeCostUsd).toBe(0.5);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test('updater が同じオブジェクトを返した場合はリスナ通知しない', () => {
    const store = createStore();
    const listener = jest.fn();
    store.subscribe(listener);
    store.setState((s) => s);
    expect(listener).not.toHaveBeenCalled();
  });

  test('subscribe の戻り値で解除できる', () => {
    const store = createStore();
    const listener = jest.fn();
    const off = store.subscribe(listener);
    off();
    store.setState((s) => ({ ...s, cumulativeCostUsd: 1 }));
    expect(listener).not.toHaveBeenCalled();
  });

  test('複数リスナ全員が呼ばれる', () => {
    const store = createStore();
    const a = jest.fn();
    const b = jest.fn();
    store.subscribe(a);
    store.subscribe(b);
    store.setState((s) => ({ ...s, cumulativeCostUsd: 9 }));
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });
});
