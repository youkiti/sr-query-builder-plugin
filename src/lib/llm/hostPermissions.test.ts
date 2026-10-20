import { ensureLlmHostPermission, requestLlmHosts, providerOrigins, chromeLlmHostPermissions } from './hostPermissions';

test('任意の送信先だけを重複なく要求する', async () => {
  const permissions = { contains: jest.fn(), request: jest.fn().mockResolvedValue(true) };
  await expect(requestLlmHosts(['gemini', 'anthropic', 'anthropic', 'openrouter'], permissions)).resolves.toBe(true);
  expect(permissions.request).toHaveBeenCalledWith({ origins: ['https://api.anthropic.com/*', 'https://openrouter.ai/*'] });
  expect(providerOrigins(['gemini'])).toEqual([]);
});

test('許可を取り消した場合は次の送信を止める', async () => {
  const permissions = { contains: jest.fn().mockResolvedValueOnce(true).mockResolvedValue(false), request: jest.fn() };
  await expect(ensureLlmHostPermission('anthropic', permissions)).resolves.toBeUndefined();
  await expect(ensureLlmHostPermission('anthropic', permissions)).rejects.toThrow('設定画面で Anthropic への送信を許可してください');
  expect(permissions.request).not.toHaveBeenCalled();
});

test('Chrome の許可 API が無い環境でも動く', async () => {
  const original = chrome.permissions;
  Object.defineProperty(chrome, 'permissions', { value: undefined, configurable: true, writable: true });
  try {
    await expect(ensureLlmHostPermission('openrouter', chromeLlmHostPermissions())).resolves.toBeUndefined();
    await expect(requestLlmHosts(['openrouter'])).resolves.toBe(true);
  } finally {
    chrome.permissions = original;
  }
});
