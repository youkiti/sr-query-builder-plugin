import type { LlmProviderId } from '@/domain/llmApiLog';

const origins = {
  openrouter: 'https://openrouter.ai/*',
  anthropic: 'https://api.anthropic.com/*',
};
export interface LlmHostPermissions {
  contains: (permissions: { origins: string[] }) => Promise<boolean>;
  request: (permissions: { origins: string[] }) => Promise<boolean>;
}
export function chromeLlmHostPermissions(): LlmHostPermissions {
  return {
    contains: (permissions) => typeof chrome !== 'undefined' && chrome.permissions
      ? chrome.permissions.contains(permissions) : Promise.resolve(true),
    request: (permissions) => typeof chrome !== 'undefined' && chrome.permissions
      ? chrome.permissions.request(permissions) : Promise.resolve(true),
  };
}
export function providerOrigins(providers: LlmProviderId[]): string[] {
  return [...new Set(providers.flatMap((provider) => provider in origins
    ? [origins[provider as keyof typeof origins]] : []))];
}
export class LlmHostPermissionMissingError extends Error {
  constructor(provider: LlmProviderId) {
    super(`設定画面で ${provider === 'anthropic' ? 'Anthropic' : 'OpenRouter'} への送信を許可してください`);
    this.name = 'LlmHostPermissionMissingError';
  }
}
export async function ensureLlmHostPermission(provider: LlmProviderId, permissions = chromeLlmHostPermissions()): Promise<void> {
  const required = providerOrigins([provider]);
  if (required.length && !await permissions.contains({ origins: required })) {
    throw new LlmHostPermissionMissingError(provider);
  }
}

/** ユーザー操作の同期処理から呼び、保存処理の await より前に許可を要求する。 */
export function requestLlmHosts(providers: LlmProviderId[], permissions = chromeLlmHostPermissions()): Promise<boolean> {
  const required = providerOrigins(providers);
  return required.length ? permissions.request({ origins: required }).catch(() => false) : Promise.resolve(true);
}
export const HOST_PERMISSION_DENIED = '許可がないため、このプロバイダには送信できません';

export function addLlmPermissionButtons(parent: HTMLElement, permissions = chromeLlmHostPermissions(), buttonClassName = ''): void {
  for (const provider of ['openrouter', 'anthropic'] as const) {
    const button = parent.ownerDocument.createElement('button');
    button.type = 'button';
    button.className = buttonClassName;
    button.textContent = `${provider === 'anthropic' ? 'Anthropic' : 'OpenRouter'} への送信を許可する`;
    const notice = parent.ownerDocument.createElement('p');
    notice.className = 'llm-permission__status';
    notice.setAttribute('role', 'status');
    button.addEventListener('click', () => {
      void requestLlmHosts([provider], permissions).then((allowed) => {
        notice.textContent = allowed ? '許可しました。' : HOST_PERMISSION_DENIED;
      });
    });
    parent.append(button, notice);
  }
}
