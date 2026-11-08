import { bytesToHex, hex32ToBytes } from '@/domain/hex';
import { pureCircuits } from '../contract/module';

/** Cryptographically random bytes (browser or Node 22). */
export const randomBytes = (n: number): Uint8Array => globalThis.crypto.getRandomValues(new Uint8Array(n));

export const generateSecretKey = (): Uint8Array => randomBytes(32);

/** The on-chain role id of a secret key — the contract's own `roleIdOf`, so the two can never drift apart. */
export function roleIdHex(secretKey: Uint8Array): string {
  return bytesToHex(pureCircuits.roleIdOf(secretKey));
}

export const secretKeyFromHex = (hex: string): Uint8Array => hex32ToBytes(hex, 'secret key');
