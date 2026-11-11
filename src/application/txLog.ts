/**
 * Transaction log (FR-AUDIT-03, extended): every transaction this browser builds, for every actor (admin and parties)
 * and every escrow, in both modes. An entry is written as `pending` before anything is submitted and updated with the
 * outcome, so an attempt interrupted by a closed tab or a crash still shows up (as "interrupted").
 *
 * Only public facts are logged: who (role), what (circuit / maintenance action), which contract, when, the tx id /
 * hash / block and a short error message. Never secret keys, witnesses, terms or attestations.
 */
export type TxStatus = 'pending' | 'confirmed' | 'failed';
export type TxMode = 'wallet' | 'simulator';

export interface TxLogEntry {
  id: string;
  /** Browser session that wrote it: a `pending` entry from another session was interrupted. */
  session: string;
  /** Start (ms since epoch) and last update. */
  at: number;
  updatedAt: number;
  mode: TxMode;
  network: string;
  /** Null for a deploy that failed before the contract got an address. */
  contractAddress: string | null;
  /** 'admin', a party role ('buyer', 'seller', …) or 'anyone'. */
  actor: string;
  /** Circuit name, or a maintenance action: 'deploy', 'registerCircuits', 'renounceAuthority'. */
  action: string;
  /** Circuits carried by a maintenance transaction (verifier-key batch). */
  circuits?: string[];
  status: TxStatus;
  txId?: string;
  txHash?: string;
  blockHeight?: number;
  error?: string;
  /** Where the entry comes from: built in this browser (default), imported from the chain, or both (matched). */
  source?: 'local' | 'chain' | 'both';
  /** Fee paid, as reported by the indexer (chain imports). */
  fee?: string;
}

export type TxLogStart = Pick<TxLogEntry, 'mode' | 'network' | 'contractAddress' | 'actor' | 'action' | 'circuits'>;
export interface TxOutcome {
  status: Exclude<TxStatus, 'pending'>;
  contractAddress?: string | null;
  txId?: string;
  txHash?: string;
  blockHeight?: number;
  error?: string;
}

/** Port used by the use-cases and gateways. */
export interface TxLogger {
  begin(start: TxLogStart): string;
  finish(id: string, outcome: TxOutcome): void;
}

/** Keeps the log bounded inside one encrypted vault record. */
export const TX_LOG_CAP = 5000;
const MAX_ERROR = 500;

export const shortError = (e: unknown): string => {
  const m = e instanceof Error ? e.message : String(e);
  return m.length > MAX_ERROR ? `${m.slice(0, MAX_ERROR)}…` : m;
};

/** Inserts or replaces by id, oldest first, keeping the newest `cap` entries. */
export function upsertEntry(entries: readonly TxLogEntry[], entry: TxLogEntry, cap = TX_LOG_CAP): TxLogEntry[] {
  const i = entries.findIndex((e) => e.id === entry.id);
  const next = i >= 0 ? entries.map((e, j) => (j === i ? entry : e)) : [...entries, entry];
  next.sort((a, b) => a.at - b.at);
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/** Union of two logs: the most recently updated copy of an entry wins; on a tie, the copy from `b`. */
export function mergeTxLog(a: readonly TxLogEntry[] = [], b: readonly TxLogEntry[] = [], cap = TX_LOG_CAP): TxLogEntry[] {
  const byId = new Map<string, TxLogEntry>();
  for (const e of [...a, ...b]) {
    const have = byId.get(e.id);
    if (!have || e.updatedAt >= have.updatedAt) byId.set(e.id, e);
  }
  const all = [...byId.values()].sort((x, y) => x.at - y.at);
  return all.length > cap ? all.slice(all.length - cap) : all;
}

export type DisplayStatus = TxStatus | 'interrupted';

/** A `pending` entry written by an earlier session will never be updated: its outcome is unknown. */
export const displayStatus = (e: TxLogEntry, currentSession: string): DisplayStatus =>
  e.status === 'pending' && e.session !== currentSession ? 'interrupted' : e.status;

/** Wraps one transaction: logs it as pending, then confirmed (with the receipt) or failed (with the error). */
export async function withTxLog<T extends { txId?: string; txHash?: string; blockHeight?: number } | undefined>(
  log: TxLogger | undefined,
  start: TxLogStart,
  run: () => Promise<T>,
  receiptOf: (r: T) => { txId?: string; txHash?: string; blockHeight?: number; contractAddress?: string | null } = (r) => r ?? {}
): Promise<T> {
  if (!log) return run();
  const id = log.begin(start);
  try {
    const r = await run();
    const x = receiptOf(r);
    log.finish(id, { status: 'confirmed', txId: x.txId || undefined, txHash: x.txHash || undefined, blockHeight: x.blockHeight, contractAddress: x.contractAddress });
    return r;
  } catch (e) {
    log.finish(id, { status: 'failed', error: shortError(e) });
    throw e;
  }
}

const CSV_COLUMNS = ['at', 'updatedAt', 'status', 'source', 'mode', 'network', 'actor', 'action', 'circuits', 'contractAddress', 'txId', 'txHash', 'blockHeight', 'fee', 'error'] as const;

/** RFC 4180 CSV (ISO dates), for a spreadsheet or an auditor. */
export function toCsv(entries: readonly TxLogEntry[], currentSession: string): string {
  const cell = (v: unknown) => {
    const s = v === undefined || v === null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = entries.map((e) =>
    CSV_COLUMNS.map((c) => {
      if (c === 'at' || c === 'updatedAt') return cell(new Date(e[c]).toISOString());
      if (c === 'status') return cell(displayStatus(e, currentSession));
      if (c === 'circuits') return cell(e.circuits?.join(' '));
      if (c === 'source') return cell(e.source ?? 'local');
      return cell(e[c]);
    }).join(',')
  );
  return [CSV_COLUMNS.join(','), ...rows].join('\r\n') + '\r\n';
}
