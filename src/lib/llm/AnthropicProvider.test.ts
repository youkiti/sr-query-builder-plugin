import { AnthropicProvider, type AnthropicEffort } from './AnthropicProvider';
import { LlmProviderError } from './LLMProvider';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300, status,
    json: async () => body, text: async () => JSON.stringify(body),
  } as Response;
}

test('Messages API のヘッダ・ロール・system・既定値を送り、text と使用量を読む', async () => {
  const raw = {
    content: [{ type: 'thinking', thinking: '内部' }, { type: 'text', text: 'a' },
      { type: 'text', text: 'b' }], stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 20,
      cache_creation_input_tokens: 30, cache_read_input_tokens: 40 },
  };
  const fetch = jest.fn().mockResolvedValue(jsonResponse(raw));
  const provider = new AnthropicProvider({ apiKey: 'test-key', model: 'claude-opus-5-5', fetch });
  const signal = new AbortController().signal;
  const result = await provider.chat([
    { role: 'system', content: 's1' }, { role: 'user', content: 'q' },
    { role: 'system', content: 's2' }, { role: 'model', content: 'a' },
  ], { temperature: 0.3, signal, responseFormat: 'json' });
  expect(provider.providerId).toBe('anthropic');
  expect(fetch).toHaveBeenCalledWith('https://api.anthropic.com/v1/messages', {
    method: 'POST', signal,
    headers: { 'x-api-key': 'test-key', 'anthropic-version': '2023-06-01',
      'content-type': 'application/json', 'anthropic-dangerous-direct-browser-access': 'true' },
    body: expect.any(String),
  });
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
    model: 'claude-opus-5-5', max_tokens: 16000, thinking: { type: 'adaptive' },
    system: 's1\n\ns2', messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }],
  });
  expect(result).toEqual({ text: 'ab', tokensIn: 80, tokensOut: 20, raw });
  expect(result.raw).toBe(raw);
});

test.each<AnthropicEffort | undefined>([undefined, 'low', 'medium', 'high', 'xhigh', 'max'])(
  'スキーマと effort=%s を同じ output_config に入れる', async (effort) => {
    const fetch = jest.fn().mockResolvedValue(jsonResponse({}));
    const provider = new AnthropicProvider({ apiKey: 'test-key', model: 'claude-opus-5-5', fetch, effort });
    const schema = { type: 'object', properties: {}, additionalProperties: false };
    await provider.chat([], { responseSchema: schema, maxOutputTokens: 512 });
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      model: 'claude-opus-5-5', messages: [], max_tokens: 512, thinking: { type: 'adaptive' },
      output_config: { format: { type: 'json_schema', schema }, ...(effort ? { effort } : {}) },
    });
  }
);

test('effort 単独指定、usage・content の省略とキャッシュ使用量の省略', async () => {
  const fetch = jest.fn().mockResolvedValueOnce(jsonResponse({}))
    .mockResolvedValueOnce(jsonResponse({ usage: { input_tokens: 2, output_tokens: 3 } }));
  const provider = new AnthropicProvider({ apiKey: 'test-key', model: 'claude-foo', fetch, effort: 'high' });
  expect(await provider.chat([])).toEqual({ text: '', tokensIn: null, tokensOut: null, raw: {} });
  expect(JSON.parse(fetch.mock.calls[0][1].body).output_config).toEqual({ effort: 'high' });
  expect(await provider.chat([])).toMatchObject({ tokensIn: 2, tokensOut: 3 });
});

test.each([400, 401, 402, 403, 404, 413, 429, 500, 504, 529])('HTTP %i は本文付き LlmProviderError', async (status) => {
  const body = { type: 'error', error: { type: 'api_error', message: 'failed' } };
  const fetch = jest.fn().mockResolvedValue(jsonResponse(body, status));
  const provider = new AnthropicProvider({ apiKey: 'test-key', model: 'claude-foo', fetch });
  await expect(provider.chat([])).rejects.toBeInstanceOf(LlmProviderError);
  await expect(provider.chat([])).rejects.toMatchObject({ providerId: 'anthropic', status,
    responseBody: JSON.stringify(body), message: `Anthropic API failed: HTTP ${status}` });
});

test('エラー本文に含まれる API キーを除去する', async () => {
  const fetch = jest.fn().mockResolvedValue(jsonResponse({ error: { message: 'test-secret' } }, 401));
  const provider = new AnthropicProvider({ apiKey: 'test-secret', model: 'claude-foo', fetch });
  await expect(provider.chat([])).rejects.toMatchObject({
    responseBody: '{"error":{"message":"[REDACTED]"}}',
    message: 'Anthropic API failed: HTTP 401',
  });
});

test('エラー本文の読み取り失敗時は空本文にする', async () => {
  const fetch = jest.fn().mockResolvedValue({ ok: false, status: 500,
    text: async () => { throw new Error('read failed'); } });
  await expect(new AnthropicProvider({ apiKey: 'test-key', model: 'claude-foo', fetch }).chat([]))
    .rejects.toMatchObject({ status: 500, responseBody: '' });
});

test.each(['fetch', 'body'])('中断をそのまま伝える: %s', async (phase) => {
  const controller = new AbortController();
  const error = new DOMException('中断', 'AbortError');
  const abort = () => { controller.abort(error); throw error; };
  const fetch = jest.fn().mockImplementation(async () => phase === 'fetch' ? abort()
    : { ok: false, status: 429, text: async () => abort() });
  await expect(new AnthropicProvider({ apiKey: 'test-key', model: 'claude-foo', fetch })
    .chat([], { signal: controller.signal })).rejects.toBe(error);
});

test('fetch 未注入なら globalThis.fetch を使う', async () => {
  const original = globalThis.fetch;
  const fetch = jest.fn().mockResolvedValue(jsonResponse({ content: [{ type: 'text', text: 'ok' }] }));
  globalThis.fetch = fetch;
  try {
    await expect(new AnthropicProvider({ apiKey: 'test-key', model: 'claude-foo' }).chat([]))
      .resolves.toMatchObject({ text: 'ok' });
    expect(JSON.parse(fetch.mock.calls[0][1].body)).not.toHaveProperty('output_config');
  } finally {
    globalThis.fetch = original;
  }
});
