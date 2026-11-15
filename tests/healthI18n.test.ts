import { describe, expect, it } from 'vitest';
import type { HealthCheckId, HealthDetailCode, HealthStatus } from '@/domain/health';
import { en } from '@/presentation/i18n/en';
import { es } from '@/presentation/i18n/es';
import { fr } from '@/presentation/i18n/fr';

// Every value the Health window can show must have a message in every locale (the keys are built at run time).
const IDS: HealthCheckId[] = ['indexer-http', 'indexer-ws', 'wallet', 'wallet-indexer', 'proof-server', 'zk-artifacts', 'casp', 'node-rpc'];
const DETAILS: HealthDetailCode[] = ['http-error', 'unreadable', 'opaque-ok', 'no-response', 'not-graphql', 'ws-unavailable', 'ws-no-connect', 'ws-no-handshake', 'ws-error', 'ws-closed', 'no-wallet', 'wallet-disconnected', 'wallet-network', 'not-compiled', 'no-keys', 'casp-disabled', 'timeout', 'slow', 'error'];
const STATUSES: HealthStatus[] = ['ok', 'degraded', 'down', 'skipped'];

const keys = [
  ...['button', 'title', 'checking', 'recheck', 'checkedAt', 'informational', 'indexerDown'].map((k) => `health.${k}`),
  ...STATUSES.flatMap((s) => [`health.status.${s}`, `health.overall.${s}`]),
  ...IDS.flatMap((id) => [`health.id.${id}`, `health.hint.${id}`]),
  ...DETAILS.map((d) => `health.detail.${d}`)
];

describe('Health window messages', () => {
  it.each([
    ['en', en],
    ['fr', fr],
    ['es', es]
  ])('%s has every key', (_, dict) => {
    const missing = keys.filter((k) => !(dict as Record<string, string | undefined>)[k]);
    expect(missing).toEqual([]);
  });
});
