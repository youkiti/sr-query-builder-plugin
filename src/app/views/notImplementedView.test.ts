import { INITIAL_STATE } from '../store';
import { buildNotImplementedView } from './notImplementedView';

describe('buildNotImplementedView', () => {
  test('ルート名のラベルと未実装メッセージを描画する', () => {
    const doc = document.implementation.createHTMLDocument('test');
    const container = doc.createElement('div');
    const render = buildNotImplementedView('seeds');
    render(container, { state: INITIAL_STATE, navigate: jest.fn() });
    expect(container.querySelector('h2')?.textContent).toBe('シード論文');
    expect(container.querySelector('.view__placeholder')?.textContent).toContain('未実装');
  });
});
