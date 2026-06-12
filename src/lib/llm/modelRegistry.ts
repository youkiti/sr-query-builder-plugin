import type { LlmProviderId } from '@/domain/llmApiLog';

/**
 * 利用可能な LLM モデルのレジストリ。
 *
 * - `BUILTIN_MODELS` は UI のセレクタに出す既定モデル一覧。
 * - ユーザーは `CustomModel` を追加できる（OpenRouter のモデル ID を直接指定する想定）。
 * - `resolveProviderId` でモデル ID からプロバイダを逆引きする。
 */

export interface ModelDef {
  id: string;
  label: string;
  provider: LlmProviderId;
}

export interface CustomModel {
  id: string;
  label?: string;
}

export const BUILTIN_MODELS: readonly ModelDef[] = [
  { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', provider: 'gemini' },
  { id: 'qwen/qwen3-235b-a22b-2507', label: 'Qwen3 235B Instruct', provider: 'openrouter' },
  { id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash', provider: 'openrouter' },
] as const;

export const DEFAULT_MODEL = 'gemini-3.5-flash';

export const MAX_CUSTOM_MODELS = 20;

/**
 * モデル ID からプロバイダを解決する。
 *
 * 1. `BUILTIN_MODELS` に定義があればそれを使う。
 * 2. モデル ID が `/` を含む（OpenRouter の `org/model` 形式）なら `openrouter`。
 * 3. それ以外は `gemini`。
 */
export function resolveProviderId(modelId: string): LlmProviderId {
  const builtin = BUILTIN_MODELS.find((m) => m.id === modelId);
  if (builtin) {
    return builtin.provider;
  }
  if (modelId.includes('/')) {
    return 'openrouter';
  }
  return 'gemini';
}
