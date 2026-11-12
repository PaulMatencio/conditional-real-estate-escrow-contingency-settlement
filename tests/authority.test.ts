/** Maintenance authority: encrypted storage of the key, plaintext migration, deploy capture, and the party-side checks. */
import { describe, expect, it } from 'vitest';
import { preflight } from '@/application/partyService';
import { authorityLevel } from '@/domain/escrowView';
import { termsCrypto } from '@/infrastructure/crypto/termsCrypto';
import { EncryptedVault } from '@/infrastructure/storage/encryptedVault';
import { MemoryStore } from '@/infrastructure/storage/kv';
import { persistentPrivateStateProvider, signingKeyCapture } from '@/infrastructure/storage/privateStateProvider';
import { loadAdminKey, migratePlaintextAdminKey, migratePlaintextAuthorityKeys, saveAdminKey, vaultSigningKeys } from '@/infrastructure/storage/vaultInstance';
import { importAuthorityKey, exportAuthorityKey } from '@/infrastructure/storage/authorityKey';
import { BUYER_KEY, K, configuredEscrow, hex, rid } from './helpers/fixtures';

const ADDR = hex(0xaa);

async function unlocked() {
  const vault = new EncryptedVault(new MemoryStore());
  await vault.unlock('passphrase-123');
  return vault;
}

describe('authorityLevel', () => {
  it('classifies the on-chain committee', () => {
    expect(authorityLevel({ committeeSize: 0, threshold: 1, counter: '1' })).toBe('immutable');
    expect(authorityLevel({ committeeSize: 1, threshold: 1, counter: '0' })).toBe('controlled');
    expect(authorityLevel({ committeeSize: 0, threshold: 0, counter: '1' })).toBe('open');
    expect(authorityLevel(null)).toBe('unknown');
  });
});

describe('authority key storage', () => {
  it('persists the key only during a deploy, encrypted in the vault', async () => {
    const vault = await unlocked();
    const backing = new MemoryStore();
    const psp = persistentPrivateStateProvider(backing, vaultSigningKeys(vault));
    // findDeployedContract invents a key when none exists: memory only, never persisted.
    // midnight-js 5 (ledger 9) hands keys over as { tag: 'schnorr', value }; midnight-js gets that shape back.
    await psp.setSigningKey(ADDR, { tag: 'schnorr', value: hex(0x22) } as never);
    expect(await vaultSigningKeys(vault).load(ADDR)).toBeNull();
    expect(await psp.getSigningKey(ADDR)).toEqual({ tag: 'schnorr', value: hex(0x22) });
    await expect(psp.setSigningKey(ADDR, 'junk' as never)).rejects.toThrow();
    // The deploy hands over the real authority key: persisted in the vault, nowhere else.
    signingKeyCapture.on = true;
    try {
      await psp.setSigningKey(ADDR, { tag: 'schnorr', value: hex(0x11) } as never);
    } finally {
      signingKeyCapture.on = false;
    }
    expect(await psp.getSigningKey(ADDR)).toEqual({ tag: 'schnorr', value: hex(0x11) });
    expect(await backing.keys('')).toEqual([]);
    expect(await exportAuthorityKey(vault, ADDR)).toBe(hex(0x11));
  });

  it('refuses to persist when the vault is locked', async () => {
    const vault = new EncryptedVault(new MemoryStore());
    await expect(vaultSigningKeys(vault).save(ADDR, hex(1))).rejects.toThrow(/Unlock the vault/);
    expect(await vaultSigningKeys(vault).load(ADDR)).toBeNull();
  });

  it('import keeps the previous key in the history', async () => {
    const vault = await unlocked();
    await importAuthorityKey(vault, ADDR, hex(1));
    await importAuthorityKey(vault, ADDR, hex(2));
    const r = await vault.load(ADDR);
    expect(r.authorityKey).toBe(hex(2));
    expect(r.authorityKeyHistory?.map((h) => h.key)).toEqual([hex(1)]);
  });

  it('migrates plaintext keys from earlier versions into the vault and deletes them', async () => {
    const vault = await unlocked();
    const plain = new MemoryStore();
    await plain.set(`sk:${ADDR}`, JSON.stringify(hex(3)));
    await plain.set(`sk:${ADDR}:replaced:1700000000000`, JSON.stringify(hex(4)));
    await plain.set('admin:contract', ADDR);
    expect(await migratePlaintextAuthorityKeys(plain, vault)).toBe(2);
    expect(await plain.keys('sk:')).toEqual([]);
    expect(await plain.get('admin:contract')).toBe(ADDR); // unrelated data untouched
    const r = await vault.load(ADDR);
    expect(r.authorityKey).toBe(hex(3));
    expect(r.authorityKeyHistory?.map((h) => h.key)).toEqual([hex(4)]);
  });

  it('does nothing while the vault is locked', async () => {
    const plain = new MemoryStore();
    await plain.set(`sk:${ADDR}`, JSON.stringify(hex(3)));
    expect(await migratePlaintextAuthorityKeys(plain, new EncryptedVault(new MemoryStore()))).toBe(0);
    expect(await plain.get(`sk:${ADDR}`)).not.toBeNull();
  });
});

describe('party checks against an active maintenance authority', () => {
  it('blocks the deposit and warns on acceptance until the authority is renounced', async () => {
    const { sim, pkg, casp } = await configuredEscrow();
    const ctx = { gateway: sim.gateway(), crypto: termsCrypto, record: { terms: pkg, kyc: { buyer: casp.bundle(rid(K.buyer), BUYER_KEY) } }, secretKey: K.buyer };
    const base = sim.view();
    const controlled = { ...base, maintenance: { committeeSize: 1, threshold: 1, counter: '0' } };
    const dep = await preflight(ctx, { ...controlled, status: 'Created' }, 'buyer', 'depositToEscrow', [], BigInt(sim.time));
    expect(dep.problems.join(' ')).toMatch(/maintenance authority is still active/);
    const acc = await preflight(ctx, controlled, 'buyer', 'acceptConfiguration', [base.configVersion], BigInt(sim.time));
    expect(acc.ok).toBe(true);
    expect(acc.warnings.join(' ')).toMatch(/maintenance authority is still active/);
    const immutable = { ...base, status: 'Created' as const, maintenance: { committeeSize: 0, threshold: 1, counter: '1' } };
    const ok = await preflight(ctx, immutable, 'buyer', 'depositToEscrow', [], BigInt(sim.time));
    expect(ok.problems.join(' ')).not.toMatch(/maintenance authority/);
  });
});

describe('admin secret key in the vault', () => {
  it('moves the plaintext admin key into the vault and deletes it', async () => {
    const vault = await unlocked();
    const plain = new MemoryStore();
    await plain.set('admin:sk', JSON.stringify(hex(0x21)));
    expect(await migratePlaintextAdminKey(plain, vault)).toBe(true);
    expect(await plain.get('admin:sk')).toBeNull();
    expect(await loadAdminKey(vault)).toBe(hex(0x21));
  });

  it('keeps the vault key when the plaintext one differs (old one goes to history)', async () => {
    const vault = await unlocked();
    await saveAdminKey(vault, hex(0x22));
    const plain = new MemoryStore();
    await plain.set('admin:sk', JSON.stringify(hex(0x23)));
    await migratePlaintextAdminKey(plain, vault);
    expect(await loadAdminKey(vault)).toBe(hex(0x22));
    expect((await vault.load('_admin')).adminKeyHistory?.map((h) => h.key)).toEqual([hex(0x23)]);
    expect(await plain.get('admin:sk')).toBeNull();
  });

  it('refuses to save while locked and returns null when locked', async () => {
    const vault = new EncryptedVault(new MemoryStore());
    await expect(saveAdminKey(vault, hex(1))).rejects.toThrow(/Unlock the vault/);
    expect(await loadAdminKey(vault)).toBeNull();
  });
});
