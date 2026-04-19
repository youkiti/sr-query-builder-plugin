import { ROUTES } from '../router';
import { createStore } from '../store';
import {
  buildNotImplementedView,
  buildViews,
  createBlocksView,
  createDraftView,
  createExportView,
  createProtocolView,
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

  test('home は固定の render 関数を使う', () => {
    const views = buildViews(createStore());
    expect(views.home).toBe(renderHomeView);
    // protocol は createProtocolView 経由で都度生成されるため参照比較は不可
    expect(typeof views.protocol).toBe('function');
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

  test('protocol callback も options 経由で差し込める', () => {
    const onSubmit = jest.fn();
    const views = buildViews(createStore(), { protocol: { onSubmit } });
    expect(typeof views.protocol).toBe('function');
  });
});
