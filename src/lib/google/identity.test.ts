import { createChromeProfileDeps, getCurrentUserEmail } from './identity';

describe('getCurrentUserEmail', () => {
  test('メールがあれば返す', async () => {
    const deps = {
      getProfileUserInfo: jest.fn().mockResolvedValue({ email: 'me@example.com', id: 'abc' }),
    };
    await expect(getCurrentUserEmail(deps)).resolves.toBe('me@example.com');
  });

  test('空文字は null', async () => {
    const deps = {
      getProfileUserInfo: jest.fn().mockResolvedValue({ email: '', id: '' }),
    };
    await expect(getCurrentUserEmail(deps)).resolves.toBeNull();
  });
});

describe('createChromeProfileDeps', () => {
  test('chrome.identity.getProfileUserInfo を呼んで {email, id} を resolve', async () => {
    let capturedOptions: { accountStatus?: string } | undefined;
    (globalThis as unknown as { chrome: typeof chrome }).chrome = {
      identity: {
        getProfileUserInfo: (
          options: { accountStatus?: string },
          cb: (info: { email: string; id: string }) => void
        ) => {
          capturedOptions = options;
          cb({ email: 'abc@d', id: '1' });
        },
      },
    } as unknown as typeof chrome;
    const deps = createChromeProfileDeps();
    await expect(deps.getProfileUserInfo()).resolves.toEqual({ email: 'abc@d', id: '1' });
    expect(capturedOptions).toEqual({ accountStatus: 'ANY' });
  });
});
