import {
  LlmProviderError,
  type ChatMessage,
  type ChatOptions,
  type ChatResponse,
  type LLMProvider,
} from './LLMProvider';

export type AnthropicEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
  fetch?: typeof fetch;
  effort?: AnthropicEffort;
}

const ENDPOINT = 'https://api.anthropic.com/v1/messages';

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string }>;
  stop_reason?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

/** Anthropic Messages API への直接接続。fetch はテスト用に注入できる。 */
export class AnthropicProvider implements LLMProvider {
  readonly providerId = 'anthropic' as const;
  readonly model: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly effort: AnthropicEffort | undefined;

  constructor(options: AnthropicProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.fetchImpl = options.fetch;
    this.effort = options.effort;
  }

  async chat(messages: readonly ChatMessage[], options: ChatOptions = {}): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: options.maxOutputTokens ?? 16000,
      messages: messages.filter((m) => m.role !== 'system').map((m) => ({
        role: m.role === 'model' ? 'assistant' : m.role,
        content: m.content,
      })),
      thinking: { type: 'adaptive' },
    };
    const system = messages.filter((m) => m.role === 'system');
    if (system.length > 0) body['system'] = system.map((m) => m.content).join('\n\n');
    // temperature は送らず、構造化出力と推論の強さだけを指定する。
    if (options.responseSchema || this.effort !== undefined) {
      body['output_config'] = {
        ...(options.responseSchema
          ? { format: { type: 'json_schema', schema: options.responseSchema } } : {}),
        ...(this.effort !== undefined ? { effort: this.effort } : {}),
      };
    }
    const fetchFn = this.fetchImpl ?? globalThis.fetch;
    const res = await fetchFn(ENDPOINT, {
      method: 'POST',
      signal: options.signal,
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch((err: unknown) => {
        if (options.signal?.aborted) throw err;
        return '';
      });
      // 応答本文がキーを含んでいても例外やログへ残さない。
      const safeText = this.apiKey ? text.split(this.apiKey).join('[REDACTED]') : text;
      throw new LlmProviderError(
        `Anthropic API failed: HTTP ${res.status}`, this.providerId, res.status, safeText
      );
    }
    const json = (await res.json()) as AnthropicResponse;
    return {
      text: (json.content ?? []).filter((block) => block.type === 'text')
        .map((block) => block.text ?? '').join(''),
      tokensIn: json.usage ? json.usage.input_tokens
        + (json.usage.cache_creation_input_tokens ?? 0)
        + (json.usage.cache_read_input_tokens ?? 0) : null,
      tokensOut: json.usage?.output_tokens ?? null,
      raw: json,
    };
  }
}
