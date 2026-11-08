import { describe, expect, it } from 'vitest';
import { buildReport, capFromNight, describeDust, dustLevel, dustPercent, formatDust, formatNight, readDust } from '@/infrastructure/wallet/dust';

const SPECK = 10n ** 15n;
const STAR = 10n ** 6n;

describe('DUST / NIGHT report in whole units', () => {
  it('formats base units (DUST 15 decimals, NIGHT 6 decimals)', () => {
    expect(formatDust(25_000n * SPECK)).toBe('25 000.0 DUST');
    expect(formatDust(8_031_583_600_000_000_000n)).toBe('8 031.5836 DUST');
    expect(formatNight(5_000n * STAR)).toBe('5 000.0 NIGHT');
  });

  it('derives the maximum from NIGHT (5 DUST per NIGHT), ignoring 1AM’s odd cap', () => {
    // Real 1AM values: balance 25 000 DUST in SPECK, "cap" = 5 000 NIGHT in STAR.
    const r = buildReport(25_000n * SPECK, 5_000n * STAR, 5_000n * STAR);
    expect(capFromNight(5_000n * STAR)).toBe(25_000n * SPECK);
    expect(r.cap).toBe(25_000n * SPECK);
    expect(dustPercent(r)).toBe(100);
    expect(dustLevel(r)).toBe('ok');
    expect(describeDust(r)).toBe('wallet reports 25 000.0 DUST spendable, 5 000.0 NIGHT → max 25 000.0 DUST, 100 % of max');
  });

  it('falls back to a consistent wallet cap, or none', () => {
    expect(buildReport(5n, 10n, null).cap).toBe(10n);
    expect(dustPercent(buildReport(25_000n * SPECK, 5_000n * STAR, null))).toBeNull();
    expect(dustLevel(buildReport(0n, 0n, 0n))).toBe('empty');
    expect(dustLevel(buildReport(1n * SPECK, 0n, 5_000n * STAR))).toBe('low');
  });

  it('reads DUST and native NIGHT from the wallet and never throws', async () => {
    const api = {
      getDustBalance: async () => ({ balance: 25_000n * SPECK, cap: 5_000n * STAR }),
      getUnshieldedBalances: async () => ({ ['0'.repeat(64)]: 5_000n * STAR, ['ab'.repeat(32)]: 7n })
    };
    const r = await readDust(api as never);
    expect(r).toMatchObject({ night: 5_000n * STAR, cap: 25_000n * SPECK });
    expect(await readDust({ getDustBalance: async () => Promise.reject(new Error('locked')) } as never)).toBeNull();
    expect(describeDust(null)).toMatch(/did not report/);
  });
});
