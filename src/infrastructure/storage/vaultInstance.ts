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
import type { Vault } from '@/application/partyPorts';
import { EncryptedVault, IdbStore } from './encryptedVault';

let instance: EncryptedVault | null = null;
export function sharedVault(): EncryptedVault {
  instance ??= new EncryptedVault(new IdbStore());
  return instance;
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
