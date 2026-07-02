import { INITIAL_STATE } from '../store';
import { createHomeView, renderHomeView } from './homeView';

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
    // 「別のプロジェクトを開く」ボタンは常に描画する（ステップ導線ではない）
    const buttons = container.querySelectorAll<HTMLButtonElement>('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.className).toBe('home__switch-project');
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

  test('「別のプロジェクトを開く」ボタンで onOpenPopup が呼ばれる', () => {
    const container = buildContainer();
    const onOpenPopup = jest.fn();
    const view = createHomeView({ onOpenPopup });
    view(container, { state: INITIAL_STATE, navigate: jest.fn() });
    const btn = container.querySelector<HTMLButtonElement>('.home__switch-project');
    expect(btn).toBeTruthy();
    btn!.click();
    expect(onOpenPopup).toHaveBeenCalledTimes(1);
  });

  test('onOpenPopup が未指定でもクリックで例外にならない', () => {
    const container = buildContainer();
    const view = createHomeView();
    view(container, { state: INITIAL_STATE, navigate: jest.fn() });
    const btn = container.querySelector<HTMLButtonElement>('.home__switch-project')!;
    expect(() => btn.click()).not.toThrow();
  });

  test('hydrateError があればエラーバナー + 再試行ボタンを出す', () => {
    const container = buildContainer();
    const onRetryHydrate = jest.fn();
    const view = createHomeView({ onRetryHydrate });
    view(container, {
      state: { ...INITIAL_STATE, hydrateError: 'HTTP 500' },
      navigate: jest.fn(),
    });
    const banner = container.querySelector('.view__hydrate-error');
    expect(banner).not.toBeNull();
    expect(banner?.getAttribute('role')).toBe('alert');
    expect(banner?.textContent).toContain('読み込みに失敗しました');
    expect(banner?.textContent).toContain('HTTP 500');
    const retry = container.querySelector<HTMLButtonElement>('.view__hydrate-error-retry')!;
    retry.click();
    expect(onRetryHydrate).toHaveBeenCalledTimes(1);
    // 連打防止で押下後は無効化される
    expect(retry.disabled).toBe(true);
  });

  test('hydrateError が null ならバナーは出さない', () => {
    const container = buildContainer();
    renderHomeView(container, { state: INITIAL_STATE, navigate: jest.fn() });
    expect(container.querySelector('.view__hydrate-error')).toBeNull();
  });
});
