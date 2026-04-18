import { INITIAL_STATE } from '../store';
import { renderHomeView } from './homeView';

function buildContainer(): HTMLElement {
  const doc = document.implementation.createHTMLDocument('test');
  const div = doc.createElement('div');
  doc.body.appendChild(div);
  return div;
}

describe('renderHomeView', () => {
  test('プロジェクト未選択メッセージを表示し、5 つのステップボタンを並べる', () => {
    const container = buildContainer();
    const navigate = jest.fn();
    renderHomeView(container, { state: INITIAL_STATE, navigate });
    expect(container.querySelector('h2')?.textContent).toBe('ホーム');
    expect(container.querySelector('p')?.textContent).toContain('プロジェクトが選択されていません');
    const buttons = container.querySelectorAll('button');
    expect(buttons).toHaveLength(5);
  });

  test('プロジェクトがあればタイトルと短縮 ID を出す', () => {
    const container = buildContainer();
    renderHomeView(container, {
      state: {
        ...INITIAL_STATE,
        project: {
          projectId: '12345678-aaaa-bbbb-cccc-000000000000',
          spreadsheetId: 's',
          driveFolderId: 'd',
          title: 'My SR',
        },
      },
      navigate: jest.fn(),
    });
    expect(container.querySelector('p')?.textContent).toContain('My SR');
    expect(container.querySelector('p')?.textContent).toContain('12345678');
  });

  test('ステップボタンのクリックで navigate が呼ばれる', () => {
    const container = buildContainer();
    const navigate = jest.fn();
    renderHomeView(container, { state: INITIAL_STATE, navigate });
    const protocolBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'プロトコル入力'
    );
    expect(protocolBtn).toBeTruthy();
    protocolBtn!.click();
    expect(navigate).toHaveBeenCalledWith('protocol');
  });

  test('再レンダしても要素が二重にならない', () => {
    const container = buildContainer();
    const navigate = jest.fn();
    renderHomeView(container, { state: INITIAL_STATE, navigate });
    renderHomeView(container, { state: INITIAL_STATE, navigate });
    expect(container.querySelectorAll('h2')).toHaveLength(1);
  });
});
