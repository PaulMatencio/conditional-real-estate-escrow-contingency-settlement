/**
 * One encrypted vault per browser, shared by the admin console and the party pages, plus the store the
 * midnight-js private-state provider uses for the contract maintenance authority key (signing key).
 *
 * Security model (see contract/delay-init.md → "Maintenance authority"):
 *  - the authority key is stored only inside the AES-GCM vault record of its contract, never in plain localStorage;
 *  - midnight-js asks for a signing key on every findDeployedContract and invents a random one when none exists;
 *    those keys are kept in memory only. A key is persisted only while `signingKeyCapture.on` is set, i.e. during a
 *    deploy, when the key is the contract's real authority;
 *  - keys found in plain localStorage from earlier versions are moved into the vault on unlock, then deleted.
 */
import type { KeyValueStore } from '@/application/ports';
import { ADMIN_RECORD, type Vault } from '@/application/partyPorts';
import { EncryptedVault, IdbStore } from './encryptedVault';

let instance: EncryptedVault | null = null;
export function sharedVault(): EncryptedVault {
  instance ??= new EncryptedVault(new IdbStore());
  return instance;
}

/**
 * Tells listeners (the admin console) that the vault was unlocked, locked or restored, so they re-read what they keep
 * from it. Emitted by the party/admin vault controls once migrations have run.
 */
export const vaultSignal = (() => {
  let version = 0;
  const listeners = new Set<() => void>();
  return {
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    getVersion: () => version,
    emit() {
      version++;
      listeners.forEach((l) => l());
    }
  };
})();

// ------------------------------------------------------------------ admin secret key

const HEX64 = /^[0-9a-f]{64}$/;

export async function loadAdminKey(vault: Vault): Promise<string | null> {
  if (!vault.unlocked) return null;
  return (await vault.load(ADMIN_RECORD)).adminKey ?? null;
}

/** Stores (or clears) the admin secret key in the vault; a replaced key is kept in the record's history. */
export async function saveAdminKey(vault: Vault, hex: string | null): Promise<void> {
  if (!vault.unlocked) throw new Error('Unlock the vault first: the admin secret key is stored only there, encrypted.');
  const r = await vault.load(ADMIN_RECORD);
  const key = hex === null ? undefined : hex.trim().toLowerCase().replace(/^0x/, '');
  if (key !== undefined && !HEX64.test(key)) throw new Error('Admin key must be 64 hex characters.');
  const history = r.adminKey && r.adminKey !== key ? [...(r.adminKeyHistory ?? []), { key: r.adminKey, replacedAt: Date.now() }] : r.adminKeyHistory;
  await vault.save(ADMIN_RECORD, { ...r, adminKey: key, adminKeyHistory: history });
}

/** Plain localStorage slot used by earlier versions for the admin key (store namespace "escrow"). */
export const LEGACY_ADMIN_SLOT = 'admin:sk';

/**
 * Moves the admin secret key left in plain localStorage by earlier versions into the vault, verifies it, and deletes
 * the plaintext copy. If the vault already holds a different key, the vault's stays current and the plaintext one is
 * kept in the history. Returns true when a key was moved.
 */
export async function migratePlaintextAdminKey(plain: KeyValueStore, vault: Vault): Promise<boolean> {
  if (!vault.unlocked) return false;
  const raw = await plain.get(LEGACY_ADMIN_SLOT);
  if (raw === null) return false;
  let key: unknown;
  try {
    key = JSON.parse(raw);
  } catch {
    key = raw;
  }
  if (typeof key !== 'string' || !HEX64.test(key.toLowerCase())) {
    await plain.remove(LEGACY_ADMIN_SLOT); // "null" or garbage: nothing to keep
    return false;
  }
  const k = key.toLowerCase();
  const r = await vault.load(ADMIN_RECORD);
  if (!r.adminKey) await vault.save(ADMIN_RECORD, { ...r, adminKey: k });
  else if (r.adminKey !== k && !(r.adminKeyHistory ?? []).some((h) => h.key === k)) {
    await vault.save(ADMIN_RECORD, { ...r, adminKeyHistory: [...(r.adminKeyHistory ?? []), { key: k, replacedAt: Date.now() }] });
  }
  const check = await vault.load(ADMIN_RECORD);
  if (check.adminKey === k || (check.adminKeyHistory ?? []).some((h) => h.key === k)) {
    await plain.remove(LEGACY_ADMIN_SLOT);
    return true;
  }
  return false;
}

export interface SigningKeyStore {
  /** The persisted authority key, or null (also when the vault is locked). */
  load(contractAddress: string): Promise<string | null>;
  /** Persists the authority key; throws when the vault is locked. */
  save(contractAddress: string, key: string): Promise<void>;
  remove(contractAddress: string): Promise<void>;
}

const norm = (a: string) => a.trim().toLowerCase().replace(/^0x/, '');

export function vaultSigningKeys(vault: Vault): SigningKeyStore {
  return {
    async load(a) {
      if (!vault.unlocked) return null;
      return (await vault.load(norm(a))).authorityKey ?? null;
    },
    async save(a, key) {
      if (!vault.unlocked) throw new Error('Unlock the vault: the contract authority key is only stored encrypted.');
      const addr = norm(a);
      const r = await vault.load(addr);
      const history = r.authorityKey && r.authorityKey !== key ? [...(r.authorityKeyHistory ?? []), { key: r.authorityKey, replacedAt: Date.now() }] : r.authorityKeyHistory;
      await vault.save(addr, { ...r, authorityKey: key, authorityKeyHistory: history });
    },
    async remove(a) {
      if (!vault.unlocked) throw new Error('Unlock the vault first.');
      const addr = norm(a);
      const r = await vault.load(addr);
      const { authorityKey: _drop, ...rest } = r;
      await vault.save(addr, rest);
    }
  };
}

/**
 * Moves authority keys left in plain localStorage by earlier versions (`sk:<address>` and `sk:<address>:replaced:<t>`)
 * into the encrypted vault, re-reads them to confirm, then deletes the plaintext copies. Returns the number moved.
 */
export async function migratePlaintextAuthorityKeys(plain: KeyValueStore, vault: Vault): Promise<number> {
  if (!vault.unlocked) return 0;
  let moved = 0;
  const slots = await plain.keys('sk:');
  for (const slot of slots) {
    const m = /^sk:([0-9a-f]{64})(?::replaced:(\d+))?$/.exec(slot);
    if (!m) continue;
    const raw = await plain.get(slot);
    if (raw === null) continue;
    let key: string;
    try {
      key = JSON.parse(raw) as string;
    } catch {
      key = raw;
    }
    if (typeof key !== 'string' || !key) continue;
    const addr = m[1];
    const r = await vault.load(addr);
    const next = { ...r };
    if (m[2]) {
      if (!(r.authorityKeyHistory ?? []).some((h) => h.key === key)) next.authorityKeyHistory = [...(r.authorityKeyHistory ?? []), { key, replacedAt: Number(m[2]) }];
    } else if (!r.authorityKey) {
      next.authorityKey = key;
    } else if (r.authorityKey !== key && !(r.authorityKeyHistory ?? []).some((h) => h.key === key)) {
      next.authorityKeyHistory = [...(r.authorityKeyHistory ?? []), { key, replacedAt: Date.now() }];
    }
    await vault.save(addr, next);
    const check = await vault.load(addr);
    const safe = check.authorityKey === key || (check.authorityKeyHistory ?? []).some((h) => h.key === key);
    if (safe) {
      await plain.remove(slot);
      moved++;
    }
  }
  return moved;
}
