import {
  LlmProviderError,
  type ChatMessage,
  type ChatOptions,
  type ChatResponse,
  type LLMProvider,
} from './LLMProvider';

/**
 * Gemini API（generativelanguage.googleapis.com）向け実装。
 *
 * - 認証は API キー方式（クエリパラメータ `?key=`）
 * - `system` ロールは `systemInstruction` フィールドに分離
 * - `responseFormat: 'json'` で `responseMimeType: application/json` を要求
 * - fetch を注入できるので OAuth / network 無しでテスト可能
 */

export interface GeminiProviderOptions {
  apiKey: string;
  model?: string;
  fetch?: typeof fetch;
}

const DEFAULT_MODEL = 'gemini-3.5-flash';
const ENDPOINT_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }>; role?: string };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

export class GeminiProvider implements LLMProvider {
  readonly providerId = 'gemini' as const;
  readonly model: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch | undefined;

  constructor(options: GeminiProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_MODEL;
    this.fetchImpl = options.fetch;
  }

  async chat(messages: readonly ChatMessage[], options: ChatOptions = {}): Promise<ChatResponse> {
    const url = `${ENDPOINT_BASE}/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(
      this.apiKey
    )}`;
    const body = this.buildRequestBody(messages, options);
    const fetchFn = this.fetchImpl ?? globalThis.fetch;
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new LlmProviderError(
        `Gemini API failed: HTTP ${res.status}`,
        this.providerId,
        res.status,
        text
      );
    }
    const json = (await res.json()) as GeminiResponse;
    const text = extractText(json);
    return {
      text,
      tokensIn: json.usageMetadata?.promptTokenCount ?? null,
      tokensOut: json.usageMetadata?.candidatesTokenCount ?? null,
      raw: json,
    };
  }

  private buildRequestBody(
    messages: readonly ChatMessage[],
    options: ChatOptions
  ): Record<string, unknown> {
    const systemTexts = messages.filter((m) => m.role === 'system').map((m) => m.content);
    const conversational = messages.filter((m) => m.role !== 'system');

    const contents = conversational.map((m) => ({
      role: m.role === 'model' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    const generationConfig: Record<string, unknown> = {};
    if (options.temperature !== undefined) {
      generationConfig['temperature'] = options.temperature;
    }
    if (options.maxOutputTokens !== undefined) {
      generationConfig['maxOutputTokens'] = options.maxOutputTokens;
    }
    if (options.responseFormat === 'json') {
      generationConfig['responseMimeType'] = 'application/json';
    }

    const body: Record<string, unknown> = { contents };
    if (systemTexts.length > 0) {
      body['systemInstruction'] = { parts: systemTexts.map((t) => ({ text: t })) };
    }
    if (Object.keys(generationConfig).length > 0) {
      body['generationConfig'] = generationConfig;
    }
    return body;
  }
}

function extractText(json: GeminiResponse): string {
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  return parts
    .map((p) => p.text ?? '')
    .filter((t) => t.length > 0)
    .join('');
}
