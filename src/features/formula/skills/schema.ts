import type { JsonSchema } from '@/lib/llm';

/**
 * skill の構造化出力（structured output）用 JSON Schema を簡潔に組むためのヘルパ。
 *
 * 標準 JSON Schema 方言で書く（プロバイダ側がそれぞれの方言へ変換する）。
 * OpenAI 互換の strict モードに合わせ、`objectSchema` は既定で
 * `additionalProperties: false` と「全プロパティ required」を付与する。
 * Gemini 側は未対応キーを変換時に落とすので、この付与は無害。
 */

/** 文字列フィールド。 */
export function stringSchema(description?: string): JsonSchema {
  return description === undefined ? { type: 'string' } : { type: 'string', description };
}

/** 文字列 enum フィールド。 */
export function enumSchema(values: readonly string[], description?: string): JsonSchema {
  const base: JsonSchema = { type: 'string', enum: [...values] };
  return description === undefined ? base : { ...base, description };
}

/** 配列フィールド。 */
export function arraySchema(items: JsonSchema): JsonSchema {
  return { type: 'array', items };
}

/**
 * オブジェクトスキーマ。`required` 省略時は全プロパティを必須にする
 * （strict 構造化出力の要件）。
 */
export function objectSchema(
  properties: Record<string, JsonSchema>,
  required?: readonly string[]
): JsonSchema {
  return {
    type: 'object',
    properties,
    required: required === undefined ? Object.keys(properties) : [...required],
    additionalProperties: false,
  };
}
