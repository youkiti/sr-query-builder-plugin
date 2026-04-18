import { GeminiProvider } from './GeminiProvider';
import type { LLMProvider } from './LLMProvider';

/**
 * Config に応じて LLMProvider のインスタンスを返すファクトリ。
 * MVP では Gemini のみ。将来 OpenAI / Claude / OpenRouter を追加する際は
 * provider 値を分岐に追加するだけで skill 側は変更不要にする。
 */

export interface ProviderConfig {
  provider: 'gemini';
  apiKey: string;
  model?: string;
  fetch?: typeof fetch;
}

export function createProvider(config: ProviderConfig): LLMProvider {
  switch (config.provider) {
    case 'gemini':
      return new GeminiProvider({
        apiKey: config.apiKey,
        model: config.model,
        fetch: config.fetch,
      });
  }
}
