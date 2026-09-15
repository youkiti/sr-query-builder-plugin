import { waitWithSignal } from '@/utils/abort';
import type { LLMProvider } from './LLMProvider';

/** プロバイダの送信・本文読み取りだけを signal の期限で待つ。 */
export function withSignalDeadline(provider: LLMProvider): LLMProvider {
  return {
    providerId: provider.providerId,
    model: provider.model,
    chat: (messages, options) => {
      const work = provider.chat(messages, options);
      return options?.signal ? waitWithSignal(work, options.signal) : work;
    },
  };
}
