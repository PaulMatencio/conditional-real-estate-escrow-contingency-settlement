/**
 * Infrastructure health: what one check found, and the overall verdict. Pure.
 *  - ok:        works as the app needs it
 *  - degraded:  answers, but not usably (error page, CORS, missing proving keys, no handshake…) or slow
 *  - down:      no answer at all
 *  - skipped:   not applicable right now (e.g. wallet checks with no wallet connected, CASP proxy off in production)
 */
export type HealthStatus = 'ok' | 'degraded' | 'down' | 'skipped';

/** Stable ids, so the UI can translate names and order rows. */
export type HealthCheckId =
  | 'indexer-http'
  | 'indexer-ws'
  | 'wallet'
  | 'wallet-indexer'
  | 'proof-server'
  | 'zk-artifacts'
  | 'casp'
  | 'node-rpc';

/**
 * Why a check is not plainly "ok". A code (translated by the UI) plus optional technical info that is shown as is
 * ("HTTP 503", "preprod", an error message).
 */
export type HealthDetailCode =
  | 'http-error'
  | 'unreadable'
  | 'opaque-ok'
  | 'no-response'
  | 'not-graphql'
  | 'ws-unavailable'
  | 'ws-no-connect'
  | 'ws-no-handshake'
  | 'ws-error'
  | 'ws-closed'
  | 'no-wallet'
  | 'wallet-disconnected'
  | 'wallet-network'
  | 'not-compiled'
  | 'no-keys'
  | 'casp-disabled'
  | 'timeout'
  | 'slow'
  | 'error';

export interface HealthDetail {
  code: HealthDetailCode;
  info?: string;
}

export interface HealthCheckResult {
  id: HealthCheckId;
  status: HealthStatus;
  /** Endpoint that was checked (URL or a short description). */
  target: string;
  /** False for elements the app does not depend on directly (shown for information only). */
  critical: boolean;
  latencyMs?: number;
  /** Why the status is not plainly ok. */
  detail?: HealthDetail;
}

const RANK: Record<HealthStatus, number> = { skipped: 0, ok: 1, degraded: 2, down: 3 };

/**
 * Overall verdict: the worst status among CRITICAL checks; informational checks can at most make it "degraded".
 * Skipped checks never count. No applicable check at all → "skipped".
 */
export function overallStatus(results: readonly HealthCheckResult[]): HealthStatus {
  let worst: HealthStatus = 'skipped';
  for (const r of results) {
    if (r.status === 'skipped') continue;
    const s: HealthStatus = !r.critical && r.status === 'down' ? 'degraded' : r.status;
    if (RANK[s] > RANK[worst]) worst = s;
  }
  return worst;
}
