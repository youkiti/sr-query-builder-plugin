import {
  LlmProviderError,
  type ChatMessage,
  type ChatOptions,
  type ChatResponse,
  type JsonSchema,
  type LLMProvider,
} from './LLMProvider';

/**
 * Gemini API（generativelanguage.googleapis.com）向け実装。
 *
 * - 認証は API キー方式（クエリパラメータ `?key=`）
 * - `system` ロールは `systemInstruction` フィールドに分離
 * - `responseFormat: 'json'` で `responseMimeType: application/json` を要求
 * - `responseSchema` を渡すと `generationConfig.responseSchema` で
 *   **構造化出力（constrained decoding）** を要求し、壊れた JSON を防ぐ
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
    // responseSchema を渡すと構造化出力（スキーマ制約付き）になる。
    // responseSchema は必ず application/json を伴う必要がある。
    if (options.responseSchema) {
      generationConfig['responseMimeType'] = 'application/json';
      generationConfig['responseSchema'] = toGeminiSchema(options.responseSchema);
    } else if (options.responseFormat === 'json') {
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

/** 標準 JSON Schema の `type`（小文字）を Gemini Schema の Type enum（大文字）へ写す。 */
const GEMINI_TYPE_MAP: Record<string, string> = {
  string: 'STRING',
  number: 'NUMBER',
  integer: 'INTEGER',
  boolean: 'BOOLEAN',
  array: 'ARRAY',
  object: 'OBJECT',
};

/**
 * 標準 JSON Schema を Gemini の `responseSchema`（OpenAPI 3.0 サブセット）方言へ変換する。
 *
 * - `type` を大文字 enum へ写す（protobuf JSON は小文字を受け付けないため）
 * - Gemini Schema が知らないキー（`additionalProperties` / `$schema` / `strict` 等）は落とす
 *   （未知キーを送ると 400 になる）
 * - `properties` / `items` は再帰的に変換する
 */
export function toGeminiSchema(schema: JsonSchema): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    switch (key) {
      case 'type': {
        const mapped =
          typeof value === 'string' ? GEMINI_TYPE_MAP[value.toLowerCase()] : undefined;
        if (mapped !== undefined) {
          out['type'] = mapped;
        }
        break;
      }
      case 'properties': {
        const props = value as Record<string, JsonSchema>;
        out['properties'] = Object.fromEntries(
          Object.entries(props).map(([k, v]) => [k, toGeminiSchema(v)])
        );
        break;
      }
      case 'items':
        out['items'] = toGeminiSchema(value as JsonSchema);
        break;
      // Gemini Schema がそのまま受け付けるキーだけ通す
      case 'description':
      case 'enum':
      case 'required':
      case 'format':
      case 'nullable':
      case 'minItems':
      case 'maxItems':
        out[key] = value;
        break;
      // additionalProperties / $schema / strict 等の未知キーは落とす
      default:
        break;
    }
  }
  return out;
}
