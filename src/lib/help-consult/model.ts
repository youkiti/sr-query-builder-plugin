// 相談専用の固定モデルと、登録済みキーから使う社を選ぶ規則。
import type { LlmProviderId } from '@/domain/llmApiLog';
import { resolveEffectiveModel, resolveProviderId } from '../llm/modelRegistry';

export const CONSULT_MODELS = {
  gemini: 'gemini-3.5-flash-lite',
  anthropic: 'claude-haiku-5-5',
  openrouter: 'deepseek/deepseek-v4-flash',
} as const;

export type ConsultProviderId = keyof typeof CONSULT_MODELS;
const PRIORITY: readonly ConsultProviderId[] = ['anthropic', 'gemini', 'openrouter'];

export function chooseConsultProvider(
  configured: ReadonlySet<LlmProviderId>, currentModelId?: string | null,
): ConsultProviderId | null {
  const effective = resolveEffectiveModel(currentModelId, {
    anthropic: configured.has('anthropic') ? 'configured' : null,
    gemini: configured.has('gemini') ? 'configured' : null,
  });
  const current = resolveProviderId(effective);
  if (PRIORITY.includes(current as ConsultProviderId) && configured.has(current)) {
    return current as ConsultProviderId;
  }
  return PRIORITY.find(provider => configured.has(provider)) ?? null;
}
