import { LlmProviderError } from './LLMProvider';

describe('LlmProviderError', () => {
  test('providerId / status / responseBody を保持し name を上書きする', () => {
    const err = new LlmProviderError('boom', 'gemini', 503, 'overloaded');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('LlmProviderError');
    expect(err.providerId).toBe('gemini');
    expect(err.status).toBe(503);
    expect(err.responseBody).toBe('overloaded');
    expect(err.message).toBe('boom');
  });

  test('status が null の場合も保持できる', () => {
    const err = new LlmProviderError('network', 'gemini', null, '');
    expect(err.status).toBeNull();
  });
});
