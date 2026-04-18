/**
 * `chrome.identity.getProfileUserInfo` のラッパ。
 * OAuth の `userinfo.email` スコープを使わずにユーザーのメールアドレスを取得する
 * （requirements.md §2.2 で明示的に `identity.email` permission を要求する方針）。
 */

export interface ProfileDeps {
  getProfileUserInfo: () => Promise<{ email: string; id: string }>;
}

export function createChromeProfileDeps(): ProfileDeps {
  return {
    getProfileUserInfo: () =>
      new Promise((resolve) => {
        // @types/chrome では AccountStatus が enum で提供されるためキャストで渡す
        chrome.identity.getProfileUserInfo(
          { accountStatus: 'ANY' as chrome.identity.AccountStatus },
          (info) => {
            resolve({ email: info.email, id: info.id });
          }
        );
      }),
  };
}

/**
 * 現在 Chrome に同期中のアカウントのメールアドレスを返す。取れなければ null。
 */
export async function getCurrentUserEmail(deps: ProfileDeps): Promise<string | null> {
  const info = await deps.getProfileUserInfo();
  return info.email.length > 0 ? info.email : null;
}
