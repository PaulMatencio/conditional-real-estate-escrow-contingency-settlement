/**
 * Wallet Mode party gateway: every party circuit through midnight-js and the connected wallet (Lace / 1AM), with the
 * private witnesses supplied per call from the local vault (FR-TERMS-06). Proofs go only to the local proof server
 * (NFR-01, see wallet/providers.ts). midnight-js executes the circuit locally before it calls the prover, so an
 * assertion failure surfaces at the "build" step without spending proving time (FR-FUND-04).
 */
import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { Transaction, ZswapChainState } from '@midnightntwrk/ledger-v9';
import type { CallMaterial, CallReceipt, CircuitArgs, DepositCircuit, EscrowPartyGateway } from '@/application/partyPorts';
import { AppError } from '@/domain/errors';
import type { EscrowView } from '@/domain/escrowView';
import { bytesToHex, hexToBytes } from '@/domain/hex';
import type { PartyCircuit } from '@/domain/lifecycle';
import type { WirePrivateTerms } from '@/domain/terms';
import { indexerHttpUrl, networkConfig } from '../config/network';
import { contractArgs, witnessInputs } from '../contract/callArgs';
import { allCircuitIds, makeCompiledContract } from '../contract/compiled';
import { readContractState } from '../contract/chainState';
import { maintenanceOf, toEscrowView, type LedgerInput } from '../contract/view';
import type { PrivateInputs } from '../contract/witnesses';
import type { AppProviders } from '../wallet/providers';
import type { WalletSession } from '../wallet/connector';
import { describeError, foreignCircuits, AdminGateway } from './adminGateway';
import { IndexerChainHistory } from '../indexer/chainHistorySource';

/**
 * The escrow's successful deposit transaction, read from the public chain history. Lets a party who did not deposit
 * (seller, resolver, or the buyer in another browser) find the vault coin without the depositor's help.
 */
export async function findDepositTxHash(contractAddress: string, circuit: DepositCircuit = 'depositToEscrow'): Promise<string | null> {
  const { actions } = await new IndexerChainHistory(indexerHttpUrl(), networkConfig.indexerWS, 60_000).contractActions(contractAddress);
  const deposit = [...actions].reverse().find((a) => a.kind === 'call' && a.entryPoint === circuit && (a.result === 'SUCCESS' || a.result === null));
  return deposit?.txHash ?? null;
}

/** The circuits that ran successfully on this escrow, from its public on-chain history (any party's transactions). */
export async function chainCircuits(contractAddress: string): Promise<Set<string>> {
  const { actions } = await new IndexerChainHistory(indexerHttpUrl(), networkConfig.indexerWS, 60_000).contractActions(contractAddress);
  return new Set(actions.filter((a) => a.kind === 'call' && a.entryPoint && (a.result === 'SUCCESS' || a.result === null)).map((a) => a.entryPoint!));
}

/** Wallet Mode `now` for depositToEscrow / declineLoan / withdrawLoan: 2 minutes behind the wall clock, so the block time is past it. */
const TIME_MARGIN = 120n;
/** Circuits whose transaction leaves exactly one new coin in the contract (refundWithdrawal: the penalty change coin). */
const DEPOSITS: readonly string[] = ['depositToEscrow', 'depositLoan', 'depositTopUp', 'refundWithdrawal'];

type CallTx = Record<string, (...args: unknown[]) => Promise<{ public: { txId: string; txHash: string; blockHeight: number; blockHash?: string; tx?: unknown } }>>;
interface Found {
  callTx: CallTx;
}

const ZERO32 = new Uint8Array(32);

export class PartyGateway implements EscrowPartyGateway {
  readonly mode = 'wallet' as const;
  /** Inputs of the call in flight; the compiled contract's witnesses read them (one call at a time). */
  private current: PrivateInputs = { secretKey: () => ZERO32 };
  private found: Found | null = null;
  private busy = false;

  constructor(
    readonly contractAddress: string,
    private readonly providers: AppProviders,
    private readonly session: WalletSession | null
  ) {}

  private async open(): Promise<Found> {
    if (this.found) return this.found;
    const have = await AdminGateway.registered(this.providers, this.contractAddress);
    const all = allCircuitIds();
    // An escrow deployed by an older build carries circuits this build no longer has (e.g. submitFinancing);
    // midnight-js would fail fetching their keys with a bare 404. Its ledger layout differs too: refuse clearly.
    const foreign = foreignCircuits(have, all);
    if (foreign.length > 0) {
      throw new AppError('CONTRACT_VERSION', `Escrow ${this.contractAddress.slice(0, 10)}… was deployed with an older contract version (circuits unknown to this build: ${foreign.join(', ')}). Archive it in the escrow switcher and use an escrow deployed with the current contract.`);
    }
    const subset = all.every((c) => have.has(c)) ? undefined : all.filter((c) => have.has(c));
    const self = this;
    const compiled = makeCompiledContract(() => self.current.secretKey(), subset, {
      privateTerms: () => (self.current.privateTerms ?? fail('the private terms'))(),
      kycAttestation: () => (self.current.kycAttestation ?? fail('a KYC attestation'))(),
      vaultCoin: () => (self.current.vaultCoin ?? fail('the vault coin'))(),
      secondCoin: () => (self.current.secondCoin ?? fail('the loan or top-up coin'))(),
      lenderTerms: () => (self.current.lenderTerms ?? fail('the lender terms'))(),
      penaltyCoin: () => (self.current.penaltyCoin ?? fail('the penalty coin'))()
    });
    this.found = (await (findDeployedContract as unknown as (p: unknown, o: unknown) => Promise<Found>)(this.providers, { contractAddress: this.contractAddress, compiledContract: compiled })) as Found;
    return this.found;
  }

  async readView(): Promise<EscrowView> {
    const s = await readContractState(this.providers.publicDataProvider, this.contractAddress);
    if (!s) throw new AppError('CONTRACT_REJECTED', 'Contract state not found on this network');
    return toEscrowView(this.contractAddress, s.data as unknown as LedgerInput, maintenanceOf(s));
  }

  /** Wall clock: the node's block time tracks it closely; deadlines are hours/days apart. */
  async now(): Promise<bigint> {
    return BigInt(Math.floor(Date.now() / 1000));
  }

  async call<C extends PartyCircuit>(circuit: C, args: CircuitArgs[C], material: CallMaterial): Promise<CallReceipt> {
    if (this.busy) throw new AppError('VALIDATION', 'Another transaction is in progress. Wait for it to finish.');
    this.busy = true;
    const view = await this.readView();
    const ctx = { contractAddress: this.contractAddress, escrowColor: view.escrowColor, material, now: (await this.now()) - TIME_MARGIN };
    try {
      const found = await this.open();
      const fn = found.callTx[circuit];
      if (!fn) throw new AppError('VALIDATION', `Circuit “${circuit}” is not registered on-chain yet. Ask the admin to register the remaining circuits.`);
      this.current = witnessInputs(ctx);
      const r = await fn(...contractArgs(circuit, args, ctx));
      const receipt: CallReceipt = { txId: String(r.public.txId), txHash: r.public.txHash, blockHeight: r.public.blockHeight, blockHash: r.public.blockHash };
      if (DEPOSITS.includes(circuit) && r.public.tx) {
        // midnight-js 5 returns the finalized transaction as an era-tagged handle; decode it with ledger 9.
        const handle = r.public.tx as { serialize(): Uint8Array };
        const tx = Transaction.deserialize('signature', 'proof', 'binding', handle.serialize()) as unknown as Transaction<never, never, never>;
        // Exact index from the indexer (the transaction's zswapStartIndex); the block-snapshot estimate only as a fallback.
        receipt.vaultIndex =
          (await this.locateCoinIndex(circuit as DepositCircuit, r.public.txHash).catch(() => null)) ??
          (await this.indexFromTx(tx, r.public.blockHash ?? null).catch(() => null)) ??
          undefined;
      }
      return receipt;
    } catch (e) {
      if (e instanceof AppError) throw e;
      console.error(`[${circuit}] failed`); // NFR-07: never log the error object, it can carry witnesses
      throw new AppError('CONTRACT_REJECTED', describeError(e), { cause: e });
    } finally {
      this.current = { secretKey: () => ZERO32 };
      this.busy = false;
    }
  }

  /**
   * Position (0-based) of this contract's new coin among the coins the transaction inserts into the global coin tree,
   * and how many it inserts. Read from the offers themselves (guaranteed offer, then fallible offers by segment; in
   * each, outputs then transients, in their stored order), not by replaying them: a replay on an empty tree rejects
   * the depositor's own inputs ("use of unknown coin tree root …", the root they were spent against).
   */
  private positionInTx(tx: Transaction<never, never, never>): { position: bigint; inserted: bigint } {
    const me = this.contractAddress.toLowerCase();
    const offers = [tx.guaranteedOffer, ...[...(tx.fallibleOffer?.entries() ?? [])].sort(([a], [b]) => a - b).map(([, o]) => o)].filter(Boolean) as {
      outputs: { contractAddress?: string }[];
      transients: { contractAddress?: string }[];
    }[];
    let position: bigint | null = null;
    let inserted = 0n;
    for (const offer of offers) {
      for (const c of [...offer.outputs, ...offer.transients]) {
        if (position === null && c.contractAddress?.toLowerCase() === me) position = inserted;
        inserted += 1n;
      }
    }
    if (position === null) throw new AppError('VALIDATION', "This transaction put no coin into this escrow: it is not this escrow's deposit. Check the hash and that the right escrow is open.");
    return { position, inserted };
  }

  /**
   * FR-FUND-03. Exact: the indexer gives the transaction's first index in the global coin tree (`zswapStartIndex`), and
   * replaying its offers on an empty tree gives the vault coin's position inside it. Index = start + position.
   * Without `range` (older indexer), an estimate from the coin-tree snapshot of the block (validation item V-2: wrong
   * when another transaction in the block inserted coins after it). A wrong index makes the payout prove a path to a
   * root the chain never had: "use of unknown coin tree root".
   */
  private async indexFromTx(tx: Transaction<never, never, never>, blockHash: string | null, range?: { start: number; end: number }): Promise<bigint> {
    const { position, inserted } = this.positionInTx(tx);
    if (range) {
      if (BigInt(range.end - range.start) !== inserted)
        throw new AppError('UNKNOWN', `The deposit inserted ${range.end - range.start} coins on-chain but ${inserted} when replayed (a failed segment?): the index cannot be derived safely. Enter the index the depositor sees.`);
      return BigInt(range.start) + position;
    }
    const cfg = blockHash ? { type: 'blockHash' as const, blockHash } : undefined;
    const both = await this.providers.publicDataProvider.queryZSwapAndContractState(this.contractAddress, cfg as never);
    if (!both) throw new AppError('UNKNOWN', 'The indexer returned no coin-tree state for the deposit block, so the index cannot be computed yet. Retry in a minute, or enter the index the depositor sees.');
    const zswap = (both.zswapChainState as unknown as { deserialize(d: Record<string, unknown>): ZswapChainState }).deserialize({ v9: ZswapChainState });
    return zswap.firstFree - inserted + position;
  }

  async locateVaultIndex(depositTxHash: string | null, _terms: WirePrivateTerms): Promise<bigint | null> {
    return this.locateCoinIndex('depositToEscrow', depositTxHash);
  }

  /**
   * Each deposit circuit (and a withdrawal refund with a penalty) puts exactly one coin into the contract: its
   * transaction gives that coin's index. Throws an AppError saying why when the index cannot be found (callers that
   * only try in passing catch it).
   */
  async locateCoinIndex(circuit: DepositCircuit, txHash: string | null): Promise<bigint | null> {
    let hash = txHash?.trim().toLowerCase().replace(/^0x/, '') || null;
    if (hash && !/^[0-9a-f]{64}$/.test(hash)) throw new AppError('VALIDATION', 'A transaction hash is 64 hexadecimal characters: check what was pasted.');
    if (!hash) {
      hash = await findDepositTxHash(this.contractAddress, circuit).catch((e) => {
        throw new AppError('UNKNOWN', `Could not read this escrow's history from the indexer (${e instanceof Error ? e.message : String(e)}). Check "Health".`);
      });
      if (!hash) throw new AppError('VALIDATION', `No ${circuit} transaction found on-chain for this escrow yet.`);
    }
    const found = await fetchTransaction(hash);
    if (!found) throw new AppError('VALIDATION', `No transaction with this hash or identifier on the ${networkConfig.networkId} indexer. Paste the deposit's transaction hash from the depositor's transaction log.`);
    const tx = Transaction.deserialize('signature', 'proof', 'binding', hexToBytes(found.raw)) as unknown as Transaction<never, never, never>;
    return this.indexFromTx(tx, found.blockHash, found.zswapRange);
  }

  async coinPublicKey(): Promise<string | null> {
    return this.providers.walletProvider.getCoinPublicKey() as unknown as string;
  }

  async shieldedBalance(color: string): Promise<bigint | null> {
    if (!this.session) return null;
    try {
      const balances = await this.session.api.getShieldedBalances();
      const want = color.toLowerCase();
      for (const [k, v] of Object.entries(balances)) if (k.toLowerCase().replace(/^0x/, '').endsWith(want)) return v;
      return 0n;
    } catch {
      return null;
    }
  }
}

const fail = (what: string) => (): never => {
  throw new AppError('MISSING_MATERIAL', `This action needs ${what}, which this browser does not hold.`);
};

/**
 * Indexer lookup of a transaction (same query shape midnight-js uses), by hash, then by identifier: wallets and logs
 * show one or the other, and both are 64 hex. Also returns the transaction's range in the global coin tree
 * (`zswapStartIndex`..`zswapEndIndex`) when the indexer reports it. Null when the indexer knows neither; throws when it
 * cannot be asked.
 */
export async function fetchTransaction(hashOrId: string): Promise<{ raw: string; blockHash: string; blockHeight: number; zswapRange?: { start: number; end: number } } | null> {
  const withRange = `query TX($offset: TransactionOffset!) { transactions(offset: $offset) { raw hash block { height hash } ... on RegularTransaction { zswapStartIndex zswapEndIndex } } }`;
  const plain = `query TX($offset: TransactionOffset!) { transactions(offset: $offset) { raw hash block { height hash } } }`;
  const value = hashOrId.trim().toLowerCase().replace(/^0x/, '');
  type Row = { raw: string; block: { height: number; hash: string }; zswapStartIndex?: number; zswapEndIndex?: number };
  const ask = async (query: string, offset: Record<string, string>) => {
    const res = await fetch(indexerHttpUrl(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, variables: { offset } }) });
    if (!res.ok) throw new AppError('UNKNOWN', `The indexer did not answer the transaction lookup (HTTP ${res.status}). Check "Health".`);
    return (await res.json()) as { data?: { transactions?: Row[] }; errors?: { message: string }[] };
  };
  const offsets: Record<string, string>[] = [{ hash: value }, { identifier: value }];
  for (const offset of offsets) {
    let j = await ask(withRange, offset);
    // An indexer without the zswap index fields rejects the whole query: ask again without them.
    if (!j.data && j.errors?.some((e) => /zswap(Start|End)Index|RegularTransaction/.test(e.message))) j = await ask(plain, offset);
    const t = j.data?.transactions?.[0];
    if (t) {
      const zswapRange = typeof t.zswapStartIndex === 'number' && typeof t.zswapEndIndex === 'number' ? { start: t.zswapStartIndex, end: t.zswapEndIndex } : undefined;
      return { raw: t.raw, blockHash: t.block.hash, blockHeight: t.block.height, zswapRange };
    }
  }
  return null;
}

export { bytesToHex };
