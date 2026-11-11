/**
 * Reads an escrow's full on-chain history from the Midnight indexer (GraphQL v4): the `contractActions` subscription
 * replays every action of the contract from block 0 (deploy, calls, maintenance updates), then would continue live.
 * We stop once the latest action (asked for first over HTTP) has arrived. Public data only; no wallet needed.
 *
 * Each action carries the contract state right after it. Comparing consecutive states tells which circuits a
 * maintenance update registered, whether it renounced the authority, and who accepted the configuration.
 */
import * as rt from '@midnight-ntwrk/compact-runtime';
import { createClient } from 'graphql-ws';
import type { ChainAction, ChainHistorySource, ChainResult } from '@/application/chainHistory';
import { ledger } from '../contract/module';

/** One `contractActions` item as returned by the indexer. */
export interface RawContractAction {
  __typename: 'ContractDeploy' | 'ContractCall' | 'ContractUpdate';
  entryPoint?: string;
  state?: string;
  transaction: {
    hash: string;
    block: { height: number; timestamp: number };
    identifiers?: string[];
    fee?: string | null;
    transactionResult?: { status: ChainResult } | null;
  };
}

const FIELDS = `
  __typename
  state
  ... on ContractCall { entryPoint }
  transaction {
    hash
    block { height timestamp }
    ... on RegularTransaction { identifiers fee transactionResult { status } }
  }`;

/** What the history needs from a decoded contract state. */
export interface StateFacts {
  operations: Set<string>;
  committeeSize: number;
  buyerAccepted: boolean;
  sellerAccepted: boolean;
}

/** Decodes a state with the contract's own runtime (ledger 9). Null if it cannot be read (other era / format). */
export function decodeStateFacts(hex: string | undefined): StateFacts | null {
  if (!hex) return null;
  try {
    const s = rt.ContractState.deserialize(Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16))));
    const L = ledger(s.data);
    return {
      operations: new Set(s.operations().map((o: unknown) => (typeof o === 'string' ? o : new TextDecoder().decode(o as Uint8Array)))),
      committeeSize: s.maintenanceAuthority.committee.length,
      buyerAccepted: L.buyerAccepted,
      sellerAccepted: L.sellerAccepted
    };
  } catch {
    return null;
  }
}

/** Turns raw indexer actions (oldest first) into ChainActions, deriving what each one changed. */
export function deriveActions(raw: readonly RawContractAction[], decode: (hex: string | undefined) => StateFacts | null = decodeStateFacts): ChainAction[] {
  let prev: StateFacts | null = null;
  return raw.map((r) => {
    const cur = decode(r.state);
    const kind = r.__typename === 'ContractDeploy' ? 'deploy' : r.__typename === 'ContractCall' ? 'call' : 'update';
    const a: ChainAction = {
      kind,
      entryPoint: r.entryPoint ?? undefined,
      txHash: r.transaction.hash,
      identifiers: r.transaction.identifiers ?? [],
      blockHeight: r.transaction.block.height,
      blockTime: r.transaction.block.timestamp,
      result: r.transaction.transactionResult?.status ?? null,
      fee: r.transaction.fee ?? undefined
    };
    if (kind === 'deploy' && cur) a.circuitsAdded = [...cur.operations].sort();
    if (kind === 'update' && prev && cur) {
      a.circuitsAdded = [...cur.operations].filter((o) => !prev!.operations.has(o)).sort();
      a.circuitsRemoved = [...prev.operations].filter((o) => !cur.operations.has(o)).sort();
      a.renounced = prev.committeeSize > 0 && cur.committeeSize === 0;
    }
    if (kind === 'call' && r.entryPoint === 'acceptConfiguration' && prev && cur) {
      if (!prev.buyerAccepted && cur.buyerAccepted) a.acceptedBy = 'buyer';
      else if (!prev.sellerAccepted && cur.sellerAccepted) a.acceptedBy = 'seller';
    }
    if (cur) prev = cur;
    return a;
  });
}

export class IndexerChainHistory implements ChainHistorySource {
  constructor(
    private readonly httpUrl: string,
    private readonly wsUrl: string,
    private readonly timeoutMs = 120_000
  ) {}

  private async latestHash(address: string): Promise<string | null> {
    const res = await fetch(this.httpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'query LATEST($a: HexEncoded!) { contractAction(address: $a) { transaction { hash } } }', variables: { a: address } })
    });
    if (!res.ok) throw new Error(`Indexer HTTP ${res.status}`);
    const j = (await res.json()) as { data?: { contractAction?: { transaction: { hash: string } } | null }; errors?: { message: string }[] };
    if (j.errors?.length) throw new Error(`Indexer: ${j.errors[0].message}`);
    return j.data?.contractAction?.transaction.hash ?? null;
  }

  async contractActions(address: string, opts: { signal?: AbortSignal; onProgress?: (count: number) => void } = {}): Promise<{ actions: ChainAction[]; complete: boolean }> {
    const addr = address.toLowerCase().replace(/^0x/, '');
    const latest = await this.latestHash(addr);
    if (!latest) return { actions: [], complete: true };
    const raw: RawContractAction[] = [];
    const client = createClient({ url: this.wsUrl, lazy: true, retryAttempts: 2 });
    let complete = false;
    try {
      await new Promise<void>((resolve, reject) => {
        let settleTimer: ReturnType<typeof setTimeout> | null = null;
        const finish = (ok: boolean, err?: unknown) => {
          clearTimeout(overall);
          if (settleTimer) clearTimeout(settleTimer);
          opts.signal?.removeEventListener('abort', onAbort);
          unsubscribe();
          if (ok) resolve();
          else reject(err);
        };
        const overall = setTimeout(() => finish(true), this.timeoutMs); // partial history: complete stays false
        const onAbort = () => finish(false, new DOMException('Import cancelled', 'AbortError'));
        opts.signal?.addEventListener('abort', onAbort);
        const unsubscribe = client.subscribe<{ contractActions: RawContractAction }>(
          { query: `subscription HISTORY($a: HexEncoded!) { contractActions(address: $a, offset: { height: 0 }) { ${FIELDS} } }`, variables: { a: addr } },
          {
            next: (msg) => {
              if (msg.errors?.length) return finish(false, new Error(`Indexer: ${msg.errors[0].message}`));
              const a = msg.data?.contractActions;
              if (!a) return;
              raw.push(a);
              opts.onProgress?.(raw.length);
              // The latest transaction may hold more than one action of this contract: wait briefly for the rest.
              if (a.transaction.hash === latest && !settleTimer) {
                complete = true;
                settleTimer = setTimeout(() => finish(true), 750);
              }
            },
            error: (e) => finish(false, e instanceof Error ? e : new Error(`Indexer subscription failed: ${JSON.stringify(e)}`)),
            complete: () => {
              complete = true;
              finish(true);
            }
          }
        );
      });
    } finally {
      void client.dispose();
    }
    raw.sort((x, y) => x.transaction.block.height - y.transaction.block.height);
    return { actions: deriveActions(raw), complete };
  }
}
