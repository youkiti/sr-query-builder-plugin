import { ROUTES } from '../router';
import { createStore } from '../store';
import {
  buildNotImplementedView,
  buildViews,
  createBlocksView,
  createDraftView,
  createExportView,
  createProtocolView,
  createEditView,
  createExpandView,
  createHistoryView,
  createSeedsView,
  createValidateView,
  renderDoneView,
  renderHomeView,
  renderProtocolView,
} from './index';

describe('buildViews', () => {
  test('全ルートに render 関数が定義されている', () => {
    const views = buildViews(createStore());
    for (const route of ROUTES) {
      expect(typeof views[route]).toBe('function');
    }
  });

  test('home も createHomeView 経由で都度生成される（render 関数が生える）', () => {
    const views = buildViews(createStore());
    expect(typeof views.home).toBe('function');
    // protocol も createProtocolView 経由で都度生成されるため参照比較は不可
    expect(typeof views.protocol).toBe('function');
  });

  test('home callback も options 経由で差し込める', () => {
    const onOpenPopup = jest.fn();
    const views = buildViews(createStore(), { home: { onOpenPopup } });
    expect(typeof views.home).toBe('function');
  });

  test('renderHomeView は後方互換の再エクスポートとして関数', () => {
    expect(typeof renderHomeView).toBe('function');
  });

  test('done は renderDoneView を使う', () => {
    const views = buildViews(createStore());
    expect(views.done).toBe(renderDoneView);
  });

  test('blocks の callback を options 経由で差し込める', () => {
    const views = buildViews(createStore(), { blocks: { onSaveDraft: jest.fn() } });
    expect(typeof views.blocks).toBe('function');
  });

  test('再エクスポートが揃っている', () => {
    expect(typeof buildNotImplementedView).toBe('function');
    expect(typeof createBlocksView).toBe('function');
    expect(typeof renderProtocolView).toBe('function');
    expect(typeof createProtocolView).toBe('function');
    expect(typeof createDraftView).toBe('function');
    expect(typeof createExportView).toBe('function');
    expect(typeof createSeedsView).toBe('function');
    expect(typeof createValidateView).toBe('function');
    expect(typeof renderDoneView).toBe('function');
    expect(typeof createHistoryView).toBe('function');
    expect(typeof createEditView).toBe('function');
    expect(typeof createExpandView).toBe('function');
  });

  test('history callback も options 経由で差し込める', () => {
    const onList = jest.fn();
    const onLoad = jest.fn();
    const views = buildViews(createStore(), { history: { onList, onLoad } });
    expect(typeof views.history).toBe('function');
  });

  test('edit callback も options 経由で差し込める', () => {
    const onSave = jest.fn();
    const views = buildViews(createStore(), { edit: { onSave } });
    expect(typeof views.edit).toBe('function');
  });

  test('expand callback も options 経由で差し込める', () => {
    const onFetch = jest.fn();
    const onDecide = jest.fn();
    const views = buildViews(createStore(), { expand: { onFetch, onDecide } });
    expect(typeof views.expand).toBe('function');
  });

  test('draft callback も options 経由で差し込める', () => {
    const onGenerate = jest.fn();
    const views = buildViews(createStore(), { draft: { onGenerate } });
    expect(typeof views.draft).toBe('function');
  });

  test('export callback も options 経由で差し込める', () => {
    const onExport = jest.fn();
    const views = buildViews(createStore(), { export: { onExport } });
    expect(typeof views.export).toBe('function');
  });

  test('seeds / validate callback も options 経由で差し込める', () => {
    const onIngest = jest.fn();
    const onRun = jest.fn();
    const views = buildViews(createStore(), {
      seeds: { onIngest },
      validate: { onRun },
    });
    expect(typeof views.seeds).toBe('function');
    expect(typeof views.validate).toBe('function');
  });

  test('protocol callback も options 経由で差し込める', () => {
    const onSubmit = jest.fn();
    const views = buildViews(createStore(), { protocol: { onSubmit } });
    expect(typeof views.protocol).toBe('function');
  });
});
