/** Vault backup / restore: round trip, merge without loss, identity rules, wrong passphrase and wrong file kinds. */
import { describe, expect, it } from 'vitest';
import { ADMIN_RECORD, IDENTITY_RECORD } from '@/application/partyPorts';
import { BACKUP_FORMAT, mergeAdmin, mergeIdentity, mergeRecord, summarize } from '@/application/vaultBackup';
import { generateRecipientKeyPair, sealWithPassphrase } from '@/infrastructure/crypto/aead';
import { EncryptedVault } from '@/infrastructure/storage/encryptedVault';
import { MemoryStore } from '@/infrastructure/storage/kv';
import { exportVault, openBackup, restoreVault, sealBackup } from '@/infrastructure/storage/vaultBackupStore';
import { hex } from './helpers/fixtures';

const A = hex(0xa1);
const B = hex(0xb2);
const PASS = 'backup-pass-123';

async function vaultWith(pass = 'vault-pass-1') {
  const v = new EncryptedVault(new MemoryStore());
  await v.unlock(pass);
  return v;
}

describe('vault backup round trip', () => {
  it('exports every record, seals it and restores it into a new browser', async () => {
    const src = await vaultWith();
    const id = await generateRecipientKeyPair();
    await src.save(IDENTITY_RECORD, { identity: id });
    await src.save(A, { roleKeys: { admin: hex(1), buyer: hex(2) }, authorityKey: hex(3), history: [{ at: 1, circuit: 'configure', txHash: 'h1', status: 'confirmed' }] });
    await src.save(B, { authorityRenouncedAt: 5 });
    await src.save(ADMIN_RECORD, { adminKey: hex(9) });
    const sealed = await sealBackup(await exportVault(src, { contractAddress: A }), PASS);
    expect(JSON.stringify(sealed)).not.toContain(hex(3)); // encrypted

    const opened = await openBackup(JSON.parse(JSON.stringify(sealed)), PASS);
    const s = summarize(opened);
    expect(s.contracts.map((c) => c.address).sort()).toEqual([A, B].sort());
    expect(s).toMatchObject({ identity: true, adminKey: true, adminContract: A });
    expect(summarize(await exportVault(src, { includeAdminKey: false })).adminKey).toBe(false);

    // New browser: a fresh vault (its own new identity, no escrows yet).
    const dst = await vaultWith('another-pass');
    const fresh = await generateRecipientKeyPair();
    await dst.save(IDENTITY_RECORD, { identity: fresh });
    const r = await restoreVault(dst, opened);
    expect(r.contractsAdded.sort()).toEqual([A, B].sort());
    expect((await dst.load(A)).authorityKey).toBe(hex(3));
    const idRec = await dst.load(IDENTITY_RECORD);
    expect(idRec.identity?.publicKey).toBe(id.publicKey); // unused fresh identity replaced by the backup's
    expect(idRec.identityHistory?.map((k) => k.publicKey)).toEqual([fresh.publicKey]);
    expect((await dst.load(ADMIN_RECORD)).adminKey).toBe(hex(9));
    expect(r.admin).toBe('admin secret key restored');
  });

  it('rejects a wrong passphrase, short passphrases and other encrypted files', async () => {
    const v = await vaultWith();
    await v.save(A, { roleKeys: { buyer: hex(2) } });
    const sealed = await sealBackup(await exportVault(v), PASS);
    await expect(openBackup(sealed, 'wrong-passphrase')).rejects.toThrow(/Wrong passphrase/);
    await expect(sealBackup(await exportVault(v), 'short')).rejects.toThrow(/at least 12/);
    const termsBackup = await sealWithPassphrase({ format: 'EscrowTermsV1', terms: {}, commitments: {} }, PASS);
    await expect(openBackup(termsBackup, PASS)).rejects.toThrow(/not a vault backup/);
    await expect(openBackup({ hello: 1 }, PASS)).rejects.toThrow(/Not an encrypted vault backup/);
  });
});

describe('merge rules (never delete, never silently overwrite)', () => {
  it('fills gaps, unions lists and keeps the current value on conflicts', () => {
    const current = { roleKeys: { buyer: hex(2) }, authorityKey: hex(3), history: [{ at: 2, circuit: 'deposit', txHash: 'h2', status: 'confirmed' }] };
    const incoming = {
      roleKeys: { buyer: hex(7), seller: hex(4) },
      authorityKey: hex(8),
      history: [
        { at: 1, circuit: 'configure', txHash: 'h1', status: 'confirmed' },
        { at: 2, circuit: 'deposit', txHash: 'h2', status: 'confirmed' }
      ]
    };
    const { record, added, conflicts } = mergeRecord(current, incoming, 'A');
    expect(record.roleKeys).toEqual({ buyer: hex(2), seller: hex(4) });
    expect(record.authorityKey).toBe(hex(3));
    expect(record.authorityKeyHistory?.map((h) => h.key)).toEqual([hex(8)]);
    expect(record.history?.map((h) => h.txHash)).toEqual(['h1', 'h2']);
    expect(added).toEqual(['A: seller role key', 'A: 1 history entry']);
    expect(conflicts).toHaveLength(2);
  });

  it('does not bring back an authority key that was renounced', () => {
    const { record } = mergeRecord({ authorityRenouncedAt: 10 }, { authorityKey: hex(3) }, 'A');
    expect(record.authorityKey).toBeUndefined();
  });

  it('keeps an identity in use and stores the backup one as previous', async () => {
    const cur = await generateRecipientKeyPair();
    const old = await generateRecipientKeyPair();
    const { record } = mergeIdentity({ identity: cur }, { identity: old }, true);
    expect(record.identity?.publicKey).toBe(cur.publicKey);
    expect(record.identityHistory?.map((k) => k.publicKey)).toEqual([old.publicKey]);
  });
});

describe('admin key in backups', () => {
  it('restores a legacy backup key (admin.secretKey) and never replaces a current key', () => {
    const legacy = { format: BACKUP_FORMAT, createdAt: '', records: {}, admin: { secretKey: hex(9) } } as const;
    expect(mergeAdmin({}, legacy).record.adminKey).toBe(hex(9));
    const kept = mergeAdmin({ adminKey: hex(1) }, legacy);
    expect(kept.record.adminKey).toBe(hex(1));
    expect(kept.record.adminKeyHistory?.map((h) => h.key)).toEqual([hex(9)]);
    expect(kept.note).toMatch(/kept the current one/);
  });
});

describe('party / notary scope', () => {
  it('never exports or restores admin material from a party page, keeps everything else', async () => {
    const src = await vaultWith();
    await src.save(A, { roleKeys: { seller: hex(2) }, authorityKey: hex(3), authorityKeyHistory: [{ key: hex(4), replacedAt: 1 }] });
    await src.save(ADMIN_RECORD, { adminKey: hex(9) });
    const party = await exportVault(src, { scope: 'party', includeAdminKey: true });
    expect(party.records[ADMIN_RECORD]).toBeUndefined();
    expect(party.records[A]).toEqual({ roleKeys: { seller: hex(2) } });

    // An admin backup restored on a party page: role keys in, admin and authority keys out (and reported).
    const full = await exportVault(src, { contractAddress: A });
    const dst = await vaultWith('party-pass-1');
    const r = await restoreVault(dst, full, { scope: 'party' });
    expect(r.adminSkipped).toBe(true);
    expect(r.admin).toBeNull();
    expect(await dst.load(A)).toEqual({ roleKeys: { seller: hex(2) } });
    expect(await dst.contracts()).not.toContain(ADMIN_RECORD);

    // A party backup restores without the warning.
    const again = await restoreVault(await vaultWith('party-pass-2'), party, { scope: 'party' });
    expect(again.adminSkipped).toBe(false);
  });
});

describe('v2 lender fields', () => {
  it('fills in the lender terms and the second-coin index, and reports a different lender package', async () => {
    const lt = { format: 'EscrowLenderTermsV2', price: '10', priceSalt: hex(1), lenderShare: '6', lenderShareSalt: hex(2), lenderPayout: hex(3), lenderPayoutSalt: hex(4), refundOnLoss: true, loanTermsSalt: hex(5), commitments: { price: hex(6), lenderShare: hex(7), lenderPayout: hex(8), loanTerms: hex(9) }, createdAt: 1 } as const;
    const added = mergeRecord({ secondCoin: { kind: 'loan' } }, { lenderTerms: lt, secondCoin: { kind: 'loan', index: '7' } }, 'c');
    expect(added.record.lenderTerms).toEqual(lt);
    expect(added.record.secondCoin).toEqual({ kind: 'loan', index: '7' });
    expect(added.added).toEqual(['c: lender terms', 'c: loan coin index']);
    const other = mergeRecord({ lenderTerms: lt }, { lenderTerms: { ...lt, commitments: { ...lt.commitments, price: hex(0x0a) } } }, 'c');
    expect(other.conflicts).toEqual(['c: lender terms differ (kept the current ones)']);
  });
});
