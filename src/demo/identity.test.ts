import { getAccessToken, getCurrentUserEmail, createChromeAuthDeps, createChromeProfileDeps } from '@/lib/google';
import { installDemoIdentity } from './identity';

/**
 * `src/lib/google` の本番ラッパ経由で、chrome.identity モックが正しく応答するかを確認する。
 * 実在のメールアドレスを返さないこと（`demo@example.com` 固定）も確認する。
 */
describe('installDemoIdentity', () => {
  beforeEach(() => {
    installDemoIdentity();
  });

  it('getAuthToken は OAuth 同意画面を出さず固定トークンを返す', async () => {
    const token = await getAccessToken(createChromeAuthDeps(), true);
    expect(token).toBe('demo-oauth-token');
  });

  it('getProfileUserInfo は demo@example.com を返す（実在のメールを出さない）', async () => {
    const email = await getCurrentUserEmail(createChromeProfileDeps());
    expect(email).toBe('demo@example.com');
  });
});
