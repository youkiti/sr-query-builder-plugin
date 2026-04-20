import type { ChromeStorageDeps } from './chromeStorage';
import { SECRET_KEYS, readSecret, writeSecret } from './secretsStore';

function memoryDeps(initial: Record<string, unknown> = {}): {
  deps: ChromeStorageDeps;
  data: Record<string, unknown>;
} {
  const data = { ...initial };
  return {
    data,
    deps: {
      read: async <T>(key: string) => data[key] as T | undefined,
      write: async (items) => {
        Object.assign(data, items);
      },
    },
  };
}

describe('SECRET_KEYS', () => {
  test('要件 §3.2 で指定されたストレージキー名と一致する', () => {
    expect(SECRET_KEYS).toEqual({
      gemini: 'apiKeys.gemini',
      openai: 'apiKeys.openai',
      anthropic: 'apiKeys.anthropic',
      openrouter: 'apiKeys.openrouter',
      ncbi: 'apiKeys.ncbi',
    });
  });
});

describe('readSecret', () => {
  test('保存された文字列をそのまま返す', async () => {
    const { deps } = memoryDeps({ [SECRET_KEYS.gemini]: 'g' });
    await expect(readSecret(deps, 'gemini')).resolves.toBe('g');
  });

  test('未設定なら null', async () => {
    const { deps } = memoryDeps();
    await expect(readSecret(deps, 'ncbi')).resolves.toBeNull();
  });

  test('空文字列も null として正規化する', async () => {
    const { deps } = memoryDeps({ [SECRET_KEYS.ncbi]: '' });
    await expect(readSecret(deps, 'ncbi')).resolves.toBeNull();
  });
});

describe('writeSecret', () => {
  test('指定キーに 1 ペアだけ書き込む', async () => {
    const { deps, data } = memoryDeps();
    await writeSecret(deps, 'openai', 'KEY');
    expect(data[SECRET_KEYS.openai]).toBe('KEY');
  });

  test('空文字を渡せば空文字で上書き（明示的な未設定）', async () => {
    const { deps, data } = memoryDeps({ [SECRET_KEYS.anthropic]: 'prev' });
    await writeSecret(deps, 'anthropic', '');
    expect(data[SECRET_KEYS.anthropic]).toBe('');
  });
});
