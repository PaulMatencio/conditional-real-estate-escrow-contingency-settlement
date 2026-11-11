/**
 * Persistent transaction log, kept in the encrypted vault (record TXLOG_RECORD) so it survives reloads, browser
 * restarts and is carried by vault backups, yet reveals nothing while the vault is locked.
 *
 * Writes are serialized. An entry written while the vault is locked (should not happen: every transaction needs a key
 * from the vault) is kept in memory and saved at the next unlock.
 */
import { TXLOG_RECORD, type Vault } from '@/application/partyPorts';
import { mergeTxLog, upsertEntry, type TxLogEntry, type TxLogger, type TxLogStart, type TxOutcome } from '@/application/txLog';
import { sharedVault, vaultSignal } from './vaultInstance';

const randomId = () => {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
};

export class VaultTxLog implements TxLogger {
  readonly session = randomId();
  private entries: TxLogEntry[] = [];
  /** Entries changed since the last successful save. */
  private dirty = new Map<string, TxLogEntry>();
  private chain: Promise<void> = Promise.resolve();
  private listeners = new Set<() => void>();

  constructor(
    private readonly vault: () => Vault,
    private readonly now: () => number = () => Date.now()
  ) {}

  begin(start: TxLogStart): string {
    const t = this.now();
    const entry: TxLogEntry = { id: `${t.toString(36)}-${randomId()}`, session: this.session, at: t, updatedAt: t, status: 'pending', ...start };
    this.put(entry);
    return entry.id;
  }

  finish(id: string, o: TxOutcome): void {
    const e = this.entries.find((x) => x.id === id) ?? this.dirty.get(id);
    if (!e) return;
    this.put({
      ...e,
      status: o.status,
      // Strictly later than the pending copy, even within the same millisecond, so it always wins a merge.
      updatedAt: Math.max(this.now(), e.updatedAt + 1),
      contractAddress: o.contractAddress ?? e.contractAddress,
      txId: o.txId ?? e.txId,
      txHash: o.txHash ?? e.txHash,
      blockHeight: o.blockHeight ?? e.blockHeight,
      error: o.error
    });
  }

  /** Current view (oldest first). Stable reference between changes, for useSyncExternalStore. */
  getSnapshot = (): readonly TxLogEntry[] => this.entries;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };

  /** Re-reads the vault (after unlock / lock / restore) and saves what was logged meanwhile. */
  reload(): Promise<void> {
    return this.enqueue(async () => {
      const v = this.vault();
      if (!v.unlocked) {
        // Locked: show only what this session logged and has not saved yet.
        this.entries = [...this.dirty.values()].sort((a, b) => a.at - b.at);
        this.emit();
        return;
      }
      const stored = (await v.load(TXLOG_RECORD)).txLog ?? [];
      this.entries = mergeTxLog(stored, [...this.entries, ...this.dirty.values()]);
      this.emit();
      await this.save(v);
    });
  }

  /**
   * Applies a pure transformation of the whole log (e.g. a chain import) and saves the entries it changed in one
   * write. Needs the vault unlocked, so the transformation sees the full persisted log.
   */
  async transform<R>(fn: (entries: readonly TxLogEntry[]) => { entries: TxLogEntry[] } & R): Promise<R> {
    if (!this.vault().unlocked) throw new Error('Unlock the vault first: the transaction log is stored there, encrypted.');
    await this.reload();
    let result!: R;
    let failure: unknown = null;
    await this.enqueue(async () => {
      try {
        const before = new Map(this.entries.map((e) => [e.id, e]));
        const out = fn(this.entries);
        for (const e of out.entries) if (before.get(e.id) !== e) this.dirty.set(e.id, e);
        this.entries = out.entries;
        this.emit();
        await this.save(this.vault());
        const { entries: _ignored, ...rest } = out;
        void _ignored;
        result = rest as unknown as R;
      } catch (e) {
        failure = e;
      }
    });
    if (failure) throw failure;
    return result;
  }

  /** Resolves once every queued write has been attempted (tests, before export). */
  idle(): Promise<void> {
    return this.chain;
  }

  private put(entry: TxLogEntry) {
    this.entries = upsertEntry(this.entries, entry);
    this.dirty.set(entry.id, entry);
    this.emit();
    void this.enqueue(async () => {
      const v = this.vault();
      if (v.unlocked) await this.save(v);
    });
  }

  private async save(v: Vault) {
    if (this.dirty.size === 0) return;
    const batch = new Map(this.dirty);
    const rec = await v.load(TXLOG_RECORD);
    await v.save(TXLOG_RECORD, { ...rec, txLog: mergeTxLog(rec.txLog, [...batch.values()]) });
    // Keep anything updated while the save was running.
    for (const [id, e] of batch) if (this.dirty.get(id) === e) this.dirty.delete(id);
  }

  private enqueue(job: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(job).catch((e) => console.error('[txlog] could not save the transaction log', e instanceof Error ? e.message : e));
    return this.chain;
  }

  private emit() {
    this.listeners.forEach((l) => l());
  }
}

let instance: VaultTxLog | null = null;

/** The browser-wide log, bound to the shared vault and refreshed whenever it is unlocked, locked or restored. */
export function sharedTxLog(): VaultTxLog {
  if (!instance) {
    const log = new VaultTxLog(sharedVault);
    instance = log;
    vaultSignal.subscribe(() => void log.reload());
    void log.reload();
  }
  return instance;
}
