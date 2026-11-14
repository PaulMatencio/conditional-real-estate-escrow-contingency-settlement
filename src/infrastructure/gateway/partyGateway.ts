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
import { describeError, AdminGateway } from './adminGateway';
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
        receipt.vaultIndex = (await this.indexFromTx(tx, r.public.blockHash ?? null).catch(() => null)) ?? undefined;
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
   * FR-FUND-03 (validation item V-2). The deposit transaction inserts its outputs into the global commitment tree in
   * order (guaranteed offer, then fallible segments). Replaying those offers on an empty tree with this contract as the
   * only tracked address gives the vault coin's position within the transaction; the indexer's Zswap state right after
   * the deposit gives `firstFree`. Index = firstFree − (outputs inserted by the tx) + position. Assumes no later
   * transaction in the same block inserted coins before the indexer snapshot; verify on the preview network.
   */
  private async indexFromTx(tx: Transaction<never, never, never>, blockHash: string | null): Promise<bigint | null> {
    let local = new ZswapChainState();
    const whitelist = new Set([this.contractAddress]);
    let position: bigint | null = null;
    let inserted = 0n;
    const offers = [tx.guaranteedOffer, ...[...(tx.fallibleOffer?.entries() ?? [])].sort(([a], [b]) => a - b).map(([, o]) => o)].filter(Boolean);
    for (const offer of offers) {
      const before = local.firstFree;
      const [next, map] = local.tryApply(offer as never, whitelist as never);
      for (const idx of map.values()) if (position === null) position = idx;
      inserted += next.firstFree - before;
      local = next;
    }
    if (position === null) return null;
    const cfg = blockHash ? { type: 'blockHash' as const, blockHash } : undefined;
    const both = await this.providers.publicDataProvider.queryZSwapAndContractState(this.contractAddress, cfg as never);
    if (!both) return null;
    const zswap = (both.zswapChainState as unknown as { deserialize(d: Record<string, unknown>): ZswapChainState }).deserialize({ v9: ZswapChainState });
    return zswap.firstFree - inserted + position;
  }

  async locateVaultIndex(depositTxHash: string | null, _terms: WirePrivateTerms): Promise<bigint | null> {
    return this.locateCoinIndex('depositToEscrow', depositTxHash);
  }

  /** Each deposit circuit (and a withdrawal refund with a penalty) puts exactly one coin into the contract: its transaction gives that coin's index. */
  async locateCoinIndex(circuit: DepositCircuit, txHash: string | null): Promise<bigint | null> {
    const hash = txHash ?? (await findDepositTxHash(this.contractAddress, circuit).catch(() => null));
    if (!hash) return null;
    const found = await fetchTransaction(hash);
    if (!found) return null;
    const tx = Transaction.deserialize('signature', 'proof', 'binding', hexToBytes(found.raw)) as unknown as Transaction<never, never, never>;
    return this.indexFromTx(tx, found.blockHash);
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

/** Indexer lookup of a transaction by hash (same query shape midnight-js uses). */
export async function fetchTransaction(hash: string): Promise<{ raw: string; blockHash: string; blockHeight: number } | null> {
  const query = `query TX($offset: TransactionOffset!) { transactions(offset: $offset) { raw hash block { height hash } } }`;
  const res = await fetch(indexerHttpUrl(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables: { offset: { hash: hash.replace(/^0x/, '') } } })
  });
  if (!res.ok) return null;
  const j = (await res.json()) as { data?: { transactions?: { raw: string; block: { height: number; hash: string } }[] } };
  const t = j.data?.transactions?.[0];
  return t ? { raw: t.raw, blockHash: t.block.hash, blockHeight: t.block.height } : null;
}

export { bytesToHex };
