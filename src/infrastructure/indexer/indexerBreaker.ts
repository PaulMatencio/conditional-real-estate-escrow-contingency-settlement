import type { IndexerAvailability, IndexerAvailabilityPort } from '@/application/ports';

/** How long the configured indexer is skipped after a failure before it is tried again. */
export const INDEXER_COOLDOWN_MS = 60_000;

/**
 * Circuit breaker for the configured indexer. After a failure the app stops calling it for `cooldownMs` (queries go
 * straight to the wallet's indexer, so the console is not flooded and pages don't wait on a dead endpoint), then
 * tries it again; the first answer closes the breaker. Publishes its state for the UI banner.
 */
export class IndexerBreaker implements IndexerAvailabilityPort {
  private state: IndexerAvailability = { status: 'ok' };
  private listeners = new Set<(a: IndexerAvailability) => void>();

  constructor(
    private readonly cooldownMs = INDEXER_COOLDOWN_MS,
    private readonly now: () => number = Date.now
  ) {}

  get = (): IndexerAvailability => this.state;

  subscribe = (fn: (a: IndexerAvailability) => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  /** Closed, or open but the cooldown has elapsed (one retry is due). */
  shouldTry(): boolean {
    return this.state.status === 'ok' || this.now() >= (this.state.retryAt ?? 0);
  }

  /** The configured indexer answered (even "not found" is an answer). */
  succeeded(): void {
    if (this.state.status !== 'ok') this.set({ status: 'ok' });
  }

  failed(error: unknown): void {
    const lastError = error instanceof Error ? error.message : String(error);
    this.set({ status: 'down', retryAt: this.now() + this.cooldownMs, lastError });
  }

  private set(s: IndexerAvailability) {
    this.state = s;
    this.listeners.forEach((l) => l(s));
  }
}

let shared: IndexerBreaker | null = null;

/**
 * The one breaker of this page load: every wallet provider set (admin console and party pages each build their own)
 * and the UI banner share it, so a dead indexer is detected once and skipped everywhere.
 */
export const sharedIndexerBreaker = (): IndexerBreaker => (shared ??= new IndexerBreaker());
