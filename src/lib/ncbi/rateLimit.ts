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

/**
 * トークンを 1 つ消費できるまで待機してから消費するレートリミッタの最小インタフェース。
 * `TokenBucket` の実装差し替え（テスト用のスタブ等）に使う。
 */
export interface RateLimiter {
  /** トークンが 1 つ空くまで待ってから消費する */
  acquire(): Promise<void>;
}

export interface TokenBucketOptions {
  /** 1 秒あたりに補充されるトークン数（= 守りたいレート req/s） */
  ratePerSecond: number;
  /** バケット容量（バーストで即座に消費できる上限）。既定は `ratePerSecond` と同じ */
  capacity?: number;
  /** 時刻取得。テスト用に差し替え可（既定 `Date.now`） */
  now?: () => number;
  /** 待機。テスト用に差し替え可（既定 `setTimeout` ベース。`retryWithBackoff` と同じ流儀） */
  sleep?: (ms: number) => Promise<void>;
}

/** 浮動小数点の丸め誤差を吸収するための許容誤差 */
const TOKEN_EPSILON = 1e-9;

/**
 * クライアント側トークンバケット（issue #59）。
 *
 * `acquire()` はトークンを 1 つ消費できるまで待ってから消費する。NCBI E-utilities の
 * 「API キー無し 3 req/s、あり 10 req/s」という枠を、事前スロットリングで守るために使う
 * （`retryWithBackoff` は失敗後の後始末であり、こちらは発行前の予防）。
 *
 * `acquire()` が同時に複数呼ばれても（`Promise.all` 一括発行など）内部キューで FIFO に
 * 直列化して処理するため、トークン残量チェックと消費の間に他の呼び出しが割り込んで
 * レート上限を超えて許可してしまうことはない。
 */
export class TokenBucket implements RateLimiter {
  private readonly ratePerSecond: number;
  private readonly capacity: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private tokens: number;
  private lastRefillMs: number;
  /** `acquire()` 呼び出しを順番に処理するためのキュー（直列化） */
  private queue: Promise<void> = Promise.resolve();

  constructor(options: TokenBucketOptions) {
    this.ratePerSecond = options.ratePerSecond;
    this.capacity = options.capacity ?? options.ratePerSecond;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.tokens = this.capacity;
    this.lastRefillMs = this.now();
  }

  acquire(): Promise<void> {
    // 前の acquire() の完了（成功・失敗いずれも）を待ってから自分の番を実行する。
    // 呼び出し順を保証しつつ、途中の呼び出しが例外を投げてもキュー自体は途切れさせない。
    const turn = this.queue.then(() => this.take());
    this.queue = turn.then(
      () => undefined,
      () => undefined
    );
    return turn;
  }

  /** テスト専用: バケットを満タン（capacity）に戻す。本番コードから呼ぶ想定はない */
  reset(): void {
    this.tokens = this.capacity;
    this.lastRefillMs = this.now();
    this.queue = Promise.resolve();
  }

  private async take(): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= 1 - TOKEN_EPSILON) {
        this.tokens = Math.max(0, this.tokens - 1);
        return;
      }
      const deficit = 1 - this.tokens;
      const waitMs = (deficit / this.ratePerSecond) * 1000;
      await this.sleep(Math.max(waitMs, 0));
    }
  }

  private refill(): void {
    const now = this.now();
    const elapsedSeconds = Math.max(0, (now - this.lastRefillMs) / 1000);
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.ratePerSecond);
    this.lastRefillMs = now;
  }
}
