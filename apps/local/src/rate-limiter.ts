type RateLimitWindow = {
  startedAt: number;
  attempts: number;
};

export class FixedWindowRateLimiter {
  readonly #maximumAttempts: number;
  readonly #windowMilliseconds: number;
  readonly #windows = new Map<string, RateLimitWindow>();

  constructor(maximumAttempts: number, windowMilliseconds: number) {
    this.#maximumAttempts = maximumAttempts;
    this.#windowMilliseconds = windowMilliseconds;
  }

  consume(key: string, now = Date.now()): number | null {
    const existing = this.#windows.get(key);
    if (!existing || now - existing.startedAt >= this.#windowMilliseconds) {
      this.#windows.set(key, { startedAt: now, attempts: 1 });
      return null;
    }
    if (existing.attempts >= this.#maximumAttempts) {
      return Math.max(
        1,
        Math.ceil(
          (existing.startedAt + this.#windowMilliseconds - now) / 1_000,
        ),
      );
    }
    existing.attempts += 1;
    return null;
  }
}
