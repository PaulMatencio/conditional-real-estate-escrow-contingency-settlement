/**
 * A contract maintenance-authority key as the vault stores it: bare 64 hex. Accepts the ledger 9 tagged object
 * (`{ tag: 'schnorr', value }`), a JSON encoding of it, or a hex string (optionally 0x-prefixed).
 */
const HEX64 = /^[0-9a-f]{64}$/;

/** The key's 64-hex value from either shape (also a JSON-encoded tagged object), or null if it is not a key. */
export function signingKeyHex(k: unknown): string | null {
  if (typeof k === 'string') {
    const s = k.trim();
    if (s.startsWith('{')) {
      try {
        return signingKeyHex(JSON.parse(s));
      } catch {
        return null;
      }
    }
    const h = s.replace(/^0x/, '').toLowerCase();
    return HEX64.test(h) ? h : null;
  }
  if (k && typeof k === 'object' && typeof (k as { value?: unknown }).value === 'string') {
    const tag = (k as { tag?: unknown }).tag;
    if (tag !== undefined && tag !== 'schnorr') return null;
    return signingKeyHex((k as { value: string }).value);
  }
  return null;
}
