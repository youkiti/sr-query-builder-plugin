// 小節選択と回答を一度ずつ送り、終了理由・中止・タイムアウトと送信失敗を分類する。
import { createProvider } from '../llm/providerFactory';
import { LlmProviderError, type ChatResponse } from '../llm/LLMProvider';
import { ensureLlmHostPermission, LlmHostPermissionMissingError, type LlmHostPermissions } from '../llm/hostPermissions';
import { CONSULT_MODELS, type ConsultProviderId } from './model';
import { buildAnswerPrompt, buildSelectionPrompt, validateSelectedIds } from './prompt';
import type { ConsultFailureKind, ConsultResult, HelpLanguage, HelpSection } from './types';

export function classifyConsultError(error: unknown): ConsultFailureKind {
  if (error instanceof LlmHostPermissionMissingError) {
    return 'permission_missing';
  }
  if (error instanceof LlmProviderError) {
    if (error.status === 429) {
      return 'rate_limited';
    }
    if (error.status === 401 || error.status === 403) {
      return 'auth';
    }
  }
  if (error instanceof SyntaxError) {
    return 'invalid_response';
  }
  if (error instanceof TypeError) {
    return 'network';
  }
  return 'unknown';
}

function responseFailure(response: ChatResponse): ConsultFailureKind | null {
  if (['MAX_TOKENS', 'length', 'max_tokens'].includes(response.finishReason ?? '')) {
    return 'truncated';
  }
  if (['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'OTHER', 'content_filter', 'refusal']
    .includes(response.finishReason ?? '') || !response.text.trim()) {
    return 'invalid_response';
  }
  return null;
}

export interface ConsultHelpParams {
  question: string;
  lang: HelpLanguage;
  sections: readonly HelpSection[];
  providerId: ConsultProviderId | null | undefined;
  apiKey: string | null | undefined;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetch?: typeof fetch;
  permissions?: LlmHostPermissions;
}

export async function consultHelp(params: ConsultHelpParams): Promise<ConsultResult> {
  const { question, lang, sections, providerId, apiKey } = params;
  if (!providerId || !apiKey?.trim()) {
    return { status: 'failure', kind: 'no_key' };
  }
  const controller = new AbortController();
  let reason: 'aborted' | 'timeout' | undefined;
  let rejectAbort: (error: Error) => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const abort = (kind: 'aborted' | 'timeout') => {
    if (!reason) {
      reason = kind;
      controller.abort();
      rejectAbort(new Error(kind));
    }
  };
  const onAbort = () => abort('aborted');
  params.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => abort('timeout'), params.timeoutMs ?? 60000);
  const run = async (): Promise<ConsultResult> => {
    await ensureLlmHostPermission(providerId, params.permissions);
    if (controller.signal.aborted) {
      return { status: 'failure', kind: reason ?? 'aborted' };
    }
    const model = CONSULT_MODELS[providerId];
    const provider = createProvider({ provider: providerId, apiKey, model, fetch: params.fetch });
    // 推論のトークンも上限に数える社があり、2,048 では回答が打ち切られた実例があるため余裕を持たせる。
    const options = { signal: controller.signal, maxOutputTokens: 8192 };
    const selection = buildSelectionPrompt(sections, question);
    const selectedResponse = await provider.chat(selection.messages, { ...options, responseSchema: selection.responseSchema });
    const selectionFailure = responseFailure(selectedResponse);
    if (selectionFailure) {
      return { status: 'failure', kind: selectionFailure };
    }
    const selected = validateSelectedIds(selectedResponse.text, sections);
    if (selected.status === 'failure') {
      return selected;
    }
    if (selected.sectionIds.length === 0) {
      return { status: 'no_match' };
    }
    if (controller.signal.aborted) {
      return { status: 'failure', kind: reason ?? 'aborted' };
    }
    const picked = selected.sectionIds.map(id => sections.find(section => section.id === id)!);
    const response = await provider.chat(buildAnswerPrompt(picked, question, lang), options);
    const failure = responseFailure(response);
    if (failure) {
      return { status: 'failure', kind: failure };
    }
    return { status: 'success', providerId, model, sectionIds: selected.sectionIds, answer: response.text };
  };
  try {
    if (params.signal?.aborted) {
      return { status: 'failure', kind: 'aborted' };
    }
    const running = run();
    // 中止・タイムアウトで置き去りになった本体が後から失敗しても、未処理の reject にしない。
    running.catch(() => undefined);
    return await Promise.race([running, aborted]);
  } catch (error) {
    return { status: 'failure', kind: reason ?? classifyConsultError(error) };
  } finally {
    clearTimeout(timer);
    params.signal?.removeEventListener('abort', onAbort);
  }
}
