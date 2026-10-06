export interface RateLimiterOptions {
  rpm?: number;
  tpm?: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

class Bucket {
  private level: number;
  private last: number;
  constructor(
    readonly capacity: number,
    now: number,
  ) {
    this.level = capacity;
    this.last = now;
  }
  private refill(now: number): void {
    this.level = Math.min(this.capacity, this.level + ((now - this.last) * this.capacity) / 60_000);
    this.last = now;
  }
  waitMs(amount: number, now: number): number {
    this.refill(now);
    const need = Math.min(amount, this.capacity);
    return this.level >= need ? 0 : Math.ceil(((need - this.level) * 60_000) / this.capacity);
  }
  take(amount: number): void {
    this.level -= Math.min(amount, this.capacity);
  }
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class RateLimiter {
  private readonly requests?: Bucket;
  private readonly tokens?: Bucket;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private queue: Promise<void> = Promise.resolve();

  constructor(opts: RateLimiterOptions) {
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? abortableSleep;
    const t = this.now();
    if (opts.rpm && opts.rpm > 0) this.requests = new Bucket(opts.rpm, t);
    if (opts.tpm && opts.tpm > 0) this.tokens = new Bucket(opts.tpm, t);
  }

  acquire(tokens: number, signal?: AbortSignal): Promise<void> {
    if (!this.requests && !this.tokens) return Promise.resolve();
    const run = this.queue.then(() => this.waitAndTake(tokens, signal));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async waitAndTake(tokens: number, signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (signal?.aborted) throw signal.reason;
      const t = this.now();
      const wait = Math.max(this.requests?.waitMs(1, t) ?? 0, this.tokens?.waitMs(tokens, t) ?? 0);
      if (wait <= 0) break;
      await this.sleep(wait, signal);
    }
    this.requests?.take(1);
    this.tokens?.take(tokens);
  }
}
