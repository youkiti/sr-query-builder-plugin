import { INITIAL_STATE } from '../store';
import { renderProtocolView } from './protocolView';

function buildContainer(): HTMLElement {
  const doc = document.implementation.createHTMLDocument('test');
  const div = doc.createElement('div');
  doc.body.appendChild(div);
  return div;
}

describe('renderProtocolView', () => {
  test('プロジェクト未選択時は警告だけ表示する', () => {
    const container = buildContainer();
    renderProtocolView(container, { state: INITIAL_STATE, navigate: jest.fn() });
    expect(container.querySelector('.protocol__warning')?.textContent).toBe(
      '先にプロジェクトを選択してください。'
    );
    expect(container.querySelector('form')).toBeNull();
  });

  test('プロジェクトがあればフォームを描画する', () => {
    const container = buildContainer();
    renderProtocolView(container, {
      state: {
        ...INITIAL_STATE,
        project: { projectId: 'p', spreadsheetId: 's', driveFolderId: 'd', title: 'T' },
      },
      navigate: jest.fn(),
    });
    expect(container.querySelector('form')).not.toBeNull();
    // 入力形式 3 種のラジオ
    expect(container.querySelectorAll('input[type=radio]')).toHaveLength(3);
    // textarea が 4 つ（RQ / inclusion / exclusion / inline）
    expect(container.querySelectorAll('textarea')).toHaveLength(4);
    // ファイル入力
    expect(container.querySelector('input[type=file]')?.getAttribute('accept')).toBe(
      '.md,.markdown,.docx'
    );
  });

  test('manual ラジオが既定で checked', () => {
    const container = buildContainer();
    renderProtocolView(container, {
      state: {
        ...INITIAL_STATE,
        project: { projectId: 'p', spreadsheetId: 's', driveFolderId: 'd', title: 'T' },
      },
      navigate: jest.fn(),
    });
    const manual = container.querySelector<HTMLInputElement>('input[value=manual]');
    expect(manual?.checked).toBe(true);
  });

  test('submit イベントは preventDefault され、ページ遷移しない', () => {
    const container = buildContainer();
    renderProtocolView(container, {
      state: {
        ...INITIAL_STATE,
        project: { projectId: 'p', spreadsheetId: 's', driveFolderId: 'd', title: 'T' },
      },
      navigate: jest.fn(),
    });
    const form = container.querySelector('form')!;
    const ev = new Event('submit', { cancelable: true });
    form.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  test('再レンダで重複しない', () => {
    const container = buildContainer();
    const ctx = { state: INITIAL_STATE, navigate: jest.fn() };
    renderProtocolView(container, ctx);
    renderProtocolView(container, ctx);
    expect(container.querySelectorAll('h2')).toHaveLength(1);
  });
});
