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
 * 試行ごとの signal を下位へ渡す。期限による待機の打ち切りはプロバイダ直上の層が担う。
 */

/** 再試行対象の HTTP ステータス（一時的エラーのみ） */
export const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);

export type LlmRequestState = 'retry' | 'failure' | 'idle';

export interface RetryOptions {
  /** 各送信の直前に呼ぶ。例外は再試行せず、そのまま呼び出し側へ返す。 */
  beforeAttempt?: () => void | Promise<void>;
  /** 各試行専用の signal を、送信直前の確認後に生成して下位へ渡す。 */
  createSignal?: () => AbortSignal;
  /** 任意の表示通知。未注入時の再試行回数・待機は変えない。 */
  onRequestState?: (state: LlmRequestState) => void;
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
  const notify = (state: LlmRequestState): void => {
    try { options.onRequestState?.(state); } catch { /* 表示側の失敗は通信へ伝播させない。 */ }
  };

  return {
    providerId: provider.providerId,
    model: provider.model,
    chat: async (messages: readonly ChatMessage[], opts?: ChatOptions): Promise<ChatResponse> => {
      for (let attempt = 1; ; attempt += 1) {
        if (options.beforeAttempt) await options.beforeAttempt();
        const signal = options.createSignal?.() ?? opts?.signal;
        if (signal?.aborted) throw signal.reason;
        try {
          return await provider.chat(messages, signal ? { ...opts, signal } : opts);
        } catch (err) {
          if (attempt >= maxAttempts || !isRetryable(err)) {
            notify('failure');
            throw err;
          }
          notify('retry');
          await sleep(baseDelayMs * 2 ** (attempt - 1));
          notify('idle');
        }
      }
    },
  };
}
