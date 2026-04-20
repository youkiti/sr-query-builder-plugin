import { INITIAL_STATE } from '../store';
import { renderHomeView } from './homeView';

function buildContainer(): HTMLElement {
  const doc = document.implementation.createHTMLDocument('test');
  const div = doc.createElement('div');
  doc.body.appendChild(div);
  return div;
}

describe('renderHomeView', () => {
  test('プロジェクト未選択メッセージを表示し、ステップボタンは出さない', () => {
    const container = buildContainer();
    const navigate = jest.fn();
    renderHomeView(container, { state: INITIAL_STATE, navigate });
    expect(container.querySelector('h2')?.textContent).toBe('ホーム');
    expect(container.textContent).toContain('プロジェクトが選択されていません');
    expect(container.querySelectorAll('button')).toHaveLength(0);
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

  test('再レンダしても要素が二重にならない', () => {
    const container = buildContainer();
    const navigate = jest.fn();
    renderHomeView(container, { state: INITIAL_STATE, navigate });
    renderHomeView(container, { state: INITIAL_STATE, navigate });
    expect(container.querySelectorAll('h2')).toHaveLength(1);
  });

  test('Protocol / Formula 未確定時はステータス一覧を出さない', () => {
    const container = buildContainer();
    renderHomeView(container, { state: INITIAL_STATE, navigate: jest.fn() });
    expect(container.querySelector('dl.home__status')).toBeNull();
  });

  test('Protocol / Formula 決定済みなら採番済みの値だけ出す', () => {
    const container = buildContainer();
    renderHomeView(container, {
      state: {
        ...INITIAL_STATE,
        currentProtocolVersion: 3,
        currentFormulaVersionId: 'deadbeef-cafe-1234-5678-000000000000',
      },
      navigate: jest.fn(),
    });
    const dl = container.querySelector<HTMLElement>('dl.home__status');
    expect(dl).toBeTruthy();
    const text = dl!.textContent ?? '';
    expect(text).toContain('v3');
    expect(text).toContain('deadbeef');
    expect(text).not.toContain('0000000000');
  });

  test('Protocol version だけでも既知の値だけ出す', () => {
    const container = buildContainer();
    renderHomeView(container, {
      state: {
        ...INITIAL_STATE,
        currentProtocolVersion: 2,
      },
      navigate: jest.fn(),
    });
    const text = container.querySelector<HTMLElement>('dl.home__status')?.textContent ?? '';
    expect(text).toContain('Protocol version');
    expect(text).toContain('v2');
    expect(text).not.toContain('Formula version');
  });
});
