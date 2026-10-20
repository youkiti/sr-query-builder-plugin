import type { LlmApiLogEntry, LlmPurpose } from '@/domain/llmApiLog';
import { nowIso } from '@/utils/iso8601';
import { newUuid } from '@/utils/uuid';
import {
  LlmProviderError,
  type ChatMessage,
  type ChatResponse,
  type LLMProvider,
} from './LLMProvider';
import type { RequestMetadata } from './LLMProvider';
import { estimateCostUsd } from './pricing';

/**
 * 任意の LLMProvider をラップして、各 chat() 呼び出し時に
 * full prompt / full response を Drive へ保存し、
 * Sheets の `LLMApiLog` タブにメタ情報を 1 行追記する。
 *
 * requirements.md §3.1 / §4.9 / §6（監査性）に対応。
 */

export interface ApiLoggerDeps {
  promptVersion?: string | null;
  /** Drive に JSON ファイルをアップロードして webViewLink を返す */
  executedBy?: string | null;
  onResponse?: (response: ChatResponse) => void;
  uploadJson: (params: {
    filename: string;
    content: string;
  }) => Promise<{ webViewLink: string }>;
  /** Sheets の LLMApiLog タブに 1 行追記する */
  appendLogEntry: (entry: LlmApiLogEntry) => Promise<void>;
  /** テスト時に差し替え可能な UUID 発番 */
  newUuid?: () => string;
  /** テスト時に差し替え可能な現在時刻 */
  now?: () => string;
}

/** プロンプト先頭 500 文字をプレビューとして抜粋 */
const PROMPT_SUMMARY_LENGTH = 500;

export function buildPromptSummary(messages: readonly ChatMessage[]): string {
  const text = messages
    .map((m) => `[${m.role}] ${m.content}`)
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= PROMPT_SUMMARY_LENGTH) {
    return text;
  }
  return `${text.slice(0, PROMPT_SUMMARY_LENGTH - 1)}…`;
}

/**
 * LLMProvider を「呼ぶたびに監査ログを残す」ラッパで包む。
 * skill ごとに `purpose` を指定し、`LLMApiLog.purpose` 列で識別できるようにする。
 */
export function withLogging(
  provider: LLMProvider,
  purpose: LlmPurpose,
  deps: ApiLoggerDeps
): LLMProvider {
  const uuid = deps.newUuid ?? newUuid;
  const now = deps.now ?? nowIso;

  const log = async <T extends ChatResponse>(request: Record<string, unknown>, summary: string, call: (capture: (metadata: RequestMetadata) => void) => Promise<T>): Promise<T> => {
    const logId = uuid();
    const startedAt = now();
    const startMs = Date.now();
    const metadata: { current: RequestMetadata | null } = { current: null };
    const promptVersion = deps.promptVersion ?? null;
    let response: ChatResponse | null = null;
    let errorMessage: string | null = null;
    try {
      const result = await call((sent) => { metadata.current = sent; });
      response = result;
      try { deps.onResponse?.(result); } catch { console.warn('LLM の費用通知に失敗しました'); }
      return result;
    } catch (err) {
      errorMessage = formatError(err);
      throw err;
    } finally {
      const latencyMs = Date.now() - startMs;
      try {
        const promptUpload = await deps.uploadJson({
          filename: `${logId}.prompt.json`,
          content: JSON.stringify({
            log_id: logId, timestamp: startedAt, provider: provider.providerId,
            model_requested: provider.model, purpose, prompt_version: promptVersion,
            executed_by: deps.executedBy ?? null, ...request,
            generation_settings_sent: metadata.current?.generationSettingsSent ?? null,
            ...(metadata.current?.responseSchemaSent ? { response_schema_sent: metadata.current.responseSchemaSent } : {}),
          }, null, 2),
        });
        const responseUpload = await deps.uploadJson({
          filename: `${logId}.response.json`,
          content: JSON.stringify(
            { model_reported: response?.modelReported ?? null, provider_reported: response?.providerReported ?? null,
              raw: response !== null ? response.raw : { error: errorMessage } },
            null,
            2
          ),
        });
        const entry: LlmApiLogEntry = {
          logId,
          timestamp: startedAt,
          provider: provider.providerId,
          model: provider.model,
          purpose,
          promptRef: promptUpload.webViewLink,
          responseRef: responseUpload.webViewLink,
          promptSummary: summary,
          tokensIn: response?.tokensIn ?? null,
          tokensOut: response?.tokensOut ?? null,
          latencyMs,
          // モデル単価表（pricing.ts）から概算コストを算出。未知モデルは null。
          costEstimateUsd: estimateCostUsd(
            provider.model,
            response?.tokensIn ?? null,
            response?.tokensOut ?? null
          ),
          error: errorMessage,
          modelReported: response?.modelReported ?? null,
          promptVersion,
          executedBy: deps.executedBy ?? null,
        };
        await deps.appendLogEntry(entry);
      } catch {
        // 保存エラーの本文は認証情報を含みうるため出力しない。
        console.warn('LLM の監査ログを保存できませんでした');
      }
    }
  };
  return {
    providerId: provider.providerId,
    model: provider.model,
    chat: (messages, options) => log({ messages, options_requested_by_caller: options }, buildPromptSummary(messages),
      (onRequestSent) => provider.chat(messages, { ...options, onRequestSent })),
    ...(provider.chatWithTools ? {
      chatWithTools: (system, messages, tools, options) => {
        const last = [...messages].reverse().find((message) => message.role === 'user');
        const content = typeof last?.content === 'string' ? last.content : (last?.content ?? []).map((block) =>
          block && typeof block === 'object' && 'type' in block && block.type === 'tool_result'
            && 'content' in block && typeof block.content === 'string' ? block.content : '').join('\n');
        return log({ system, messages, tools, options_requested_by_caller: options }, buildPromptSummary([{ role: 'user', content }]),
          (onRequestSent) => provider.chatWithTools!(system, messages, tools, { ...options, onRequestSent }));
      },
    } satisfies Partial<LLMProvider> : {}),
  };
}

function formatError(err: unknown): string {
  if (err instanceof LlmProviderError) {
    return `${err.message} (status=${err.status ?? 'n/a'})`;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
