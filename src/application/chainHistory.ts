/**
 * Importing an escrow's past transactions from the chain (indexer) into the transaction log.
 *
 * The chain is the authoritative record of WHAT happened: every deploy, circuit call and maintenance update, with its
 * hash, block, time and result. It does not say WHO did it — roles are proven in zero knowledge — so the actor is
 * inferred only where the contract leaves no choice (a circuit only one role can call, or acceptance flags that flip)
 * and shown as a list of possible roles otherwise. Private inputs never appear on-chain and are never imported.
 *
 * Merging: a chain transaction that matches a local entry (same contract and tx hash or tx id) enriches it — block,
 * final result, and it resolves "in progress" / "interrupted" entries. Unmatched ones become new "from chain" entries
 * with a stable id, so importing again is idempotent.
 */
import { ACTIONS, type PartyCircuit } from '@/domain/lifecycle';
import { upsertEntry, type TxLogEntry } from './txLog';

export type ChainResult = 'SUCCESS' | 'PARTIAL_SUCCESS' | 'FAILURE';

/** One contract action as read (and decoded) from the indexer. */
export interface ChainAction {
  kind: 'deploy' | 'call' | 'update';
  /** Circuit name, for a call. */
  entryPoint?: string;
  txHash: string;
  /** Transaction identifiers (what midnight-js returns as txId). */
  identifiers: string[];
  blockHeight: number;
  /** Block time, ms since epoch. */
  blockTime: number;
  result: ChainResult | null;
  /** Fee paid, in DUST base units (as reported by the indexer). */
  fee?: string;
  /** Maintenance update: circuits whose verifier key appeared, and whether the authority was renounced. */
  circuitsAdded?: string[];
  circuitsRemoved?: string[];
  renounced?: boolean;
  /** acceptConfiguration: whose acceptance flag flipped in this transaction. */
  acceptedBy?: 'buyer' | 'seller';
}

/** Admin-only circuits (not in the party action table). */
const ADMIN_CIRCUITS = new Set(['configure', 'configureFinancing', 'addKycIssuer', 'removeKycIssuer', 'finalizeInitialization']);

/** Who could have sent it: one role when the contract allows only one, else the possible roles joined by "|". */
export function inferActor(a: ChainAction): string {
  if (a.kind !== 'call') return 'admin'; // deploy and maintenance updates need the admin's authority key
  if (a.acceptedBy) return a.acceptedBy;
  const c = a.entryPoint ?? '';
  if (ADMIN_CIRCUITS.has(c)) return 'admin';
  const spec = ACTIONS[c as PartyCircuit];
  if (!spec) return 'unknown';
  return spec.callers.length === 1 ? spec.callers[0] : spec.callers.join('|');
}

export function actionName(a: ChainAction): string {
  if (a.kind === 'deploy') return 'deploy';
  if (a.kind === 'call') return a.entryPoint ?? 'call';
  if (a.renounced) return 'renounceAuthority';
  if (a.circuitsAdded?.length && !a.circuitsRemoved?.length) return 'registerCircuits';
  return 'maintenanceUpdate';
}

const RESULT_NOTE: Record<ChainResult, string | undefined> = {
  SUCCESS: undefined,
  PARTIAL_SUCCESS: 'Partially applied on-chain: the guaranteed part succeeded, the fallible part failed.',
  FAILURE: 'Rejected on-chain.'
};

const matches = (e: TxLogEntry, a: ChainAction, contractAddress: string) =>
  e.contractAddress === contractAddress && ((!!e.txHash && e.txHash.toLowerCase() === a.txHash.toLowerCase()) || (!!e.txId && a.identifiers.includes(e.txId)));

export interface ImportResult {
  entries: TxLogEntry[];
  /** New "from chain" entries. */
  added: number;
  /** Local entries completed with chain data (block, result). */
  matched: number;
}

/** Merges the chain's actions for one contract into the log. Pure: returns the new log. */
export function importChainHistory(log: readonly TxLogEntry[], actions: readonly ChainAction[], ctx: { contractAddress: string; network: string; now?: number }): ImportResult {
  let entries = [...log];
  let added = 0;
  let matched = 0;
  const now = ctx.now ?? Date.now();
  // Several actions of one contract can share a transaction; number them for stable ids.
  const seen = new Map<string, number>();
  for (const a of actions) {
    const n = seen.get(a.txHash) ?? 0;
    seen.set(a.txHash, n + 1);
    const status = a.result === 'SUCCESS' ? 'confirmed' : a.result === null ? 'confirmed' : 'failed';
    const note = a.result ? RESULT_NOTE[a.result] : undefined;
    const local = entries.find((e) => e.source !== 'chain' && matches(e, a, ctx.contractAddress));
    if (local) {
      matched++;
      entries = upsertEntry(entries, {
        ...local,
        source: 'both',
        status,
        error: status === 'failed' ? (note ?? local.error) : undefined,
        txHash: a.txHash,
        blockHeight: a.blockHeight,
        fee: a.fee ?? local.fee,
        updatedAt: Math.max(now, local.updatedAt + 1)
      });
      continue;
    }
    const id = `chain-${a.txHash.toLowerCase()}-${n}`;
    const prior = entries.find((e) => e.id === id);
    if (!prior) added++;
    entries = upsertEntry(entries, {
      id,
      session: 'chain',
      source: 'chain',
      at: a.blockTime,
      updatedAt: Math.max(now, (prior?.updatedAt ?? 0) + 1),
      mode: 'wallet',
      network: ctx.network,
      contractAddress: ctx.contractAddress,
      actor: inferActor(a),
      action: actionName(a),
      circuits: a.circuitsAdded?.length ? a.circuitsAdded : undefined,
      status,
      txId: a.identifiers[0],
      txHash: a.txHash,
      blockHeight: a.blockHeight,
      fee: a.fee,
      error: status === 'failed' ? note : undefined
    });
  }
  return { entries, added, matched };
}

/** Port: the chain's history of one contract, oldest first. */
export interface ChainHistorySource {
  contractActions(contractAddress: string, opts?: { signal?: AbortSignal; onProgress?: (count: number) => void }): Promise<{ actions: ChainAction[]; complete: boolean }>;
}
