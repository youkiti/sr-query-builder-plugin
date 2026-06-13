import {
  LlmProviderError,
  type ChatMessage,
  type ChatOptions,
  type ChatResponse,
  type LLMProvider,
} from './LLMProvider';

/**
 * OpenRouter（OpenAI 互換 REST API）向け実装。
 *
 * - 認証は `Authorization: Bearer {apiKey}` ヘッダ。
 * - 本拡張の `model` ロールは OpenAI 互換の `assistant` ロールへ変換する。
 *   `system` / `user` はそのまま。
 * - `responseSchema` を渡すと `response_format: { type: 'json_schema', ... }` で
 *   **構造化出力** を要求する。スキーマ無しで `responseFormat: 'json'` のときは
 *   `response_format: { type: 'json_object' }`（JSON モード）にフォールバックする。
 * - fetch を注入できるので network 無しでテスト可能。
 */

export interface OpenRouterProviderOptions {
  apiKey: string;
  model: string;
  fetch?: typeof fetch;
}

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

interface OpenRouterResponse {
  choices?: Array<{
    message?: { role?: string; content?: string | null };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export class OpenRouterProvider implements LLMProvider {
  readonly providerId = 'openrouter' as const;
  readonly model: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch | undefined;

  constructor(options: OpenRouterProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.fetchImpl = options.fetch;
  }

  async chat(messages: readonly ChatMessage[], options: ChatOptions = {}): Promise<ChatResponse> {
    const body = this.buildRequestBody(messages, options);
    const fetchFn = this.fetchImpl ?? globalThis.fetch;
    const res = await fetchFn(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
        'HTTP-Referer': 'https://github.com/youkiti/sr-query-builder-plugin',
        'X-Title': 'sr-query-builder-plugin',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new LlmProviderError(
        `OpenRouter API failed: HTTP ${res.status}`,
        this.providerId,
        res.status,
        text
      );
    }
    const json = (await res.json()) as OpenRouterResponse;
    const text = json.choices?.[0]?.message?.content ?? '';
    return {
      text: text ?? '',
      tokensIn: json.usage?.prompt_tokens ?? null,
      tokensOut: json.usage?.completion_tokens ?? null,
      raw: json,
    };
  }

  private buildRequestBody(
    messages: readonly ChatMessage[],
    options: ChatOptions
  ): Record<string, unknown> {
    const mapped = messages.map((m) => ({
      role: m.role === 'model' ? 'assistant' : m.role,
      content: m.content,
    }));

    const body: Record<string, unknown> = {
      model: this.model,
      messages: mapped,
    };
    if (options.temperature !== undefined) {
      body['temperature'] = options.temperature;
    }
    if (options.maxOutputTokens !== undefined) {
      body['max_tokens'] = options.maxOutputTokens;
    }
    if (options.responseSchema) {
      // OpenAI 互換の構造化出力。strict:true は additionalProperties:false と
      // 全プロパティ required を要求するため、schema 側でそれを満たしている前提。
      body['response_format'] = {
        type: 'json_schema',
        json_schema: {
          name: 'response',
          strict: true,
          schema: options.responseSchema,
        },
      };
    } else if (options.responseFormat === 'json') {
      body['response_format'] = { type: 'json_object' };
    }
    return body;
  }
}
