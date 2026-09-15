import { withSignalDeadline } from './signalDeadline';

test('signal がなければプロバイダの Promise をそのまま返し、識別情報と引数を保つ', async () => {
  const response = { text: 'ok', tokensIn: 1, tokensOut: 1, raw: {} };
  const work = Promise.resolve(response);
  const chat = jest.fn(() => work);
  const provider = withSignalDeadline({ providerId: 'gemini', model: 'test', chat });
  const options = { temperature: 0.2 };

  expect(provider.providerId).toBe('gemini');
  expect(provider.model).toBe('test');
  expect(provider.chat([], options)).toBe(work);
  expect(chat).toHaveBeenCalledWith([], options);
  await expect(work).resolves.toBe(response);
});
