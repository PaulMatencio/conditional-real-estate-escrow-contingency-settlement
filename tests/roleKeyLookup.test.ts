import { describe, expect, it } from 'vitest';
import { findRoleKey } from '@/application/escrowDirectory';
import type { Vault, VaultRecord } from '@/application/partyPorts';

const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64);
// Fake role id derivation (real code uses roleIdHex).
const idOf = (k: string) => {
  if (k === 'bad') throw new Error('not a key');
  return `id-${k}`;
};

function vault(records: Record<string, VaultRecord>, unlocked = true): Vault {
  return { unlocked, contracts: async () => Object.keys(records), load: async (id: string) => records[id] ?? {} } as unknown as Vault;
}

describe('findRoleKey (reuse a role key held for another escrow)', () => {
  it('finds the key stored with the archived escrow whose role id the new escrow expects', async () => {
    const v = vault({
      [A]: { roleKeys: { buyer: 'k1' }, meta: { label: 'Old', createdAt: 1, source: 'package', archived: true } },
      [B]: { roleKeys: { seller: 'k2' } }
    });
    expect(await findRoleKey(v, 'id-k1', idOf, C)).toMatchObject({ address: A, role: 'buyer', key: 'k1' });
    expect(await findRoleKey(v, 'id-zz', idOf, C)).toBeNull();
  });

  it('never returns the open escrow itself, skips unusable keys, and prefers current keys over removed ones', async () => {
    const v = vault({
      [A]: { roleKeyHistory: [{ role: 'buyer', key: 'k1', removedAt: 5 }], meta: { label: 'A', createdAt: 1, source: 'package', lastOpenedAt: 9 } },
      [B]: { roleKeys: { buyer: 'bad', resolver: 'k1' }, meta: { label: 'B', createdAt: 1, source: 'package', lastOpenedAt: 1 } },
      [C]: { roleKeys: { buyer: 'k1' } }
    });
    const m = await findRoleKey(v, 'id-k1', idOf, C);
    expect(m).toMatchObject({ address: B, role: 'resolver', key: 'k1' });
    expect(m?.removed).toBeFalsy();
  });

  it('a locked vault finds nothing', async () => {
    expect(await findRoleKey(vault({ [A]: { roleKeys: { buyer: 'k1' } } }, false), 'id-k1', idOf)).toBeNull();
  });
});
