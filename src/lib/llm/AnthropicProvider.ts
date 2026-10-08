import {
  LlmProviderError,
  type ChatMessage,
  type ChatOptions,
  type ChatResponse,
  type LLMProvider,
  type ToolChatMessage,
  type ToolDefinition,
  type ToolChatOptions,
  type ToolChatResponse,
  type ToolCall,
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
  content?: unknown[];
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
      ...this.thinking(),
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
    return this.readResponse(await this.request(body, options.signal));
  }

  async chatWithTools(system: string, messages: readonly ToolChatMessage[], tools: readonly ToolDefinition[],
    options: ToolChatOptions = {}): Promise<ToolChatResponse> {
    const json = await this.request({
      model: this.model, max_tokens: options.maxOutputTokens ?? 16000,
      system, messages, ...this.thinking(),
      tools: tools.map(({ name, description, inputSchema }) => ({ name, description, input_schema: inputSchema })),
      cache_control: { type: 'ephemeral' },
      ...(this.effort !== undefined ? { output_config: { effort: this.effort } } : {}),
    }, options.signal);
    const content = json.content ?? [];
    const toolCalls: ToolCall[] = [];
    for (const block of content) {
      if (block && typeof block === 'object' && 'type' in block && block.type === 'tool_use'
        && 'id' in block && typeof block.id === 'string' && 'name' in block && typeof block.name === 'string'
        && 'input' in block) toolCalls.push({ id: block.id, name: block.name, input: block.input });
    }
    return { ...this.readResponse(json), content, toolCalls, stopReason: json.stop_reason ?? null };
  }

  private thinking(): Record<string, unknown> {
    return /^claude-(?:opus|sonnet|haiku)-5/.test(this.model) ? { thinking: { type: 'adaptive' } } : {};
  }

  private async request(body: Record<string, unknown>, signal?: AbortSignal): Promise<AnthropicResponse> {
    const fetchFn = this.fetchImpl ?? globalThis.fetch;
    const res = await fetchFn(ENDPOINT, {
      method: 'POST',
      signal,
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
        if (signal?.aborted) throw err;
        return '';
      });
      // 応答本文がキーを含んでいても例外やログへ残さない。
      const safeText = this.apiKey ? text.split(this.apiKey).join('[REDACTED]') : text;
      throw new LlmProviderError(
        `Anthropic API failed: HTTP ${res.status}`, this.providerId, res.status, safeText
      );
    }
    return await res.json() as AnthropicResponse;
  }

  private readResponse(json: AnthropicResponse): ChatResponse {
    return {
      text: (json.content ?? []).map((block) => block && typeof block === 'object'
        && 'type' in block && block.type === 'text' && 'text' in block && typeof block.text === 'string'
        ? block.text : '').join(''),
      tokensIn: json.usage ? json.usage.input_tokens
        + (json.usage.cache_creation_input_tokens ?? 0)
        + (json.usage.cache_read_input_tokens ?? 0) : null,
      tokensOut: json.usage?.output_tokens ?? null,
      raw: json,
    };
  }
}
