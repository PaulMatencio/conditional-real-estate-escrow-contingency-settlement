import type { ConnectedAPI } from '@midnightntwrk/dapp-connector-api';

/**
 * DUST (fee resource) and NIGHT as the connected wallet reports them, in base units:
 *  - DUST has 15 decimals (1 DUST = 10^15 SPECK);
 *  - NIGHT has 6 decimals (1 NIGHT = 10^6 STAR);
 *  - the DUST a wallet can hold is capped at DUST_PER_NIGHT × NIGHT (5 DUST per NIGHT).
 * `getDustBalance().cap` is not always in DUST base units (1AM reports the NIGHT balance in STAR there), so the cap
 * shown is derived from the NIGHT balance whenever it is known, and the wallet's raw value is kept for reference.
 */
export const DUST_DECIMALS = 15;
export const NIGHT_DECIMALS = 6;
export const DUST_PER_NIGHT = 5n;

export interface DustReport {
  /** Spendable DUST, base units (SPECK). */
  balance: bigint;
  /** `cap` exactly as the wallet returned it (unit not guaranteed). */
  walletCap: bigint;
  /** Unshielded NIGHT balance, base units (STAR), when the wallet reports it. */
  night: bigint | null;
  /** Maximum DUST in SPECK: NIGHT × 5 when NIGHT is known, else the wallet's cap if it is consistent, else null. */
  cap: bigint | null;
  at: number;
}

const pow10 = (n: number) => 10n ** BigInt(n);

/** Maximum DUST (SPECK) the given NIGHT (STAR) can generate. */
export const capFromNight = (nightStar: bigint): bigint => (nightStar * DUST_PER_NIGHT * pow10(DUST_DECIMALS)) / pow10(NIGHT_DECIMALS);

const isNativeNight = (tokenType: string) => /^(?:[a-z_-]+:)?(?:0x)?0{64}$/i.test(tokenType.trim());

export function buildReport(balance: bigint, walletCap: bigint, night: bigint | null, at = Date.now()): DustReport {
  const cap = night !== null ? capFromNight(night) : walletCap >= balance && walletCap > 0n ? walletCap : null;
  return { balance, walletCap, night, cap, at };
}

/** Reads the connected wallet's DUST and NIGHT, or null when the wallet does not answer (never throws). */
export async function readDust(api: ConnectedAPI, timeoutMs = 8000): Promise<DustReport | null> {
  const withTimeout = <T,>(p: Promise<T>) => Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs))]);
  try {
    const d = await withTimeout(api.getDustBalance());
    let night: bigint | null = null;
    try {
      const unshielded = await withTimeout(api.getUnshieldedBalances());
      const entry = Object.entries(unshielded).find(([k]) => isNativeNight(k));
      night = entry ? BigInt(entry[1]) : 0n;
    } catch {
      night = null;
    }
    return buildReport(BigInt(d.balance), BigInt(d.cap), night);
  } catch {
    return null;
  }
}

/** Base units → whole units with up to `shown` decimals, thousands separated (e.g. 25 000.0). */
export function formatToken(value: bigint, decimals: number, shown = 4): string {
  const neg = value < 0n;
  const v = neg ? -value : value;
  const whole = (v / pow10(decimals)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  let frac = (v % pow10(decimals)).toString().padStart(decimals, '0').slice(0, shown).replace(/0+$/, '');
  if (!frac) frac = '0';
  return `${neg ? '-' : ''}${whole}.${frac}`;
}
export const formatDust = (v: bigint) => `${formatToken(v, DUST_DECIMALS)} DUST`;
export const formatNight = (v: bigint) => `${formatToken(v, NIGHT_DECIMALS)} NIGHT`;

/** Integer percentage of the maximum DUST currently spendable, or null when the maximum is unknown. */
export const dustPercent = (d: DustReport): number | null => (d.cap && d.cap > 0n ? Number((d.balance * 100n) / d.cap) : null);

export type DustLevel = 'empty' | 'low' | 'ok';
/** empty: nothing spendable; low: under 5 % of the maximum (still generating, or the wallet is not fully synced). */
export const dustLevel = (d: DustReport): DustLevel => {
  if (d.balance === 0n) return 'empty';
  const p = dustPercent(d);
  return p !== null && p < 5 ? 'low' : 'ok';
};

export const describeDust = (d: DustReport | null): string => {
  if (!d) return 'wallet did not report its DUST balance';
  const p = dustPercent(d);
  const parts = [`wallet reports ${formatDust(d.balance)} spendable`];
  if (d.night !== null) parts.push(`${formatNight(d.night)} → max ${formatDust(capFromNight(d.night))}`);
  else if (d.cap !== null) parts.push(`max ${formatDust(d.cap)}`);
  if (p !== null) parts.push(`${p} % of max`);
  return parts.join(', ');
};
