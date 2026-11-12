/**
 * Contract maintenance-authority keys come in two shapes:
 * - ledger 9 / compact-runtime 0.21 (midnight-js 5): a tagged object `{ tag: 'schnorr', value: '<64 hex>' }`, which
 *   is what `sampleSigningKey`, `signData` and `signatureVerifyingKey` use;
 * - earlier versions and anything a person types or backs up: the bare 64-hex string.
 * The vault always stores the bare hex (readable, portable, comparable). Code that signs converts it back.
 */
import { signingKeyHex } from '@/domain/signingKey';

export interface TaggedSigningKey {
  tag: 'schnorr';
  value: string;
}

export { signingKeyHex };

/** The ledger 9 signing-key object for either shape; throws on anything else (never echoes the secret). */
export function toSigningKey(k: unknown): TaggedSigningKey {
  const h = signingKeyHex(k);
  if (!h) throw new Error('Not a contract authority key (expected 64 hex characters).');
  return { tag: 'schnorr', value: h };
}

/** Comparable id of a verifying key (committee member): its hex value for the tagged shape, else the string itself. */
export function verifyingKeyId(vk: unknown): string {
  if (vk && typeof vk === 'object' && typeof (vk as { value?: unknown }).value === 'string') return `${(vk as { tag?: string }).tag ?? ''}:${(vk as { value: string }).value.toLowerCase()}`;
  return `:${String(vk).toLowerCase().replace(/^0x/, '')}`;
}
