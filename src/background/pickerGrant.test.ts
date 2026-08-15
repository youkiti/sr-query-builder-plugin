import {
  isUserCancelledAuthError,
  requestSpreadsheetAccess,
  type PickerGrantDeps,
} from './pickerGrant';

const REDIRECT_URI = 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/picker';

function makeDeps(overrides: Partial<PickerGrantDeps> = {}): PickerGrantDeps & {
  launchWebAuthFlow: jest.Mock;
  openProject: jest.Mock;
  onOpened: jest.Mock;
} {
  const deps = {
    getRedirectUri: () => REDIRECT_URI,
    launchWebAuthFlow: jest.fn().mockResolvedValue(`${REDIRECT_URI}#picked=sheet-1`),
    getUserEmail: jest.fn().mockResolvedValue('me@example.com'),
    openProject: jest.fn().mockResolvedValue(undefined),
    onOpened: jest.fn(),
    ...overrides,
  };
  return deps as PickerGrantDeps & {
    launchWebAuthFlow: jest.Mock;
    openProject: jest.Mock;
    onOpened: jest.Mock;
  };
}

describe('isUserCancelledAuthError', () => {
  test('ウィンドウを閉じた系のメッセージを拾う', () => {
    expect(isUserCancelledAuthError('The user closed the window.')).toBe(true);
    expect(isUserCancelledAuthError('User did not approve access.')).toBe(true);
    expect(isUserCancelledAuthError('Authorization page could not be dismissed')).toBe(true);
  });

  test('通信エラー等はキャンセル扱いしない', () => {
    expect(isUserCancelledAuthError('Network error')).toBe(false);
    expect(isUserCancelledAuthError('')).toBe(false);
  });
});

describe('requestSpreadsheetAccess', () => {
  test('選択に成功したらプロジェクトを開いて granted を返す', async () => {
    const deps = makeDeps();
    await expect(requestSpreadsheetAccess('sheet-1', deps)).resolves.toEqual({ status: 'granted' });

    const url = deps.launchWebAuthFlow.mock.calls[0]?.[0] as string;
    const params = new URLSearchParams(url.split('#')[1]);
    expect(params.get('fileId')).toBe('sheet-1');
    expect(params.get('email')).toBe('me@example.com');
    expect(params.get('redirect')).toBe(REDIRECT_URI);
    expect(deps.openProject).toHaveBeenCalledWith('sheet-1');
    expect(deps.onOpened).toHaveBeenCalledTimes(1);
  });

  test('メールが取れなくても Picker は開く（照合が省かれるだけ）', async () => {
    const deps = makeDeps({ getUserEmail: jest.fn().mockRejectedValue(new Error('no profile')) });
    await expect(requestSpreadsheetAccess('sheet-1', deps)).resolves.toEqual({ status: 'granted' });
    const url = deps.launchWebAuthFlow.mock.calls[0]?.[0] as string;
    expect(new URLSearchParams(url.split('#')[1]).has('email')).toBe(false);
  });

  test('ユーザーがウィンドウを閉じたら cancelled', async () => {
    const deps = makeDeps({
      launchWebAuthFlow: jest.fn().mockRejectedValue(new Error('The user closed the window.')),
    });
    await expect(requestSpreadsheetAccess('sheet-1', deps)).resolves.toEqual({
      status: 'cancelled',
    });
    expect(deps.openProject).not.toHaveBeenCalled();
  });

  test('Picker 側でキャンセルされたら cancelled', async () => {
    const deps = makeDeps({
      launchWebAuthFlow: jest.fn().mockResolvedValue(`${REDIRECT_URI}#cancelled=1`),
    });
    await expect(requestSpreadsheetAccess('sheet-1', deps)).resolves.toEqual({
      status: 'cancelled',
    });
  });

  test('リダイレクト URL が空なら cancelled', async () => {
    const deps = makeDeps({ launchWebAuthFlow: jest.fn().mockResolvedValue(undefined) });
    await expect(requestSpreadsheetAccess('sheet-1', deps)).resolves.toEqual({
      status: 'cancelled',
    });
  });

  test('通信エラーは failed（メッセージをそのまま返す）', async () => {
    const deps = makeDeps({
      launchWebAuthFlow: jest.fn().mockRejectedValue(new Error('Network error')),
    });
    await expect(requestSpreadsheetAccess('sheet-1', deps)).resolves.toEqual({
      status: 'failed',
      message: 'Network error',
    });
  });

  test('自分が発行していないリダイレクト先からの応答は受け付けない', async () => {
    const deps = makeDeps({
      launchWebAuthFlow: jest.fn().mockResolvedValue('https://evil.example.com/#picked=sheet-1'),
    });
    await expect(requestSpreadsheetAccess('sheet-1', deps)).resolves.toMatchObject({
      status: 'failed',
    });
    expect(deps.openProject).not.toHaveBeenCalled();
  });

  test('解釈できない応答は failed', async () => {
    const deps = makeDeps({ launchWebAuthFlow: jest.fn().mockResolvedValue(`${REDIRECT_URI}#`) });
    await expect(requestSpreadsheetAccess('sheet-1', deps)).resolves.toMatchObject({
      status: 'failed',
    });
  });

  test('許可後も開けないときは failed（別のシートを選んだ場合はその旨を示す）', async () => {
    const deps = makeDeps({
      launchWebAuthFlow: jest.fn().mockResolvedValue(`${REDIRECT_URI}#picked=other-sheet`),
      openProject: jest.fn().mockRejectedValue(new Error('Google API failed: HTTP 404')),
    });
    const result = await requestSpreadsheetAccess('sheet-1', deps);
    expect(result.status).toBe('failed');
    expect(result).toMatchObject({ message: expect.stringContaining('一致していません') });
    expect(deps.onOpened).not.toHaveBeenCalled();
  });

  test('同じシートを選んだのに開けないときは元のエラーを返す', async () => {
    const deps = makeDeps({
      openProject: jest.fn().mockRejectedValue(new Error('Meta タブが空です')),
    });
    await expect(requestSpreadsheetAccess('sheet-1', deps)).resolves.toEqual({
      status: 'failed',
      message: 'Meta タブが空です',
    });
  });

  test('進行中に再要求されたら busy（許可ウィンドウを二重に開かない）', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<string>((resolve) => {
      release = () => resolve(`${REDIRECT_URI}#picked=sheet-1`);
    });
    const deps = makeDeps({ launchWebAuthFlow: jest.fn().mockReturnValue(gate) });

    const first = requestSpreadsheetAccess('sheet-1', deps);
    // 1 本目が launchWebAuthFlow で待っている間に 2 本目を投げる
    await Promise.resolve();
    await expect(requestSpreadsheetAccess('sheet-1', deps)).resolves.toEqual({ status: 'busy' });

    release?.();
    await expect(first).resolves.toEqual({ status: 'granted' });
    expect(deps.launchWebAuthFlow).toHaveBeenCalledTimes(1);

    // ガードが解除され、次の要求は通る
    await expect(requestSpreadsheetAccess('sheet-1', deps)).resolves.toEqual({ status: 'granted' });
  });
});
