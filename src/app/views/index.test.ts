import { ROUTES } from '../router';
import { createStore } from '../store';
import {
  buildNotImplementedView,
  buildViews,
  createBlocksView,
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

  test('home / protocol は固定の render 関数を使う', () => {
    const views = buildViews(createStore());
    expect(views.home).toBe(renderHomeView);
    expect(views.protocol).toBe(renderProtocolView);
  });

  test('blocks の callback を options 経由で差し込める', () => {
    const views = buildViews(createStore(), { blocks: { onSaveDraft: jest.fn() } });
    expect(typeof views.blocks).toBe('function');
  });

  test('再エクスポートが揃っている', () => {
    expect(typeof buildNotImplementedView).toBe('function');
    expect(typeof createBlocksView).toBe('function');
  });
});
