import {
  LlmProviderError,
  type ChatMessage,
  type ChatOptions,
  type ChatResponse,
  type LLMProvider,
} from './LLMProvider';

/**
 * 任意の LLMProvider を「一時的エラー時に指数バックオフで再試行する」ラッパで包む。
 *
 * Gemini API は過負荷時に HTTP 503 / レート制限時に 429 を返すことがあり、
 * これらは数秒待って再送すれば成功する可能性が高い。4xx の入力エラー
 * （400 / 401 / 403 など）は再試行しても無駄なので即座に投げ直す。
 */

/** 再試行対象の HTTP ステータス（一時的エラーのみ） */
export const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);

export interface RetryOptions {
  /** 最大試行回数（初回を含む）。既定 3 回 */
  maxAttempts?: number;
  /** バックオフの基準待ち時間（ms）。試行 n 回目の失敗後に baseDelayMs * 2^(n-1) 待つ。既定 1000 */
  baseDelayMs?: number;
  /** テスト時に差し替え可能な sleep 実装 */
  sleep?: (ms: number) => Promise<void>;
  /** 再試行可否の判定。既定は LlmProviderError かつ status が RETRYABLE_STATUSES */
  isRetryable?: (err: unknown) => boolean;
}

function defaultIsRetryable(err: unknown): boolean {
  return (
    err instanceof LlmProviderError && err.status !== null && RETRYABLE_STATUSES.has(err.status)
  );
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function withRetry(provider: LLMProvider, options: RetryOptions = {}): LLMProvider {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 1000;
  const sleep = options.sleep ?? defaultSleep;
  const isRetryable = options.isRetryable ?? defaultIsRetryable;

  return {
    providerId: provider.providerId,
    model: provider.model,
    chat: async (messages: readonly ChatMessage[], opts?: ChatOptions): Promise<ChatResponse> => {
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await provider.chat(messages, opts);
        } catch (err) {
          if (attempt >= maxAttempts || !isRetryable(err)) {
            throw err;
          }
          await sleep(baseDelayMs * 2 ** (attempt - 1));
        }
      }
    },
  };
}
