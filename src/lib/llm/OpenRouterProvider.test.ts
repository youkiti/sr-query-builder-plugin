import { OpenRouterProvider } from './OpenRouterProvider';
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

function chatCompletion(content: string | null, usage?: { prompt_tokens?: number; completion_tokens?: number }) {
  return {
    choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage,
  };
}

describe('OpenRouterProvider.chat', () => {
  test('正しい URL / Authorization / ロール変換 / body を送る', async () => {
    const fetch = jest
      .fn()
      .mockResolvedValue(jsonResponse(chatCompletion('Hello!', { prompt_tokens: 10, completion_tokens: 20 })));
    const provider = new OpenRouterProvider({ apiKey: 'k', model: 'qwen/qwen3-235b-a22b-2507', fetch });
    const result = await provider.chat([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'q1' },
      { role: 'model', content: 'a1' },
      { role: 'user', content: 'q2' },
    ]);

    expect(result).toEqual({
      text: 'Hello!',
      tokensIn: 10,
      tokensOut: 20,
      raw: expect.any(Object),
    });
    expect(provider.providerId).toBe('openrouter');
    expect(provider.model).toBe('qwen/qwen3-235b-a22b-2507');

    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer k');
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['HTTP-Referer']).toBe('https://github.com/youkiti/sr-query-builder-plugin');
    expect(headers['X-Title']).toBe('sr-query-builder-plugin');

    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe('qwen/qwen3-235b-a22b-2507');
    expect(body.messages).toEqual([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
    ]);
  });

  test('temperature / maxOutputTokens を body に反映する', async () => {
    const fetch = jest.fn().mockResolvedValue(jsonResponse(chatCompletion('ok')));
    const provider = new OpenRouterProvider({ apiKey: 'k', model: 'm/x', fetch });
    await provider.chat([{ role: 'user', content: 'q' }], {
      temperature: 0.2,
      maxOutputTokens: 256,
    });
    const body = JSON.parse((fetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body.temperature).toBe(0.2);
    expect(body.max_tokens).toBe(256);
  });

  test('オプション未指定なら temperature / max_tokens / response_format を付けない', async () => {
    const fetch = jest.fn().mockResolvedValue(jsonResponse(chatCompletion('ok')));
    const provider = new OpenRouterProvider({ apiKey: 'k', model: 'm/x', fetch });
    await provider.chat([{ role: 'user', content: 'q' }]);
    const body = JSON.parse((fetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body.temperature).toBeUndefined();
    expect(body.max_tokens).toBeUndefined();
    expect(body.response_format).toBeUndefined();
  });

  test('responseFormat=json なら response_format を json_object にする', async () => {
    const fetch = jest.fn().mockResolvedValue(jsonResponse(chatCompletion('{}')));
    const provider = new OpenRouterProvider({ apiKey: 'k', model: 'm/x', fetch });
    await provider.chat([{ role: 'user', content: 'q' }], { responseFormat: 'json' });
    const body = JSON.parse((fetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  test('responseSchema を渡すと strict な json_schema 構造化出力にする', async () => {
    const fetch = jest.fn().mockResolvedValue(jsonResponse(chatCompletion('{}')));
    const provider = new OpenRouterProvider({ apiKey: 'k', model: 'm/x', fetch });
    const schema = {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    };
    await provider.chat([{ role: 'user', content: 'q' }], {
      responseFormat: 'json',
      responseSchema: schema,
    });
    const body = JSON.parse((fetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'response', strict: true, schema },
    });
  });

  test('HTTP 400 は LlmProviderError（status 400）', async () => {
    const fetch = jest.fn().mockResolvedValue(errorResponse(400, 'bad request'));
    const provider = new OpenRouterProvider({ apiKey: 'k', model: 'm/x', fetch });
    try {
      await provider.chat([{ role: 'user', content: 'q' }]);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(LlmProviderError);
      const e = err as LlmProviderError;
      expect(e.status).toBe(400);
      expect(e.responseBody).toBe('bad request');
      expect(e.providerId).toBe('openrouter');
    }
  });

  test('usage.prompt_tokens / completion_tokens からトークン数を読む', async () => {
    const fetch = jest
      .fn()
      .mockResolvedValue(jsonResponse(chatCompletion('hi', { prompt_tokens: 5, completion_tokens: 7 })));
    const provider = new OpenRouterProvider({ apiKey: 'k', model: 'm/x', fetch });
    const r = await provider.chat([{ role: 'user', content: 'q' }]);
    expect(r.tokensIn).toBe(5);
    expect(r.tokensOut).toBe(7);
  });

  test('usage が無ければトークン数は null', async () => {
    const fetch = jest.fn().mockResolvedValue(jsonResponse(chatCompletion('hi')));
    const provider = new OpenRouterProvider({ apiKey: 'k', model: 'm/x', fetch });
    const r = await provider.chat([{ role: 'user', content: 'q' }]);
    expect(r.tokensIn).toBeNull();
    expect(r.tokensOut).toBeNull();
  });

  test('content が null なら空文字を返す', async () => {
    const fetch = jest.fn().mockResolvedValue(jsonResponse(chatCompletion(null)));
    const provider = new OpenRouterProvider({ apiKey: 'k', model: 'm/x', fetch });
    const r = await provider.chat([{ role: 'user', content: 'q' }]);
    expect(r.text).toBe('');
  });

  test('fetch 未注入なら globalThis.fetch にフォールバックする', async () => {
    const stub = jest.fn().mockResolvedValue(jsonResponse(chatCompletion('ok')));
    const original = (globalThis as { fetch?: typeof fetch }).fetch;
    (globalThis as { fetch?: typeof fetch }).fetch = stub as unknown as typeof fetch;
    try {
      const provider = new OpenRouterProvider({ apiKey: 'k', model: 'm/x' });
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
