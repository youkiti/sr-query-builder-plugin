import { LlmProviderError, type ChatResponse, type LLMProvider } from './LLMProvider';
import { withRetry, RETRYABLE_STATUSES } from './retry';

function okResponse(text = 'ok'): ChatResponse {
  return { text, tokensIn: 1, tokensOut: 1, raw: {} };
}

function providerError(status: number | null): LlmProviderError {
  return new LlmProviderError(`Gemini API failed: HTTP ${status}`, 'gemini', status, '');
}

/** chat が呼ばれるたびに results の先頭から消費する fake provider */
function buildProvider(results: Array<ChatResponse | Error>): {
  provider: LLMProvider;
  calls: () => number;
} {
  let count = 0;
  return {
    provider: {
      providerId: 'gemini',
      model: 'gemini-test',
      chat: async () => {
        const next = results[count];
        count += 1;
        if (next === undefined) {
          throw new Error('fake provider: 想定外の追加呼び出し');
        }
        if (next instanceof Error) {
          throw next;
        }
        return next;
      },
    },
    calls: () => count,
  };
}

const noSleep = (): Promise<void> => Promise.resolve();

describe('withRetry', () => {
  test('成功時はそのまま返し、再試行しない', async () => {
    const { provider, calls } = buildProvider([okResponse()]);
    const wrapped = withRetry(provider, { sleep: noSleep });
    const res = await wrapped.chat([{ role: 'user', content: 'hi' }]);
    expect(res.text).toBe('ok');
    expect(calls()).toBe(1);
  });

  test('providerId / model を元プロバイダから引き継ぐ', () => {
    const { provider } = buildProvider([]);
    const wrapped = withRetry(provider);
    expect(wrapped.providerId).toBe('gemini');
    expect(wrapped.model).toBe('gemini-test');
  });

  test.each([...RETRYABLE_STATUSES])('HTTP %i は再試行して成功すれば返す', async (status) => {
    const { provider, calls } = buildProvider([providerError(status), okResponse('retried')]);
    const wrapped = withRetry(provider, { sleep: noSleep });
    const res = await wrapped.chat([{ role: 'user', content: 'hi' }]);
    expect(res.text).toBe('retried');
    expect(calls()).toBe(2);
  });

  test('maxAttempts 回失敗したら最後のエラーを投げる', async () => {
    const { provider, calls } = buildProvider([
      providerError(503),
      providerError(503),
      providerError(503),
    ]);
    const wrapped = withRetry(provider, { sleep: noSleep });
    await expect(wrapped.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow('HTTP 503');
    expect(calls()).toBe(3);
  });

  test('再試行対象外のステータス（400 等）は即座に投げる', async () => {
    const { provider, calls } = buildProvider([providerError(400)]);
    const wrapped = withRetry(provider, { sleep: noSleep });
    await expect(wrapped.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow('HTTP 400');
    expect(calls()).toBe(1);
  });

  test('status が null（ネットワーク異常など provider 層の整形済みエラー）は再試行しない', async () => {
    const { provider, calls } = buildProvider([providerError(null)]);
    const wrapped = withRetry(provider, { sleep: noSleep });
    await expect(wrapped.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow();
    expect(calls()).toBe(1);
  });

  test('LlmProviderError 以外の例外は再試行しない', async () => {
    const { provider, calls } = buildProvider([new TypeError('fetch failed')]);
    const wrapped = withRetry(provider, { sleep: noSleep });
    await expect(wrapped.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow('fetch failed');
    expect(calls()).toBe(1);
  });

  test('バックオフは指数的に伸びる（1 回目 base、2 回目 base*2）', async () => {
    const delays: number[] = [];
    const { provider } = buildProvider([
      providerError(503),
      providerError(503),
      okResponse(),
    ]);
    const wrapped = withRetry(provider, {
      baseDelayMs: 100,
      sleep: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
    });
    await wrapped.chat([{ role: 'user', content: 'hi' }]);
    expect(delays).toEqual([100, 200]);
  });

  test('isRetryable を差し替えられる', async () => {
    const { provider, calls } = buildProvider([new Error('custom'), okResponse()]);
    const wrapped = withRetry(provider, { sleep: noSleep, isRetryable: () => true });
    const res = await wrapped.chat([{ role: 'user', content: 'hi' }]);
    expect(res.text).toBe('ok');
    expect(calls()).toBe(2);
  });
});

test.each(['AbortError', 'TimeoutError'])('%s は再試行せず同じ例外を返す', async (name) => {
  const error = new DOMException('通信中断', name);
  const chat = jest.fn().mockRejectedValue(error);
  const sleep = jest.fn();
  const provider = withRetry({ providerId: 'gemini', model: 'test', chat }, { sleep });
  await expect(provider.chat([])).rejects.toBe(error);
  expect(chat).toHaveBeenCalledTimes(1);
  expect(sleep).not.toHaveBeenCalled();
});

test('送信前 hook の例外は再試行判定へ渡さず、残予算 1 回で次の送信を止める', async () => {
  const error = providerError(429);
  const { provider, calls } = buildProvider([error, okResponse()]);
  const beforeAttempt = jest.fn().mockResolvedValueOnce(undefined).mockRejectedValue(error);
  const isRetryable = jest.fn().mockReturnValue(true);
  const wrapped = withRetry(provider, { beforeAttempt, isRetryable, sleep: noSleep });
  await expect(wrapped.chat([])).rejects.toBe(error);
  expect(calls()).toBe(1);
  expect(beforeAttempt).toHaveBeenCalledTimes(2);
  expect(isRetryable).toHaveBeenCalledTimes(1);
});

test('各試行は hook 完了後に新しい signal を作り、完了後の abort listener を外す', async () => {
  const signals = [new AbortController().signal, new AbortController().signal];
  const removes = signals.map((signal) => jest.spyOn(signal, 'removeEventListener'));
  const beforeAttempt = jest.fn().mockResolvedValue(undefined);
  const createSignal = jest.fn((): AbortSignal => {
    expect(beforeAttempt).toHaveBeenCalledTimes(createSignal.mock.calls.length);
    return signals[createSignal.mock.calls.length - 1]!;
  });
  const chat = jest.fn().mockRejectedValueOnce(providerError(429)).mockResolvedValue(okResponse());
  const provider = withRetry({ providerId: 'gemini', model: 'test', chat }, { beforeAttempt, createSignal, sleep: noSleep });
  await provider.chat([], { temperature: 0.2 });
  expect(chat.mock.calls.map((call) => call[1])).toEqual(signals.map((signal) => ({ temperature: 0.2, signal })));
  for (const remove of removes) expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
});
