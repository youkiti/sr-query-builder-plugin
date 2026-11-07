import type { LlmProviderId } from '@/domain/llmApiLog';

/**
 * 利用可能な LLM モデルのレジストリ。
 *
 * - `BUILTIN_MODELS` は UI のセレクタに出す既定モデル一覧。
 * - ユーザーは `CustomModel` を追加できる（Gemini・OpenRouter・Anthropic のモデル ID を指定）。
 * - `resolveProviderId` でモデル ID からプロバイダを逆引きする。
 */

export interface ModelDef {
  id: string;
  label: string;
  provider: LlmProviderId;
  /** Google AI Studio の無料枠でも利用できるモデルのとき true */
  freeTier?: boolean;
}

export interface CustomModel {
  id: string;
  label?: string;
}

export const BUILTIN_MODELS: readonly ModelDef[] = [
  { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', provider: 'gemini' },
  { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite（無料枠対応）', provider: 'gemini', freeTier: true },
  { id: 'qwen/qwen3-235b-a22b-2507', label: 'Qwen3 235B Instruct', provider: 'openrouter' },
  { id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash', provider: 'openrouter' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', provider: 'anthropic' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', provider: 'anthropic' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', provider: 'anthropic' },
] as const;

export const DEFAULT_MODEL = 'claude-opus-5-5';
export const LEGACY_DEFAULT_MODEL = 'gemini-3.5-flash-lite';
export const MODEL_BENCHMARK_URL = 'https://github.com/youkiti/sr-query-builder-plugin#benchmark';

// Gemini 2.0 Flash は 2026-06-01 に停止済み。
// Gemini 3.5 Flash への要求は Google が 3.6 Flash へ転送するため、保存済みの選択を置き換える。
export const MODEL_ID_REPLACEMENTS: Readonly<Record<string, string>> = {
  'gemini-2.0-flash': 'gemini-3.5-flash-lite',
  'gemini-3.5-flash': 'gemini-3.6-flash',
};

/** 保存済みのモデル ID を現在の選択用 ID に置き換える。 */
export function replaceSavedModelId(modelId: string): string {
  return Object.prototype.hasOwnProperty.call(MODEL_ID_REPLACEMENTS, modelId)
    ? MODEL_ID_REPLACEMENTS[modelId] ?? modelId
    : modelId;
}

/** 保存済みモデルを優先し、未選択なら登録済みキーからモデルを決める。 */
export function resolveEffectiveModel(
  savedModel: string | null | undefined,
  keys: { anthropic?: string | null; gemini?: string | null },
): string {
  if (savedModel) return replaceSavedModelId(savedModel);
  if (keys.anthropic?.trim()) return DEFAULT_MODEL;
  if (keys.gemini?.trim()) return LEGACY_DEFAULT_MODEL;
  return DEFAULT_MODEL;
}

export const MAX_CUSTOM_MODELS = 20;

/**
 * モデル ID からプロバイダを解決する。
 *
 * 1. `BUILTIN_MODELS` に定義があればそれを使う。
 * 2. モデル ID が `/` を含む（OpenRouter の `org/model` 形式）なら `openrouter`。
 * 3. `claude-` で始まるモデル ID は `anthropic`。
 * 4. それ以外は `gemini`。
 */
export function resolveProviderId(modelId: string): LlmProviderId {
  const builtin = BUILTIN_MODELS.find((m) => m.id === modelId);
  if (builtin) {
    return builtin.provider;
  }
  if (modelId.includes('/')) {
    return 'openrouter';
  }
  if (modelId.startsWith('claude-')) {
    return 'anthropic';
  }
  return 'gemini';
}
