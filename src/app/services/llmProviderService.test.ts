import { SHEET_HEADERS } from '@/domain/sheetsSchema';
import {
  LlmApiKeyMissingError,
  STORAGE_KEY_GEMINI,
  buildLlmProviderFactory,
  getGeminiApiKey,
} from './llmProviderService';
import type { ProjectStoreDeps } from '@/features/project';

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function memoryStore(initial: Record<string, unknown> = {}): {
  store: ProjectStoreDeps;
  data: Record<string, unknown>;
} {
  const data = { ...initial };
  return {
    data,
    store: {
      read: async <T>(key: string) => data[key] as T | undefined,
      write: async (items) => {
        Object.assign(data, items);
      },
    },
  };
}

describe('getGeminiApiKey', () => {
  test('chrome.storage の値を返す', async () => {
    const { store } = memoryStore({ [STORAGE_KEY_GEMINI]: 'k' });
    await expect(getGeminiApiKey(store)).resolves.toBe('k');
  });

  test('未定義 / 空文字なら null', async () => {
    await expect(getGeminiApiKey(memoryStore().store)).resolves.toBeNull();
    await expect(
      getGeminiApiKey(memoryStore({ [STORAGE_KEY_GEMINI]: '' }).store)
    ).resolves.toBeNull();
  });
});

describe('buildLlmProviderFactory', () => {
  test('API キーが無いと LlmApiKeyMissingError', async () => {
    const { store } = memoryStore();
    const google = {
      fetch: jest.fn(),
      getAccessToken: jest.fn().mockResolvedValue('t'),
    };
    await expect(
      buildLlmProviderFactory({
        google: google as Parameters<typeof buildLlmProviderFactory>[0]['google'],
        store,
        llmLogFolderId: 'F',
        spreadsheetId: 'S',
      })
    ).rejects.toBeInstanceOf(LlmApiKeyMissingError);
  });

  test('factory.forPurpose が GeminiProvider を返し、chat 後に Drive と Sheets に書く', async () => {
    const { store } = memoryStore({ [STORAGE_KEY_GEMINI]: 'KEY' });
    const fetchMock = jest
      .fn()
      // GeminiProvider のレスポンス
      .mockResolvedValueOnce(
        jsonResponse({
          candidates: [{ content: { parts: [{ text: 'OK' }] } }],
          usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 5 },
        })
      )
      // Drive: prompt.json
      .mockResolvedValueOnce(jsonResponse({ id: 'd1', webViewLink: 'https://drive/p' }))
      // Drive: response.json
      .mockResolvedValueOnce(jsonResponse({ id: 'd2', webViewLink: 'https://drive/r' }))
      // Sheets: append LLMApiLog
      .mockResolvedValueOnce(jsonResponse({}));
    const google = {
      fetch: fetchMock as unknown as typeof fetch,
      getAccessToken: jest.fn().mockResolvedValue('t'),
    };
    const factory = await buildLlmProviderFactory({
      google,
      store,
      llmLogFolderId: 'LOG-FOLDER',
      spreadsheetId: 'SHEET-1',
      model: 'gemini-2.5-flash',
    });
    const provider = factory.forPurpose('extract_protocol');
    expect(provider.providerId).toBe('gemini');
    expect(provider.model).toBe('gemini-2.5-flash');
    const result = await provider.chat([{ role: 'user', content: 'hi' }]);
    expect(result.text).toBe('OK');

    const calls = fetchMock.mock.calls.map((c) => c[0] as string);
    // 1: Gemini, 2: Drive prompt, 3: Drive response, 4: Sheets append
    expect(calls[0]).toContain('generativelanguage.googleapis.com');
    expect(calls[1]).toContain('/upload/drive/v3/files');
    expect(calls[2]).toContain('/upload/drive/v3/files');
    expect(calls[3]).toContain('SHEET-1/values/LLMApiLog');

    // Drive へのリクエスト本文は parentId=LOG-FOLDER を含む
    const driveBody = (fetchMock.mock.calls[1][1] as RequestInit).body as string;
    expect(driveBody).toContain('"parents":["LOG-FOLDER"]');

    // Sheets へ書き込まれる行が SHEET_HEADERS.LLMApiLog の順
    const sheetBody = JSON.parse(
      (fetchMock.mock.calls[3][1] as RequestInit).body as string
    ) as { values: (string | number | boolean | null)[][] };
    const row = sheetBody.values[0]!;
    expect(row).toHaveLength(SHEET_HEADERS.LLMApiLog.length);
    const map: Record<string, unknown> = {};
    SHEET_HEADERS.LLMApiLog.forEach((k, i) => {
      map[k] = row[i];
    });
    expect(map['provider']).toBe('gemini');
    expect(map['purpose']).toBe('extract_protocol');
    expect(map['tokens_in']).toBe(3);
    expect(map['tokens_out']).toBe(5);
    // null フィールドは appendRow が空文字に変換
    expect(map['cost_estimate_usd']).toBe('');
    expect(map['error']).toBe('');
  });
});
