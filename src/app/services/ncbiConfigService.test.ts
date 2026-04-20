import {
  STORAGE_KEY_NCBI,
  buildEutilsDeps,
  getNcbiApiKey,
} from './ncbiConfigService';
import type { ProjectStoreDeps } from '@/features/project';
import type { GoogleApiDeps } from '@/lib/google';

function memoryStore(initial: Record<string, unknown> = {}): ProjectStoreDeps {
  const data = { ...initial };
  return {
    read: async <T>(key: string) => data[key] as T | undefined,
    write: async (items) => {
      Object.assign(data, items);
    },
  };
}

function stubGoogle(): GoogleApiDeps {
  return {
    fetch: jest.fn() as unknown as typeof fetch,
    getAccessToken: jest.fn().mockResolvedValue('t'),
  };
}

describe('getNcbiApiKey', () => {
  test('chrome.storage の値を返す', async () => {
    await expect(getNcbiApiKey(memoryStore({ [STORAGE_KEY_NCBI]: 'my-key' }))).resolves.toBe(
      'my-key'
    );
  });

  test('未定義なら null', async () => {
    await expect(getNcbiApiKey(memoryStore())).resolves.toBeNull();
  });

  test('空文字列なら null（未設定扱い）', async () => {
    await expect(getNcbiApiKey(memoryStore({ [STORAGE_KEY_NCBI]: '' }))).resolves.toBeNull();
  });
});

describe('buildEutilsDeps', () => {
  test('キーがあれば apiKey を含む EutilsDeps を返す', async () => {
    const google = stubGoogle();
    const deps = await buildEutilsDeps({
      google,
      store: memoryStore({ [STORAGE_KEY_NCBI]: 'XYZ' }),
    });
    expect(deps.apiKey).toBe('XYZ');
    expect(deps.fetch).toBe(google.fetch);
  });

  test('キーが無ければ apiKey は未設定（3 req/s 枠で動作）', async () => {
    const google = stubGoogle();
    const deps = await buildEutilsDeps({ google, store: memoryStore() });
    expect(deps.apiKey).toBeUndefined();
    expect(deps.fetch).toBe(google.fetch);
  });
});
