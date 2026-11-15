import { describe, expect, it } from 'vitest';
import { CheckInfrastructure, SLOW_MS } from '@/application/checkInfrastructure';
import type { HealthProbe, ProbeOutcome } from '@/application/ports';
import { overallStatus, type HealthCheckResult } from '@/domain/health';

const r = (status: HealthCheckResult['status'], critical = true): HealthCheckResult => ({ id: 'indexer-http', status, target: 't', critical });

describe('overallStatus', () => {
  it('is the worst critical status; skipped checks never count', () => {
    expect(overallStatus([r('ok'), r('skipped'), r('degraded')])).toBe('degraded');
    expect(overallStatus([r('ok'), r('down')])).toBe('down');
    expect(overallStatus([r('ok'), r('skipped')])).toBe('ok');
    expect(overallStatus([r('skipped')])).toBe('skipped');
    expect(overallStatus([])).toBe('skipped');
  });

  it('an informational element that is down only degrades the verdict', () => {
    expect(overallStatus([r('ok'), r('down', false)])).toBe('degraded');
  });
});

const probe = (id: HealthProbe['id'], run: HealthProbe['run'], critical = true): HealthProbe => ({ id, target: `https://${id}`, critical, run });
const after = (ms: number, out: ProbeOutcome) => () => new Promise<ProbeOutcome>((res) => setTimeout(() => res(out), ms));

describe('CheckInfrastructure', () => {
  it('runs probes in parallel, keeps their order, and summarizes', async () => {
    const started: string[] = [];
    const p = (id: HealthProbe['id'], ms: number, out: ProbeOutcome) => probe(id, () => (started.push(id), after(ms, out)()));
    const t0 = Date.now();
    const report = await new CheckInfrastructure([p('indexer-http', 120, { status: 'ok' }), p('proof-server', 120, { status: 'down', detail: { code: 'no-response' } })]).execute();
    expect(Date.now() - t0).toBeLessThan(220); // parallel, not 240 ms
    expect(started).toEqual(['indexer-http', 'proof-server']);
    expect(report.results.map((x) => [x.id, x.status])).toEqual([['indexer-http', 'ok'], ['proof-server', 'down']]);
    expect(report.overall).toBe('down');
    expect(report.results[0].latencyMs).toBeGreaterThanOrEqual(100);
  });

  it('a probe that does not answer in time is down (timeout) and is aborted', async () => {
    let aborted = false;
    const hang = probe('indexer-ws', (signal) => new Promise(() => signal.addEventListener('abort', () => (aborted = true))));
    const [res] = (await new CheckInfrastructure([hang], 50).execute()).results;
    expect(res).toMatchObject({ status: 'down', detail: { code: 'timeout', info: '0 s' } });
    expect(aborted).toBe(true);
  });

  it('a probe that throws is down with its message', async () => {
    const [res] = (await new CheckInfrastructure([probe('wallet', async () => { throw new Error('getConfiguration failed'); })]).execute()).results;
    expect(res).toMatchObject({ status: 'down', detail: { code: 'error', info: 'getConfiguration failed' } });
  });

  it('a slow OK answer is degraded; a skipped probe keeps no latency verdict; a probe can name its real target', async () => {
    let t = 0;
    const clock = () => t;
    const slow = probe('indexer-http', async () => { t += SLOW_MS + 1; return { status: 'ok' }; });
    const skipped = probe('wallet', async () => ({ status: 'skipped', detail: { code: 'no-wallet' } }));
    const retarget = probe('wallet-indexer', async () => ({ status: 'ok', target: 'https://wallet.example/graphql' }));
    const res = (await new CheckInfrastructure([slow, skipped, retarget], 8000, clock).execute()).results;
    expect(res[0]).toMatchObject({ status: 'degraded', detail: { code: 'slow' } });
    expect(res[1]).toMatchObject({ status: 'skipped', detail: { code: 'no-wallet' } });
    expect(res[1].latencyMs).toBeUndefined();
    expect(res[2].target).toBe('https://wallet.example/graphql');
  });
});
