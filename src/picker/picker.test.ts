/**
 * Picker 許可ページ（src/picker/picker.ts）のうち、DOM や実物の Google スクリプトに
 * 依存しない純粋関数だけを対象にした最小限のテスト。
 *
 * jest.config.ts の coveragePathIgnorePatterns は `src/picker/` をカバレッジ集計から
 * 除外している（実物の gsi/client + Picker という外部スクリプトに依存するため jsdom では
 * 意味のある検証ができない、という理由）。このファイルはその方針自体は変えず、
 * 「付与スコープが不足しているときに revoke すべきか」という判定ロジックだけを、
 * webpack DefinePlugin 由来の定数（`__PICKER_WEB_CLIENT_ID__` 等）に依存しない形で
 * `shouldRevokeForMissingScopes` として切り出し、そこだけを検証する。
 */
import { shouldRevokeForMissingScopes } from './picker';

describe('shouldRevokeForMissingScopes', () => {
  const tokenResponse = { access_token: 'token-1', scope: 'irrelevant-for-this-test' };

  test('要求した全スコープが付与されていれば revoke 不要（false）', () => {
    const hasGrantedAllScopes = jest.fn().mockReturnValue(true);
    expect(shouldRevokeForMissingScopes(tokenResponse, hasGrantedAllScopes)).toBe(false);
    // drive.file と userinfo.email の 2 スコープを渡して問い合わせていること
    expect(hasGrantedAllScopes).toHaveBeenCalledWith(
      tokenResponse,
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/userinfo.email'
    );
  });

  test('スコープの一部（drive.file 等）が拒否されていれば revoke すべき（true）', () => {
    const hasGrantedAllScopes = jest.fn().mockReturnValue(false);
    expect(shouldRevokeForMissingScopes(tokenResponse, hasGrantedAllScopes)).toBe(true);
  });
});
