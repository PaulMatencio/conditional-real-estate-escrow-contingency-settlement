import type { HealthCheckId, HealthDetail, HealthStatus } from '@/domain/health';

/** Persistence port so keys, addresses and transactions survive reloads ("must be persistent"). */
export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  keys(prefix: string): Promise<string[]>;
}

// ---- infrastructure health ---------------------------------------------------------------------------------------

/** What one probe found (the use case adds latency, the slow verdict and timeouts). */
export interface ProbeOutcome {
  status: HealthStatus;
  detail?: HealthDetail;
  /** The endpoint actually checked, when only known at run time (e.g. the wallet's own indexer). */
  target?: string;
}

/** One infrastructure element the dApp depends on. `run` must honour `signal` (aborted on timeout). */
export interface HealthProbe {
  readonly id: HealthCheckId;
  readonly target: string;
  /** False for elements the app never calls directly (shown for information only). */
  readonly critical: boolean;
  run(signal: AbortSignal): Promise<ProbeOutcome>;
}

/** Live availability of the configured indexer, as seen by the app's own queries. */
export interface IndexerAvailability {
  /** `down` while the app is skipping the configured indexer after a failure. */
  status: 'ok' | 'down';
  /** When the configured indexer will be tried again (ms since epoch). */
  retryAt?: number;
  /** The last failure, for the banner / health modal. */
  lastError?: string;
}

export interface IndexerAvailabilityPort {
  get(): IndexerAvailability;
  subscribe(listener: (a: IndexerAvailability) => void): () => void;
}
