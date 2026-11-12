import type { Vault } from '@/application/partyPorts';
import { vaultSigningKeys } from './vaultInstance';

const HEX64 = /^[0-9a-f]{64}$/;
const normalize = (a: string) => a.trim().replace(/^0x/, '').toLowerCase();

/**
 * The contract's maintenance authority key (created at deploy time, needed to register circuits and to renounce the
 * authority). It lives only in the encrypted vault of this browser, so it needs an explicit backup path.
 */
export async function exportAuthorityKey(vault: Vault, contractAddress: string): Promise<string | null> {
  if (!vault.unlocked) throw new Error('Unlock the vault first: the authority key is stored encrypted.');
  return vaultSigningKeys(vault).load(normalize(contractAddress));
}

/** Restores an authority key into the vault; the previous one (if any) is kept in the record's history. */
export async function importAuthorityKey(vault: Vault, contractAddress: string, key: string): Promise<void> {
  const k = normalize(key);
  if (!HEX64.test(k)) throw new Error('Authority key must be 64 hex characters.');
  const addr = normalize(contractAddress);
  if (!HEX64.test(addr)) throw new Error('Contract address must be 64 hex characters.');
  if (k === addr) throw new Error('That is the contract address, not the authority key.');
  await vaultSigningKeys(vault).save(addr, k);
}
