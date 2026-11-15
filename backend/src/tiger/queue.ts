// Small pure helpers so the database can never slow the replay down: a bounded queue (drops the
// oldest when full and counts the drops), a circuit breaker, and a log-each-error-once helper.

export class BoundedQueue<T> {
  private items: T[] = [];
  private _dropped = 0;
  constructor(readonly max: number) {}

  get size() { return this.items.length; }
  /** Rows thrown away because the queue was full. */
  get dropped() { return this._dropped; }

  push(item: T): void {
    this.items.push(item);
    this.trim();
  }

  /** Removes and returns up to n of the oldest items. */
  take(n: number): T[] {
    return this.items.splice(0, n);
  }

  /** Puts items back at the front (a failed write). If that overflows, the oldest are dropped. */
  requeue(items: T[]): void {
    this.items.unshift(...items);
    this.trim();
  }

  private trim() {
    const over = this.items.length - this.max;
    if (over > 0) {
      this.items.splice(0, over);
      this._dropped += over;
    }
  }
}

/** After `threshold` failures in a row, refuse to try again until `cooldownMs` has passed. */
export class CircuitBreaker {
  private failures = 0;
  private openUntil = 0;
  constructor(private readonly threshold = 3, private readonly cooldownMs = 30_000) {}

  canTry(now: number): boolean {
    return now >= this.openUntil;
  }
  get isOpen() { return this.failures >= this.threshold; }

  success(): void {
    this.failures = 0;
    this.openUntil = 0;
  }
  failure(now: number): void {
    this.failures++;
    if (this.failures >= this.threshold) this.openUntil = now + this.cooldownMs;
  }
}

/** Returns a logger that prints each distinct message only once. */
export function logOnce(log: (m: string) => void): (m: string) => void {
  const seen = new Set<string>();
  return (m) => {
    if (seen.has(m)) return;
    seen.add(m);
    log(m);
  };
}

/** A short error description with no host, address, URL or secret in it. */
export function safeError(e: unknown, secrets: readonly string[] = []): string {
  const err = e as { code?: string; message?: string; name?: string };
  let msg = String(err?.message ?? e ?? "error");
  for (const s of secrets) if (s) msg = msg.split(s).join("<redacted>");
  msg = msg
    .replace(/\S*:\/\/\S*/g, "<url>")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, "<ip>")
    .replace(/\b[\w-]+(?:\.[\w-]+)+(?::\d+)?\b/g, "<host>")
    .slice(0, 160);
  return `${err?.code ?? err?.name ?? "Error"}: ${msg}`;
}
