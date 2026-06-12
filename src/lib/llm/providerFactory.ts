import { GeminiProvider } from './GeminiProvider';
import { OpenRouterProvider } from './OpenRouterProvider';
import { resolveProviderId, DEFAULT_MODEL } from './modelRegistry';
import type { LLMProvider } from './LLMProvider';

/**
 * Config に応じて LLMProvider のインスタンスを返すファクトリ。
 *
 * - `provider` を省略した場合は `model` から `resolveProviderId` で逆引きする。
 * - `model` を省略した場合は `modelRegistry` の `DEFAULT_MODEL` を使う。
 * - 既存呼び出しとの後方互換のため `provider` の明示指定もそのまま受け付ける。
 */

export interface ProviderConfig {
  provider?: 'gemini' | 'openrouter'; // 省略時は model から自動解決
  apiKey: string;
  model?: string; // 省略時は modelRegistry の DEFAULT_MODEL
  fetch?: typeof fetch;
}

export function createProvider(config: ProviderConfig): LLMProvider {
  const resolvedModel = config.model ?? DEFAULT_MODEL;
  const resolvedProvider = config.provider ?? resolveProviderId(resolvedModel);
  switch (resolvedProvider) {
    case 'gemini':
      return new GeminiProvider({
        apiKey: config.apiKey,
        model: resolvedModel,
        fetch: config.fetch,
      });
    case 'openrouter':
      return new OpenRouterProvider({
        apiKey: config.apiKey,
        model: resolvedModel,
        fetch: config.fetch,
      });
    default:
      throw new Error(`未対応の provider: ${String(resolvedProvider)}`);
  }
}
