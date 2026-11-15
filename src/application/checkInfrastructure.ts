import { overallStatus, type HealthCheckResult, type HealthStatus } from '@/domain/health';
import type { HealthProbe } from './ports';

export interface InfrastructureReport {
  checkedAt: number;
  overall: HealthStatus;
  results: HealthCheckResult[];
}

class ProbeTimeout extends Error {}

/** A probe that answers OK but slower than this is reported as degraded. */
export const SLOW_MS = 3000;

/**
 * Query: checks every infrastructure element in parallel. Each probe gets `timeoutMs` (then it is "down: no answer
 * within …"); a probe that throws is "down" with its message. Results keep the probes' order.
 */
export class CheckInfrastructure {
  constructor(
    private readonly probes: readonly HealthProbe[],
    private readonly timeoutMs = 8000,
    private readonly now: () => number = Date.now
  ) {}

  async execute(): Promise<InfrastructureReport> {
    const results = await Promise.all(this.probes.map((p) => this.run(p)));
    return { checkedAt: this.now(), overall: overallStatus(results), results };
  }

  private async run(p: HealthProbe): Promise<HealthCheckResult> {
    const base = { id: p.id, target: p.target, critical: p.critical };
    const ctrl = new AbortController();
    const started = this.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ctrl.abort();
        reject(new ProbeTimeout());
      }, this.timeoutMs);
    });
    try {
      const out = await Promise.race([p.run(ctrl.signal), timeout]);
      const latencyMs = this.now() - started;
      if (out.status === 'skipped') return { ...base, ...out, target: out.target ?? p.target };
      const slow = out.status === 'ok' && latencyMs > SLOW_MS;
      return { ...base, target: out.target ?? p.target, status: slow ? 'degraded' : out.status, detail: slow ? { code: 'slow', info: `${latencyMs} ms` } : out.detail, latencyMs };
    } catch (e) {
      const detail = e instanceof ProbeTimeout ? { code: 'timeout' as const, info: `${Math.round(this.timeoutMs / 1000)} s` } : { code: 'error' as const, info: e instanceof Error ? e.message : String(e) };
      return { ...base, status: 'down', detail, latencyMs: this.now() - started };
    } finally {
      clearTimeout(timer);
    }
  }
}
