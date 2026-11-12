/** Authority key shapes: ledger 9 tagged object vs. the bare hex the vault stores; committee matching by value. */
import * as rt from '@midnight-ntwrk/compact-runtime';
import { ContractMaintenanceAuthority, signatureVerifyingKey } from '@midnightntwrk/ledger-v9';
import { describe, expect, it } from 'vitest';
import { mergeRecord } from '@/application/vaultBackup';
import { signingKeyHex, toSigningKey, verifyingKeyId } from '@/infrastructure/storage/signingKeyCodec';
import { vaultSigningKeys } from '@/infrastructure/storage/vaultInstance';
import type { Vault, VaultRecord } from '@/application/partyPorts';

const memVault = (seed: Record<string, VaultRecord> = {}): Vault & { raw: Record<string, VaultRecord> } => {
  const raw = { ...seed };
  return { raw, unlocked: true, load: async (a: string) => raw[a] ?? {}, save: async (a: string, r: VaultRecord) => void (raw[a] = r) } as unknown as Vault & { raw: Record<string, VaultRecord> };
};
const ADDR = 'ab'.repeat(32);

describe('authority key codec', () => {
  const tagged = rt.sampleSigningKey() as unknown as { tag: string; value: string };

  it('reads every shape as bare hex and rebuilds the ledger object', () => {
    expect(signingKeyHex(tagged)).toBe(tagged.value);
    expect(signingKeyHex(JSON.stringify(tagged))).toBe(tagged.value);
    expect(signingKeyHex(`0x${tagged.value.toUpperCase()}`)).toBe(tagged.value);
    expect(signingKeyHex({ tag: 'other', value: tagged.value })).toBeNull();
    expect(signingKeyHex('nope')).toBeNull();
    expect(toSigningKey(tagged.value)).toEqual({ tag: 'schnorr', value: tagged.value });
  });

  it('matches the committee only for the right key (no "[object Object]" equality)', () => {
    const committee = new ContractMaintenanceAuthority([signatureVerifyingKey(tagged as never)], 1).committee;
    const id = (k: unknown) => verifyingKeyId(signatureVerifyingKey(toSigningKey(k) as never));
    expect(committee.some((k: unknown) => verifyingKeyId(k) === id(tagged.value))).toBe(true);
    const other = rt.sampleSigningKey() as unknown as { value: string };
    expect(committee.some((k: unknown) => verifyingKeyId(k) === id(other.value))).toBe(false);
  });

  it('heals a vault record holding the tagged object and stores hex on save', async () => {
    const v = memVault({ [ADDR]: { authorityKey: tagged as never, authorityKeyHistory: [{ key: tagged as never, replacedAt: 1 }] } });
    const store = vaultSigningKeys(v);
    expect(await store.load(ADDR)).toBe(tagged.value);
    expect(v.raw[ADDR].authorityKey).toBe(tagged.value);
    expect(v.raw[ADDR].authorityKeyHistory?.[0].key).toBe(tagged.value);
    const next = rt.sampleSigningKey();
    await store.save(ADDR, next);
    expect(v.raw[ADDR].authorityKey).toBe((next as unknown as { value: string }).value);
  });

  it('merges backups holding either shape as the same key', () => {
    const r = mergeRecord({ authorityKey: tagged.value }, { authorityKey: tagged as never }, 'c');
    expect(r.conflicts).toEqual([]);
    expect(r.record.authorityKey).toBe(tagged.value);
  });
});
