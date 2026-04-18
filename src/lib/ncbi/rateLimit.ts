/**
 * 指数バックオフの待機時間（ms）を計算する。
 * `attempt` は 0 スタート（初回リトライが 0）。
 *
 * 既定: `baseMs=1000`、`maxMs=32000`、倍率 2。
 */
export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  factor?: number;
}

export function exponentialBackoff(attempt: number, options: BackoffOptions = {}): number {
  const baseMs = options.baseMs ?? 1000;
  const maxMs = options.maxMs ?? 32000;
  const factor = options.factor ?? 2;
  const raw = baseMs * Math.pow(factor, attempt);
  return Math.min(raw, maxMs);
}

export interface RetryOptions<T> extends BackoffOptions {
  /** 最大リトライ回数（初回呼び出しは含まない）。既定 5 */
  maxRetries?: number;
  /** 指定しない場合は全ての例外をリトライ対象にする */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  /** テスト用に差し替え可能な sleep */
  sleep?: (ms: number) => Promise<void>;
  /** 成功判定の値チェック（戻り値がリトライ対象かを判定したいときに使う） */
  shouldRetryValue?: (value: T) => boolean;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 失敗時に指数バックオフで再実行する汎用リトライラッパ。
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions<T> = {}
): Promise<T> {
  const maxRetries = options.maxRetries ?? 5;
  const shouldRetry = options.shouldRetry ?? (() => true);
  const shouldRetryValue = options.shouldRetryValue;
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const value = await fn();
      if (shouldRetryValue && shouldRetryValue(value) && attempt < maxRetries) {
        await sleep(exponentialBackoff(attempt, options));
        continue;
      }
      return value;
    } catch (err) {
      lastError = err;
      if (attempt >= maxRetries || !shouldRetry(err, attempt)) {
        throw err;
      }
      await sleep(exponentialBackoff(attempt, options));
    }
  }
  /* istanbul ignore next -- ループは return か throw で抜けるので到達しない */
  throw lastError;
}
