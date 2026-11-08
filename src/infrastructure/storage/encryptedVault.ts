/**
 * Encrypted, client-side vault (FR-TERMS-04/06, NFR-06): one AES-GCM record per contract, stored in IndexedDB
 * (falls back to the given KeyValueStore). The key is derived from a passphrase and lives only in memory while
 * unlocked; the record ids (contract addresses) are public data and stay in clear.
 */
import type { KeyValueStore } from '@/application/ports';
import type { Vault, VaultRecord } from '@/application/partyPorts';
import { aesDecrypt, aesEncrypt, b64, passphraseKey, unb64 } from '../crypto/aead';
import { MemoryStore } from './kv';

const META = 'vault:meta';
const REC = (a: string) => `vault:rec:${a}`;
const CHECK = 're-escrow-vault-v1';

interface Meta {
  salt: string;
  check: { iv: string; ct: string };
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export class EncryptedVault implements Vault {
  private key: CryptoKey | null = null;
  constructor(private readonly store: KeyValueStore) {}

  get unlocked(): boolean {
    return this.key !== null;
  }

  async exists(): Promise<boolean> {
    return (await this.store.get(META)) !== null;
  }

  /** First unlock creates the vault with this passphrase; later unlocks verify it. */
  async unlock(passphrase: string): Promise<void> {
    if (passphrase.length < 8) throw new Error('Use a passphrase of at least 8 characters.');
    const raw = await this.store.get(META);
    if (!raw) {
      const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
      const key = await passphraseKey(passphrase, salt);
      const { iv, ct } = await aesEncrypt(key, enc.encode(CHECK));
      await this.store.set(META, JSON.stringify({ salt: b64(salt), check: { iv: b64(iv), ct: b64(ct) } } satisfies Meta));
      this.key = key;
      return;
    }
    const meta = JSON.parse(raw) as Meta;
    const key = await passphraseKey(passphrase, unb64(meta.salt));
    try {
      const pt = await aesDecrypt(key, unb64(meta.check.iv), unb64(meta.check.ct));
      if (dec.decode(pt) !== CHECK) throw new Error();
    } catch {
      throw new Error('Wrong vault passphrase.');
    }
    this.key = key;
  }

  lock(): void {
    this.key = null;
  }

  private need(): CryptoKey {
    if (!this.key) throw new Error('Unlock the vault first.');
    return this.key;
  }

  async load(contractAddress: string): Promise<VaultRecord> {
    const raw = await this.store.get(REC(contractAddress));
    if (!raw) return {};
    const { iv, ct } = JSON.parse(raw) as { iv: string; ct: string };
    const pt = await aesDecrypt(this.need(), unb64(iv), unb64(ct), enc.encode(contractAddress));
    return JSON.parse(dec.decode(pt)) as VaultRecord;
  }

  async save(contractAddress: string, record: VaultRecord): Promise<void> {
    const { iv, ct } = await aesEncrypt(this.need(), enc.encode(JSON.stringify(record)), enc.encode(contractAddress));
    await this.store.set(REC(contractAddress), JSON.stringify({ iv: b64(iv), ct: b64(ct) }));
  }

  async erase(contractAddress: string): Promise<void> {
    await this.store.remove(REC(contractAddress));
  }

  async contracts(): Promise<string[]> {
    return (await this.store.keys('vault:rec:')).map((k) => k.slice('vault:rec:'.length));
  }
}

/** IndexedDB-backed KeyValueStore (one object store, string values). Falls back to memory when IDB is unavailable. */
export class IdbStore implements KeyValueStore {
  private db: Promise<IDBDatabase> | null = null;
  private fallback = new MemoryStore();
  constructor(private readonly name = 'escrow-vault') {}

  private open(): Promise<IDBDatabase> | null {
    if (typeof indexedDB === 'undefined') return null;
    this.db ??= new Promise((resolve, reject) => {
      const r = indexedDB.open(this.name, 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    return this.db;
  }

  private async tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.open()!;
    return new Promise((resolve, reject) => {
      const req = fn(db.transaction('kv', mode).objectStore('kv'));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async get(k: string) {
    if (!this.open()) return this.fallback.get(k);
    return ((await this.tx('readonly', (s) => s.get(k))) as string | undefined) ?? null;
  }
  async set(k: string, v: string) {
    if (!this.open()) return this.fallback.set(k, v);
    await this.tx('readwrite', (s) => s.put(v, k));
  }
  async remove(k: string) {
    if (!this.open()) return this.fallback.remove(k);
    await this.tx('readwrite', (s) => s.delete(k));
  }
  async keys(prefix: string) {
    if (!this.open()) return this.fallback.keys(prefix);
    const all = (await this.tx('readonly', (s) => s.getAllKeys())) as IDBValidKey[];
    return all.map(String).filter((k) => k.startsWith(prefix));
  }
}
