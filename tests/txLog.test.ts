/** Persistent transaction log: pure helpers, the vault-backed store, the party use-case hook and vault backups. */
import { describe, expect, it } from 'vitest';
import { TXLOG_RECORD, type VaultRecord } from '@/application/partyPorts';
import { runPartyAction, type PartyContext } from '@/application/partyService';
import { displayStatus, mergeTxLog, toCsv, upsertEntry, withTxLog, type TxLogEntry } from '@/application/txLog';
import { summarize } from '@/application/vaultBackup';
import { termsCrypto } from '@/infrastructure/crypto/termsCrypto';
import { EncryptedVault } from '@/infrastructure/storage/encryptedVault';
import { MemoryStore } from '@/infrastructure/storage/kv';
import { VaultTxLog } from '@/infrastructure/storage/txLogStore';
import { exportVault, restoreVault } from '@/infrastructure/storage/vaultBackupStore';
import { BUYER_KEY, K, configuredEscrow, hex, rid } from './helpers/fixtures';

const entry = (id: string, at: number, over: Partial<TxLogEntry> = {}): TxLogEntry => ({
  id,
  session: 's1',
  at,
  updatedAt: at,
  mode: 'wallet',
  network: 'preview',
  contractAddress: hex(1),
  actor: 'buyer',
  action: 'depositToEscrow',
  status: 'confirmed',
  ...over
});

async function unlockedVault(store = new MemoryStore(), pass = 'vault-pass-1') {
  const v = new EncryptedVault(store);
  await v.unlock(pass);
  return v;
}

describe('log helpers', () => {
  it('upserts by id, keeps time order and caps the size', () => {
    let log: TxLogEntry[] = [];
    log = upsertEntry(log, entry('b', 2));
    log = upsertEntry(log, entry('a', 1));
    log = upsertEntry(log, entry('b', 2, { status: 'failed' }));
    expect(log.map((e) => [e.id, e.status])).toEqual([['a', 'confirmed'], ['b', 'failed']]);
    expect(upsertEntry(log, entry('c', 3), 2).map((e) => e.id)).toEqual(['b', 'c']);
  });

  it('merges two logs, the latest update of an entry wins', () => {
    const merged = mergeTxLog([entry('a', 1, { status: 'pending', updatedAt: 1 })], [entry('a', 1, { status: 'confirmed', updatedAt: 5 }), entry('b', 2)]);
    expect(merged.map((e) => [e.id, e.status])).toEqual([['a', 'confirmed'], ['b', 'confirmed']]);
  });

  it('shows a pending entry of another session as interrupted', () => {
    expect(displayStatus(entry('a', 1, { status: 'pending', session: 'old' }), 'now')).toBe('interrupted');
    expect(displayStatus(entry('a', 1, { status: 'pending', session: 'now' }), 'now')).toBe('pending');
  });

  it('exports CSV with quoting', () => {
    const csv = toCsv([entry('a', 0, { status: 'failed', error: 'Wallet said "no", twice' })], 's1');
    expect(csv.split('\r\n')[0]).toBe('at,updatedAt,status,source,mode,network,actor,action,circuits,contractAddress,txId,txHash,blockHeight,fee,error');
    expect(csv).toContain('1970-01-01T00:00:00.000Z');
    expect(csv).toContain('"Wallet said ""no"", twice"');
  });

  it('withTxLog records the outcome and rethrows failures', async () => {
    const calls: unknown[] = [];
    const log = { begin: (s: unknown) => (calls.push(['begin', s]), 'id1'), finish: (id: string, o: unknown) => void calls.push(['finish', id, o]) };
    await withTxLog(log, { mode: 'wallet', network: 'preview', contractAddress: null, actor: 'admin', action: 'configure' }, async () => ({ txId: 't', txHash: 'h', blockHeight: 7 }));
    await expect(withTxLog(log, { mode: 'wallet', network: 'preview', contractAddress: null, actor: 'admin', action: 'finalize' }, async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(calls[1]).toEqual(['finish', 'id1', { status: 'confirmed', txId: 't', txHash: 'h', blockHeight: 7, contractAddress: undefined }]);
    expect(calls[3]).toEqual(['finish', 'id1', { status: 'failed', error: 'boom' }]);
  });
});

describe('vault-backed store', () => {
  it('persists pending then final entries, encrypted, across sessions', async () => {
    const store = new MemoryStore();
    const v = await unlockedVault(store);
    const log = new VaultTxLog(() => v);
    const id = log.begin({ mode: 'wallet', network: 'preview', contractAddress: hex(1), actor: 'seller', action: 'releaseToSeller' });
    await log.idle();
    expect((await v.load(TXLOG_RECORD)).txLog?.[0].status).toBe('pending');
    log.finish(id, { status: 'confirmed', txId: 'tx', txHash: hex(9), blockHeight: 42 });
    await log.idle();
    // Encrypted at rest: the raw store never contains the action name.
    for (const k of await store.keys('')) expect(String(await store.get(k))).not.toContain('releaseToSeller');

    // A new session (reload) reads it back from the vault.
    const v2 = await unlockedVault(store);
    const next = new VaultTxLog(() => v2);
    await next.reload();
    expect(next.getSnapshot()).toMatchObject([{ action: 'releaseToSeller', status: 'confirmed', txHash: hex(9), blockHeight: 42 }]);
  });

  it('marks an attempt that never finished as interrupted in the next session', async () => {
    const store = new MemoryStore();
    const v = await unlockedVault(store);
    const log = new VaultTxLog(() => v);
    log.begin({ mode: 'wallet', network: 'preview', contractAddress: hex(1), actor: 'admin', action: 'deploy' });
    await log.idle();
    const next = new VaultTxLog(() => v);
    await next.reload();
    expect(displayStatus(next.getSnapshot()[0], next.session)).toBe('interrupted');
  });

  it('keeps entries logged while locked and saves them at unlock', async () => {
    const store = new MemoryStore();
    const v = new EncryptedVault(store);
    const log = new VaultTxLog(() => v);
    log.begin({ mode: 'simulator', network: 'simulator', contractAddress: hex(2), actor: 'buyer', action: 'acceptConfiguration' });
    await log.idle();
    expect(log.getSnapshot()).toHaveLength(1);
    await v.unlock('vault-pass-1');
    await log.reload();
    expect((await v.load(TXLOG_RECORD)).txLog).toHaveLength(1);
  });
});

describe('party use-case', () => {
  it('logs every attempted call (confirmed and failed), not pre-flight refusals', async () => {
    const { sim, pkg, casp } = await configuredEscrow();
    const v = await unlockedVault();
    const log = new VaultTxLog(() => v);
    const record: VaultRecord = { terms: pkg, kyc: { buyer: casp.bundle(rid(K.buyer), BUYER_KEY) } };
    const ctx: PartyContext = { gateway: sim.gateway(), crypto: termsCrypto, record, secretKey: K.buyer, txLog: log, network: 'simulator' };
    const v0 = sim.view().configVersion;
    // Not the buyer's action: refused by the pre-flight before any transaction → not logged.
    await expect(runPartyAction(ctx, 'buyer', 'releaseToSeller', [])).rejects.toThrow();
    // The wallet / node rejects the transaction after the pre-flight passed → logged as failed.
    const rejecting = { ...ctx, gateway: { ...ctx.gateway, call: async () => Promise.reject(new Error('Rejected: user declined')) } };
    await expect(runPartyAction(rejecting, 'buyer', 'acceptConfiguration', [v0])).rejects.toThrow('declined');
    await runPartyAction(ctx, 'buyer', 'acceptConfiguration', [v0]);
    await log.idle();
    const entries = log.getSnapshot();
    expect(entries.map((e) => [e.actor, e.action, e.status, e.mode])).toEqual([
      ['buyer', 'acceptConfiguration', 'failed', 'simulator'],
      ['buyer', 'acceptConfiguration', 'confirmed', 'simulator']
    ]);
    expect(entries[0].error).toBe('Rejected: user declined');
    expect(entries[1]).toMatchObject({ contractAddress: sim.contractAddress, network: 'simulator' });
    expect(entries[1].txHash).toMatch(/^sim-/);
    expect(JSON.stringify(entries)).not.toContain(pkg.terms.amountSalt); // no private material
  });

  it('logs the simulator admin helpers when a logger is attached', async () => {
    const { sim } = await configuredEscrow();
    const v = await unlockedVault();
    sim.logger = new VaultTxLog(() => v);
    await sim.finalize(K.admin).catch(() => undefined);
    await (sim.logger as VaultTxLog).idle();
    expect((sim.logger as VaultTxLog).getSnapshot()).toMatchObject([{ actor: 'admin', action: 'finalizeInitialization', mode: 'simulator' }]);
  });
});

describe('vault backup', () => {
  it('carries the log and merges it on restore', async () => {
    const src = await unlockedVault();
    await src.save(TXLOG_RECORD, { txLog: [entry('a', 1), entry('b', 2)] });
    const backup = await exportVault(src);
    expect(summarize(backup)).toMatchObject({ txLog: 2, contracts: [] });

    const dst = await unlockedVault(new MemoryStore(), 'other-pass');
    await dst.save(TXLOG_RECORD, { txLog: [entry('b', 2), entry('c', 3)] });
    const report = await restoreVault(dst, backup);
    expect(report.txLogAdded).toBe(1);
    expect((await dst.load(TXLOG_RECORD)).txLog?.map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });
});
