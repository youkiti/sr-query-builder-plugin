import { ROUTES } from '../router';
import { VIEWS, buildNotImplementedView, renderHomeView, renderProtocolView } from './index';

describe('views/index', () => {
  test('全ルートに render 関数が定義されている', () => {
    for (const route of ROUTES) {
      expect(typeof VIEWS[route]).toBe('function');
    }
  });

  test('home と protocol は専用 view を使う', () => {
    expect(VIEWS.home).toBe(renderHomeView);
    expect(VIEWS.protocol).toBe(renderProtocolView);
  });

  test('buildNotImplementedView をそのまま再エクスポートしている', () => {
    expect(typeof buildNotImplementedView).toBe('function');
  });
});
