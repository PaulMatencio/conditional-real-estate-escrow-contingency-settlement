/**
 * Client-side encryption for the private terms vault and its distribution (FR-TERMS-04, NFR-06), WebCrypto only.
 *  - At rest: AES-256-GCM under a key derived from the user's passphrase (PBKDF2-SHA-256).
 *  - To a recipient: X25519 ECDH with an ephemeral key, HKDF-SHA-256, AES-256-GCM ("sealed box").
 * Nothing here talks to a server.
 */
const enc = new TextEncoder();
const dec = new TextDecoder();
/**
 * Browsers expose WebCrypto (crypto.subtle) only in a secure context: https, http://localhost, http://127.0.0.1 and
 * http://*.localhost. A LAN address such as http://192.168.x.x:3000 is not one, so explain instead of crashing.
 */
export function insecureContextMessage(): string | null {
  if (globalThis.crypto?.subtle) return null;
  const where = typeof location !== 'undefined' ? location.origin : 'this address';
  return (
    `The vault needs the browser's Web Crypto API, which is only available on secure pages: ${where} is not one. ` +
    'Open the dApp at http://localhost:3000, http://127.0.0.1:3000 or a *.localhost name (e.g. http://buyer.localhost:3000; each name gets its own vault), or serve it over https.'
  );
}

const subtle = (): SubtleCrypto => {
  const msg = insecureContextMessage();
  if (msg) throw new Error(msg);
  return globalThis.crypto.subtle;
};
const rand = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n));

export const b64 = (b: Uint8Array): string => {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
};
export const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

const PBKDF2_ITERATIONS = 310_000;

export interface SealedJson {
  v: 1;
  alg: 'PBKDF2-AES-GCM';
  salt: string;
  iv: string;
  ct: string;
}

export async function passphraseKey(passphrase: string, salt: Uint8Array, iterations = PBKDF2_ITERATIONS): Promise<CryptoKey> {
  const base = await subtle().importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** Browsers reject `additionalData: undefined`; only pass the field when there is AAD. */
const gcm = (iv: Uint8Array, aad?: Uint8Array): AesGcmParams => (aad ? { name: 'AES-GCM', iv: iv as BufferSource, additionalData: aad as BufferSource } : { name: 'AES-GCM', iv: iv as BufferSource });

export async function aesEncrypt(key: CryptoKey, plaintext: Uint8Array, aad?: Uint8Array): Promise<{ iv: Uint8Array; ct: Uint8Array }> {
  const iv = rand(12);
  const ct = new Uint8Array(await subtle().encrypt(gcm(iv, aad), key, plaintext as BufferSource));
  return { iv, ct };
}

export async function aesDecrypt(key: CryptoKey, iv: Uint8Array, ct: Uint8Array, aad?: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle().decrypt(gcm(iv, aad), key, ct as BufferSource));
}

const json = (v: unknown) => enc.encode(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));

/** Passphrase-sealed JSON (exportable backup file). */
export async function sealWithPassphrase(value: unknown, passphrase: string): Promise<SealedJson> {
  const salt = rand(16);
  const { iv, ct } = await aesEncrypt(await passphraseKey(passphrase, salt), json(value));
  return { v: 1, alg: 'PBKDF2-AES-GCM', salt: b64(salt), iv: b64(iv), ct: b64(ct) };
}

export async function openWithPassphrase<T>(sealed: SealedJson, passphrase: string): Promise<T> {
  const key = await passphraseKey(passphrase, unb64(sealed.salt));
  try {
    return JSON.parse(dec.decode(await aesDecrypt(key, unb64(sealed.iv), unb64(sealed.ct)))) as T;
  } catch {
    throw new Error('Wrong passphrase or corrupted file.');
  }
}

// ---------------------------------------------------------------- X25519 recipient envelopes

export interface RecipientKeyPair {
  publicKey: string; // raw 32 bytes, base64
  privateKeyJwk: JsonWebKey;
}

export interface Envelope {
  v: 1;
  alg: 'X25519-HKDF-AES-GCM';
  /** Label only (e.g. "seller"); not authenticated identity. */
  to?: string;
  recipient: string;
  ephemeral: string;
  iv: string;
  ct: string;
}

export async function generateRecipientKeyPair(): Promise<RecipientKeyPair> {
  const kp = (await subtle().generateKey({ name: 'X25519' }, true, ['deriveBits'])) as CryptoKeyPair;
  const raw = new Uint8Array(await subtle().exportKey('raw', kp.publicKey));
  return { publicKey: b64(raw), privateKeyJwk: await subtle().exportKey('jwk', kp.privateKey) };
}

async function sharedKey(priv: CryptoKey, pubRaw: Uint8Array, info: Uint8Array): Promise<CryptoKey> {
  const pub = await subtle().importKey('raw', pubRaw as BufferSource, { name: 'X25519' }, false, []);
  const bits = new Uint8Array(await subtle().deriveBits({ name: 'X25519', public: pub }, priv, 256));
  const hk = await subtle().importKey('raw', bits as BufferSource, 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32) as BufferSource, info: info as BufferSource }, hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

const INFO = enc.encode('re-escrow:terms-envelope:v1');

/** Encrypts `value` so only the holder of `recipientPublicKey` (base64 raw X25519) can open it. */
export async function sealTo(value: unknown, recipientPublicKey: string, to?: string): Promise<Envelope> {
  const eph = (await subtle().generateKey({ name: 'X25519' }, true, ['deriveBits'])) as CryptoKeyPair;
  const ephRaw = new Uint8Array(await subtle().exportKey('raw', eph.publicKey));
  const recipient = unb64(recipientPublicKey);
  const key = await sharedKey(eph.privateKey, recipient, INFO);
  const aad = new Uint8Array([...ephRaw, ...recipient]);
  const { iv, ct } = await aesEncrypt(key, json(value), aad);
  return { v: 1, alg: 'X25519-HKDF-AES-GCM', to, recipient: recipientPublicKey, ephemeral: b64(ephRaw), iv: b64(iv), ct: b64(ct) };
}

export async function openEnvelope<T>(e: Envelope, me: RecipientKeyPair): Promise<T> {
  if (e.recipient !== me.publicKey) throw new Error('This envelope is addressed to another key.');
  const priv = await subtle().importKey('jwk', me.privateKeyJwk, { name: 'X25519' }, false, ['deriveBits']);
  const ephRaw = unb64(e.ephemeral);
  const key = await sharedKey(priv, ephRaw, INFO);
  const aad = new Uint8Array([...ephRaw, ...unb64(e.recipient)]);
  try {
    return JSON.parse(dec.decode(await aesDecrypt(key, unb64(e.iv), unb64(e.ct), aad))) as T;
  } catch {
    throw new Error('Envelope could not be opened (wrong key or tampered).');
  }
}

export const isEnvelope = (x: unknown): x is Envelope => !!x && (x as Envelope).alg === 'X25519-HKDF-AES-GCM';
export const isSealedJson = (x: unknown): x is SealedJson => !!x && (x as SealedJson).alg === 'PBKDF2-AES-GCM';
