import type { LlmApiLogEntry, LlmPurpose } from '@/domain/llmApiLog';
import { nowIso } from '@/utils/iso8601';
import { newUuid } from '@/utils/uuid';
import {
  LlmProviderError,
  type ChatMessage,
  type ChatOptions,
  type ChatResponse,
  type LLMProvider,
} from './LLMProvider';
import { estimateCostUsd } from './pricing';

/**
 * 任意の LLMProvider をラップして、各 chat() 呼び出し時に
 * full prompt / full response を Drive へ保存し、
 * Sheets の `LLMApiLog` タブにメタ情報を 1 行追記する。
 *
 * requirements.md §3.1 / §4.9 / §6（監査性）に対応。
 */

export interface ApiLoggerDeps {
  /** Drive に JSON ファイルをアップロードして webViewLink を返す */
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

  return {
    providerId: provider.providerId,
    model: provider.model,
    chat: async (messages: readonly ChatMessage[], options?: ChatOptions) => {
      const logId = uuid();
      const startedAt = now();
      const startMs = Date.now();
      let response: ChatResponse | null = null;
      let errorMessage: string | null = null;
      try {
        response = await provider.chat(messages, options);
        return response;
      } catch (err) {
        errorMessage = formatError(err);
        throw err;
      } finally {
        const latencyMs = Date.now() - startMs;
        const promptUpload = await deps.uploadJson({
          filename: `${logId}.prompt.json`,
          content: JSON.stringify({ messages, options }, null, 2),
        });
        const responseUpload = await deps.uploadJson({
          filename: `${logId}.response.json`,
          content: JSON.stringify(
            response !== null ? response.raw : { error: errorMessage },
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
          promptSummary: buildPromptSummary(messages),
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
        };
        await deps.appendLogEntry(entry);
      }
    },
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
