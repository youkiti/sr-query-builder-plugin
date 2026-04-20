/**
 * LLMApiLog タブに対応する型。
 * requirements.md §3.1 参照。
 */

export type LlmProviderId = 'gemini' | 'openai' | 'anthropic' | 'openrouter';

export type LlmPurpose =
  | 'draft_block'
  | 'suggest_mesh'
  | 'expand_freeword'
  | 'design_filter'
  | 'pick_boundary'
  | 'interpret_result'
  | 'extract_protocol'
  | 'improve_block'
  | 'other';

export interface LlmApiLogEntry {
  logId: string;
  timestamp: string;
  provider: LlmProviderId;
  model: string;
  purpose: LlmPurpose;
  promptRef: string;
  responseRef: string;
  promptSummary: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  latencyMs: number | null;
  costEstimateUsd: number | null;
  error: string | null;
}
