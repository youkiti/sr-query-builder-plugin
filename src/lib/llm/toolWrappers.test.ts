import { LlmProviderError, type LLMProvider, type ToolChatResponse } from './LLMProvider';
import { withLogging, buildPromptSummary } from './apiLogger';
import { withRetry } from './retry';
import { withSignalDeadline } from './signalDeadline';

const response: ToolChatResponse = { content: [{ type: 'text', text: 'ok' }], text: 'ok', toolCalls: [],
  stopReason: 'end_turn', tokensIn: 12, tokensOut: 5, raw: { content: [] } };
function setup() {
  const chatWithTools = jest.fn().mockResolvedValue(response);
  const provider: LLMProvider = { providerId: 'anthropic', model: 'claude-opus-5-5', chat: jest.fn(), chatWithTools };
  const deps = { uploadJson: jest.fn().mockResolvedValue({ webViewLink: 'fake-link' }),
    appendLogEntry: jest.fn().mockResolvedValue(undefined), newUuid: () => 'log', now: () => 'now' };
  return { provider, chatWithTools, deps };
}

test('各ラッパーは元にないメソッドを生やさない', () => {
  const { provider, deps } = setup();
  delete provider.chatWithTools;
  for (const wrapped of [withSignalDeadline(provider), withLogging(provider, 'draft_agent', deps), withRetry(provider)]) {
    expect(wrapped).not.toHaveProperty('chatWithTools');
  }
});

test('重ねたラッパーでも試行ごとの signal・通知・要求と応答のログを保つ', async () => {
  const { provider, chatWithTools, deps } = setup();
  chatWithTools.mockRejectedValueOnce(new LlmProviderError('busy', 'anthropic', 529, ''));
  const beforeAttempt = jest.fn();
  const onRequestState = jest.fn();
  const sleep = jest.fn().mockResolvedValue(undefined);
  const signals = [new AbortController().signal, new AbortController().signal];
  const createSignal = jest.fn().mockReturnValueOnce(signals[0]).mockReturnValueOnce(signals[1]);
  const wrapped = withRetry(withLogging(withSignalDeadline(provider), 'draft_agent', deps),
    { beforeAttempt, onRequestState, sleep, createSignal });
  const messages = [{ role: 'user' as const, content: [{ type: 'tool_result', tool_use_id: 'id', content: '結果\n' + 'a'.repeat(600) }] }];
  expect(await wrapped.chatWithTools!('system', messages, [], { maxOutputTokens: 100 })).toBe(response);
  expect(beforeAttempt).toHaveBeenCalledTimes(2);
  expect(createSignal).toHaveBeenCalledTimes(2);
  expect(chatWithTools.mock.calls.map((args) => args[3].signal)).toEqual(signals);
  expect(chatWithTools.mock.calls[1]![3].maxOutputTokens).toBe(100);
  expect(onRequestState.mock.calls.flat()).toEqual(['retry', 'idle']);
  expect(sleep).toHaveBeenCalledWith(1000);
  expect(deps.appendLogEntry).toHaveBeenCalledTimes(2);
  expect(deps.uploadJson).toHaveBeenCalledTimes(4);
  expect(JSON.parse(deps.uploadJson.mock.calls[0]![0].content)).toMatchObject({ system: 'system', messages, tools: [] });
  expect(JSON.parse(deps.uploadJson.mock.calls[3]![0].content)).toEqual(response.raw);
  expect(deps.appendLogEntry.mock.calls[1]![0]).toMatchObject({ purpose: 'draft_agent', tokensIn: 12, tokensOut: 5,
    promptSummary: buildPromptSummary([{ role: 'user', content: '結果\n' + 'a'.repeat(600) }]) });
  expect(deps.appendLogEntry.mock.calls[1]![0].promptSummary).toHaveLength(500);
});

test('最後のユーザー文字列をログの要約にする', async () => {
  const { provider, deps } = setup();
  await withLogging(provider, 'draft_agent', deps).chatWithTools!('system', [
    { role: 'user', content: 'first' }, { role: 'assistant', content: [] }, { role: 'user', content: 'last\nquestion' },
  ], []);
  expect(deps.appendLogEntry.mock.calls[0]![0].promptSummary).toBe('[user] last question');
});

test('期限で中断し、失敗ログと通知を一度残して例外を戻す', async () => {
  const { provider, chatWithTools, deps } = setup();
  chatWithTools.mockImplementation(() => new Promise(() => undefined));
  const controller = new AbortController();
  const onRequestState = jest.fn();
  const wrapped = withRetry(withLogging(withSignalDeadline(provider), 'draft_agent', deps), { onRequestState });
  const pending = wrapped.chatWithTools!('', [], [], { signal: controller.signal });
  const error = new DOMException('中断', 'AbortError');
  controller.abort(error);
  await expect(pending).rejects.toBe(error);
  expect(deps.appendLogEntry).toHaveBeenCalledTimes(1);
  expect(deps.uploadJson).toHaveBeenCalledTimes(2);
  expect(chatWithTools).toHaveBeenCalledTimes(1);
  expect(onRequestState).toHaveBeenCalledWith('failure');
});

test('beforeAttempt の失敗と既に中断した signal では送信しない', async () => {
  const { provider, chatWithTools } = setup();
  const error = new Error('予算上限');
  await expect(withRetry(provider, { beforeAttempt: () => { throw error; } }).chatWithTools!('', [], [])).rejects.toBe(error);
  const controller = new AbortController();
  controller.abort(error);
  await expect(withRetry(provider).chatWithTools!('', [], [], { signal: controller.signal })).rejects.toBe(error);
  expect(chatWithTools).not.toHaveBeenCalled();
});
