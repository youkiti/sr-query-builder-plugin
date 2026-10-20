import type { LlmPurpose, LlmProviderId } from '@/domain/llmApiLog';

/** 雛形を変更するときは版と固定ハッシュを同時に更新する。 */
export const PROMPT_VERSIONS: Record<LlmPurpose, string> = {
  draft_block: '1.0.0',
  draft_agent: '1.0.0',
  suggest_mesh: '1.0.0',
  expand_freeword: '1.0.0',
  design_filter: '1.0.0',
  pick_boundary: '1.0.0',
  pick_seed: '1.0.0',
  design_specific_query: '1.0.0',
  expand_recall: '1.0.0',
  interpret_result: '1.0.0',
  extract_protocol: '1.0.0',
  improve_block: '1.0.0',
  optimize_query: '1.0.0',
  annotate_lost_sample: '1.0.0',
  other: '1.0.0',
};

export function getPromptVersion(purpose: LlmPurpose, provider: LlmProviderId): string {
  return PROMPT_VERSIONS[purpose] + (purpose === 'extract_protocol'
    ? provider === 'anthropic' ? '+anthropic' : '+standard' : '');
}
