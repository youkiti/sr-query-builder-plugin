import { GeminiProvider } from './GeminiProvider';
import { LlmProviderError } from './LLMProvider';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function errorResponse(status: number, body = 'err'): Response {
  return {
    ok: false,
    status,
    json: async () => ({}),
    text: async () => body,
  } as Response;
}

describe('GeminiProvider.chat', () => {
  test('user メッセージを contents に渡し、テキストを返す', async () => {
    const fetch = jest.fn().mockResolvedValue(
      jsonResponse({
        candidates: [
          {
            content: { parts: [{ text: 'Hello!' }], role: 'model' },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 },
      })
    );
    const provider = new GeminiProvider({ apiKey: 'k', fetch });
    const result = await provider.chat([{ role: 'user', content: 'hi' }]);
    expect(result).toEqual({
      text: 'Hello!',
      tokensIn: 10,
      tokensOut: 20,
      raw: expect.any(Object),
    });
    expect(provider.providerId).toBe('gemini');
    expect(provider.model).toBe('gemini-3.5-flash');
    const [url, init] = fetch.mock.calls[0];
    expect(url).toContain('/models/gemini-3.5-flash:generateContent');
    expect(url).toContain('key=k');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'hi' }] }]);
    expect(body.systemInstruction).toBeUndefined();
    expect(body.generationConfig).toBeUndefined();
  });

  test('system メッセージは systemInstruction に分離される', async () => {
    const fetch = jest.fn().mockResolvedValue(
      jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] })
    );
    const provider = new GeminiProvider({ apiKey: 'k', fetch });
    await provider.chat([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'q' },
    ]);
    const body = JSON.parse((fetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'You are helpful.' }] });
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'q' }] }]);
  });

  test('model ロールはそのまま contents に入る', async () => {
    const fetch = jest.fn().mockResolvedValue(
      jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] })
    );
    const provider = new GeminiProvider({ apiKey: 'k', fetch });
    await provider.chat([
      { role: 'user', content: 'q1' },
      { role: 'model', content: 'a1' },
      { role: 'user', content: 'q2' },
    ]);
    const body = JSON.parse((fetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body.contents.map((c: { role: string }) => c.role)).toEqual(['user', 'model', 'user']);
  });

  test('temperature / maxOutputTokens / responseFormat=json を generationConfig に反映する', async () => {
    const fetch = jest.fn().mockResolvedValue(
      jsonResponse({ candidates: [{ content: { parts: [{ text: '{}' }] } }] })
    );
    const provider = new GeminiProvider({ apiKey: 'k', fetch });
    await provider.chat([{ role: 'user', content: 'q' }], {
      temperature: 0.2,
      maxOutputTokens: 256,
      responseFormat: 'json',
    });
    const body = JSON.parse((fetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body.generationConfig).toEqual({
      temperature: 0.2,
      maxOutputTokens: 256,
      responseMimeType: 'application/json',
    });
  });

  test('responseFormat=text なら responseMimeType を付けない', async () => {
    const fetch = jest.fn().mockResolvedValue(
      jsonResponse({ candidates: [{ content: { parts: [{ text: '' }] } }] })
    );
    const provider = new GeminiProvider({ apiKey: 'k', fetch });
    await provider.chat([{ role: 'user', content: 'q' }], { responseFormat: 'text' });
    const body = JSON.parse((fetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body.generationConfig).toBeUndefined();
  });

  test('複数 parts は連結してテキスト化、空 parts は除外', async () => {
    const fetch = jest.fn().mockResolvedValue(
      jsonResponse({
        candidates: [
          { content: { parts: [{ text: 'foo' }, { text: '' }, { text: 'bar' }] } },
        ],
      })
    );
    const provider = new GeminiProvider({ apiKey: 'k', fetch });
    const r = await provider.chat([{ role: 'user', content: 'q' }]);
    expect(r.text).toBe('foobar');
  });

  test('candidates が無い場合は空文字', async () => {
    const fetch = jest.fn().mockResolvedValue(jsonResponse({}));
    const provider = new GeminiProvider({ apiKey: 'k', fetch });
    const r = await provider.chat([{ role: 'user', content: 'q' }]);
    expect(r.text).toBe('');
    expect(r.tokensIn).toBeNull();
    expect(r.tokensOut).toBeNull();
  });

  test('parts に text が無いキーがあっても落ちない', async () => {
    const fetch = jest.fn().mockResolvedValue(
      jsonResponse({ candidates: [{ content: { parts: [{}] } }] })
    );
    const provider = new GeminiProvider({ apiKey: 'k', fetch });
    const r = await provider.chat([{ role: 'user', content: 'q' }]);
    expect(r.text).toBe('');
  });

  test('model オプションを反映する', async () => {
    const fetch = jest.fn().mockResolvedValue(
      jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] })
    );
    const provider = new GeminiProvider({ apiKey: 'k', model: 'gemini-2.5-flash', fetch });
    await provider.chat([{ role: 'user', content: 'q' }]);
    const url = fetch.mock.calls[0][0] as string;
    expect(url).toContain('/models/gemini-2.5-flash:');
  });

  test('HTTP エラーは LlmProviderError', async () => {
    const fetch = jest.fn().mockResolvedValue(errorResponse(429, 'rate limit'));
    const provider = new GeminiProvider({ apiKey: 'k', fetch });
    try {
      await provider.chat([{ role: 'user', content: 'q' }]);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(LlmProviderError);
      const e = err as LlmProviderError;
      expect(e.status).toBe(429);
      expect(e.responseBody).toBe('rate limit');
      expect(e.providerId).toBe('gemini');
    }
  });

  test('text() が失敗しても空文字で吸収して LlmProviderError を投げる', async () => {
    const failingRes = {
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async (): Promise<string> => {
        throw new Error('net');
      },
    } as Response;
    const fetch = jest.fn().mockResolvedValue(failingRes);
    const provider = new GeminiProvider({ apiKey: 'k', fetch });
    await expect(
      provider.chat([{ role: 'user', content: 'q' }])
    ).rejects.toMatchObject({ status: 500, responseBody: '' });
  });

  test('既定の fetch を使ったコンストラクタ（注入なし）', () => {
    // fetch が globalThis に無い jsdom 環境では作るだけは成功する
    const provider = new GeminiProvider({ apiKey: 'k' });
    expect(provider.providerId).toBe('gemini');
  });

  test('fetch 未注入なら globalThis.fetch にフォールバックする', async () => {
    const stub = jest.fn().mockResolvedValue(
      jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] })
    );
    const original = (globalThis as { fetch?: typeof fetch }).fetch;
    (globalThis as { fetch?: typeof fetch }).fetch = stub as unknown as typeof fetch;
    try {
      const provider = new GeminiProvider({ apiKey: 'k' });
      const r = await provider.chat([{ role: 'user', content: 'q' }]);
      expect(r.text).toBe('ok');
      expect(stub).toHaveBeenCalled();
    } finally {
      if (original === undefined) {
        delete (globalThis as { fetch?: typeof fetch }).fetch;
      } else {
        (globalThis as { fetch?: typeof fetch }).fetch = original;
      }
    }
  });
});
