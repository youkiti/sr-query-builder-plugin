import { AnthropicProvider, type AnthropicEffort } from './AnthropicProvider';
import { GeminiProvider } from './GeminiProvider';
import { OpenRouterProvider } from './OpenRouterProvider';
import { resolveProviderId, DEFAULT_MODEL, LEGACY_DEFAULT_MODEL } from './modelRegistry';
import type { LLMProvider } from './LLMProvider';

/**
 * Config に応じて LLMProvider のインスタンスを返すファクトリ。
 *
 * - `provider` を省略した場合は `model` から `resolveProviderId` で逆引きする。
 * - `model` 省略時は Gemini / OpenRouter の明示指定なら `LEGACY_DEFAULT_MODEL`、それ以外は `DEFAULT_MODEL` を使う。
 * - 既存呼び出しとの後方互換のため `provider` の明示指定もそのまま受け付ける。
 */

export interface ProviderConfig {
  provider?: 'gemini' | 'openrouter' | 'anthropic'; // 省略時は model から自動解決
  apiKey: string;
  model?: string; // 省略時は Gemini / OpenRouter 明示なら LEGACY_DEFAULT_MODEL、それ以外は DEFAULT_MODEL
  fetch?: typeof fetch;
  effort?: AnthropicEffort;
}

export function createProvider(config: ProviderConfig): LLMProvider {
  const resolvedModel = config.model ?? (
    config.provider === 'gemini' || config.provider === 'openrouter'
      ? LEGACY_DEFAULT_MODEL
      : DEFAULT_MODEL
  );
  const resolvedProvider = config.provider ?? resolveProviderId(resolvedModel);
  switch (resolvedProvider) {
    case 'anthropic':
      return new AnthropicProvider({
        apiKey: config.apiKey,
        model: resolvedModel,
        fetch: config.fetch,
        effort: config.effort,
      });
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
