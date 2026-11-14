/**
 * Token amounts. The contract, the terms package and the wallet all count in the token's BASE UNIT (an integer);
 * people read and type whole tokens. With 6 decimals, 250 000 sEUR is 250 000 000 000 base units. Every conversion
 * here is exact (bigint and strings, never floating point).
 */

/** Decimals of the shielded EUR tokens used so far (sEUR, EURe). */
export const DEFAULT_DECIMALS = 6;
export const MAX_DECIMALS = 18;

export const isValidDecimals = (d: unknown): d is number => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= MAX_DECIMALS;
/** The decimals to use: the first valid one given, else the default. */
export const decimalsOf = (...candidates: unknown[]): number => (candidates.find(isValidDecimals) as number | undefined) ?? DEFAULT_DECIMALS;

const group = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/**
 * Base units → "250,000.00" (with the ticker when given). At least two decimals are shown, more only when the amount
 * has them (0.24625 stays exact), so a tiny test amount can never be mistaken for a large one.
 */
export function formatAmount(base: bigint | string | number | null | undefined, decimals: number = DEFAULT_DECIMALS, ticker?: string): string {
  if (base === null || base === undefined || base === '') return '—';
  let v: bigint;
  try {
    v = BigInt(base);
  } catch {
    return String(base);
  }
  const neg = v < 0n;
  if (neg) v = -v;
  const scale = 10n ** BigInt(decimals);
  const whole = v / scale;
  let frac = decimals > 0 ? (v % scale).toString().padStart(decimals, '0').replace(/0+$/, '') : '';
  if (decimals >= 2 && frac.length < 2) frac = frac.padEnd(2, '0');
  const text = `${neg ? '-' : ''}${group(whole.toString())}${frac ? `.${frac}` : ''}`;
  return ticker ? `${text} ${ticker}` : text;
}

/**
 * Whole tokens as people type them → base units: "250000", "250,000.50" (English), "250.000,50" (European),
 * "250 000,50", "0.25", "1,5". Null when it is not a non-negative number or has more decimals than the token.
 *  - both "." and ",": the LAST one is the decimal mark, the other groups thousands;
 *  - only ",": grouping when it appears several times or is followed by exactly three digits ("250,000"), else decimal;
 *  - only ".": decimal, unless it appears several times ("250.000.000" groups thousands).
 * Every grouped part after the first must be exactly three digits, so a typo is refused rather than misread.
 */
export function parseAmount(text: string, decimals: number = DEFAULT_DECIMALS): bigint | null {
  let s = text.trim().replace(/[\s  _']/g, '');
  if (!s) return null;
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  let dec: '.' | ',' | null;
  if (lastDot >= 0 && lastComma >= 0) dec = lastDot > lastComma ? '.' : ',';
  else if (lastComma >= 0) dec = s.split(',').length > 2 || /,\d{3}$/.test(s) ? null : ',';
  else if (lastDot >= 0) dec = s.split('.').length > 2 ? null : '.';
  else dec = null;
  const group = dec === ',' ? '.' : dec === '.' ? ',' : lastComma >= 0 ? ',' : '.';
  const cut = dec ? s.lastIndexOf(dec) : -1;
  const intPart = cut >= 0 ? s.slice(0, cut) : s;
  const fracPart = cut >= 0 ? s.slice(cut + 1) : null;
  const groups = intPart.split(group);
  if (groups.length > 1 && (!/^\d{1,3}$/.test(groups[0]) || groups.slice(1).some((g) => !/^\d{3}$/.test(g)))) return null;
  s = groups.join('') + (fracPart !== null ? `.${fracPart}` : '');
  const m = /^(\d+)(?:\.(\d*))?$/.exec(s);
  if (!m) return null;
  const frac = m[2] ?? '';
  if (frac.length > decimals) return null;
  return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
}

/** Whole tokens → base units (presets, tests). */
export const toBase = (wholeTokens: number | bigint | string, decimals: number = DEFAULT_DECIMALS): bigint => {
  const v = parseAmount(String(wholeTokens), decimals);
  if (v === null) throw new Error(`Not an amount: ${wholeTokens}`);
  return v;
};
