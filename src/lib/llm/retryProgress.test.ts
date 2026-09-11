import { withRetry } from './retry';
import { LlmProviderError, type LLMProvider } from './LLMProvider';

test('通信リトライと最終失敗を通知し、未注入・通知例外でも試行回数と待機を維持する', async () => {
  for (const mode of ['none', 'observe', 'throw']) {
    const failure = new LlmProviderError('一時的な取得失敗', 'gemini', 503, '');
    const chat = jest.fn().mockRejectedValue(failure);
    const provider: LLMProvider = { providerId: 'gemini', model: 'test', chat };
    const sleep = jest.fn(async () => undefined);
    const onRequestState = jest.fn(() => { if (mode === 'throw') throw new Error('表示失敗'); });
    await expect(withRetry(provider, { sleep, onRequestState: mode === 'none' ? undefined : onRequestState }).chat([])).rejects.toBe(failure);
    expect(chat).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toHaveLength(2);
    if (mode !== 'none') expect(onRequestState.mock.calls).toEqual([['retry'], ['idle'], ['retry'], ['idle'], ['failure']]);
  }
});
