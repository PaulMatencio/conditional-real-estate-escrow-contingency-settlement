/**
 * Simulator Mode (FR-WALLET-04): runs the compiled escrow contract in the browser with @midnight-ntwrk/compact-runtime.
 * No wallet, node or proof server: instant role switching, a settable block time and simulated shielded inputs/outputs.
 * The same EscrowPartyGateway port as the chain, so every page works identically in both modes.
 * Not a substitute for preview-network tests: no Zswap balancing, no Merkle proofs, no fees (shielded-token.md O-8).
 */
import * as rt from '@midnight-ntwrk/compact-runtime';
import type { CallMaterial, CallReceipt, CircuitArgs, EscrowPartyGateway, ShieldedEffects } from '@/application/partyPorts';
import { withTxLog, type TxLogger } from '@/application/txLog';
import { AppError } from '@/domain/errors';
import type { ConfigureTerms, DeployParams } from '@/domain/escrow';
import type { EscrowView } from '@/domain/escrowView';
import { bytesToHex, hex32ToBytes } from '@/domain/hex';
import type { PartyCircuit } from '@/domain/lifecycle';
import { contractArgs, witnessInputs } from '../contract/callArgs';
import { Contract } from '../contract/module';
import { toEscrowView, type LedgerInput } from '../contract/view';
import { createWitnesses, type PrivateInputs } from '../contract/witnesses';

type Maybe<T> = { is_some: boolean; value: T };
const some = <T,>(value: T): Maybe<T> => ({ is_some: true, value });
const none = <T,>(value: T): Maybe<T> => ({ is_some: false, value });
const ZERO32 = new Uint8Array(32);
const CPK = '00'.repeat(32);

/** Constructor / configure Maybe<…> arguments, in contract order. */
export function maybeTermsArgs(t: ConfigureTerms): unknown[] {
  const id = (h?: string) => (h ? some(hex32ToBytes(h)) : none(ZERO32));
  const n = (v?: bigint) => (v !== undefined ? some(v) : none(0n));
  return [
    id(t.inspector),
    id(t.lender),
    id(t.titleAgent),
    id(t.resolver),
    id(t.buyerPayoutCommitment),
    id(t.sellerPayoutCommitment),
    id(t.amountCommitment),
    n(t.closingDeadline),
    n(t.disputeDeadline),
    t.kycPolicy ? some({ minKycLevel: BigInt(t.kycPolicy.minKycLevel), maxAmlRiskScore: BigInt(t.kycPolicy.maxAmlRiskScore) }) : none({ minKycLevel: 0n, maxAmlRiskScore: 0n })
  ];
}

interface ZswapLike {
  inputs?: { nonce: Uint8Array; color: Uint8Array; value: bigint }[];
  outputs?: { coinInfo: { nonce: Uint8Array; color: Uint8Array; value: bigint }; recipient: { is_left: boolean; left: { bytes: Uint8Array }; right: { bytes: Uint8Array } } }[];
}

export class EscrowSimulator {
  readonly contractAddress: string;
  private state: unknown;
  private inputs: PrivateInputs = { secretKey: () => ZERO32 };
  private readonly contract: Contract<undefined>;
  private counter = 0;
  /** Simulated block time, unix seconds. */
  time: number;
  readonly log: { at: number; circuit: string; txHash: string; round: string; shielded?: ShieldedEffects }[] = [];
  private listeners = new Set<() => void>();

  /**
   * compact-runtime 0.21 (compiler 0.36) runs the constructor and every circuit asynchronously, so the simulator is
   * built with the async factory `EscrowSimulator.create(...)`.
   */
  private constructor(opts: { time?: number; contractAddress?: string }) {
    this.contractAddress = opts.contractAddress ?? rt.sampleContractAddress();
    this.time = opts.time ?? Math.floor(Date.now() / 1000);
    // Witnesses read the per-call inputs, so one Contract instance serves every role.
    const self = this;
    this.contract = new Contract<undefined>(
      createWitnesses({
        secretKey: () => self.inputs.secretKey(),
        privateTerms: () => (self.inputs.privateTerms ?? missing('the private terms'))(),
        kycAttestation: () => (self.inputs.kycAttestation ?? missing('a KYC attestation'))(),
        vaultCoin: () => (self.inputs.vaultCoin ?? missing('the vault coin'))()
      })
    );
  }

  static async create(params: DeployParams, opts: { time?: number; contractAddress?: string } = {}): Promise<EscrowSimulator> {
    const sim = new EscrowSimulator(opts);
    const r = await (sim.contract.initialState as unknown as (...a: unknown[]) => Promise<{ currentContractState: unknown }>)(
      rt.createConstructorContext(undefined, CPK),
      hex32ToBytes(params.adminRoleId),
      hex32ToBytes(params.buyerRoleId),
      hex32ToBytes(params.sellerRoleId),
      hex32ToBytes(params.tokenColor),
      params.ticker,
      ...maybeTermsArgs(params.terms ?? {})
    );
    sim.state = (r.currentContractState as unknown as { data: unknown }).data;
    sim.record('constructor', undefined);
    return sim;
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  private emit() {
    this.listeners.forEach((l) => l());
  }

  view(): EscrowView {
    return toEscrowView(this.contractAddress, this.state as LedgerInput);
  }

  setTime(sec: number) {
    this.time = Math.floor(sec);
    this.emit();
  }

  private record(circuit: string, shielded: ShieldedEffects | undefined): CallReceipt {
    this.counter++;
    const txHash = `sim-${this.counter.toString().padStart(4, '0')}-${circuit}`;
    this.log.push({ at: this.time, circuit, txHash, round: this.view().lifecycleRound.toString(), shielded });
    return { txId: txHash, txHash, blockHeight: this.counter, shielded };
  }

  // Calls are serialized: the witnesses read `this.inputs`, which must not change while a circuit is running.
  private queue: Promise<unknown> = Promise.resolve();

  /** Runs any impure circuit (admin ones included) with the given private inputs. */
  run(circuit: string, args: unknown[], inputs: PrivateInputs): Promise<CallReceipt> {
    const next = this.queue.then(() => this.runNow(circuit, args, inputs));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async runNow(circuit: string, args: unknown[], inputs: PrivateInputs): Promise<CallReceipt> {
    type Ctx = { queryContexts: Record<string, { state: unknown }>; zswapLocalStates: Record<string, ZswapLike> };
    const fn = (this.contract.impureCircuits as unknown as Record<string, (ctx: unknown, ...a: unknown[]) => Promise<{ context: Ctx }>>)[circuit];
    if (!fn) throw new AppError('VALIDATION', `Unknown circuit ${circuit}`);
    this.inputs = inputs;
    try {
      const ctx = rt.createCircuitContext({
        circuitId: circuit as never,
        contractAddress: this.contractAddress,
        coinPublicKeyOrZswapState: CPK,
        contractState: this.state as never,
        privateState: undefined,
        time: this.time
      });
      const r = await fn(ctx, ...args);
      this.state = r.context.queryContexts[this.contractAddress].state;
      const receipt = this.record(circuit, effects(r.context.zswapLocalStates[this.contractAddress]));
      this.emit();
      return receipt;
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError('CONTRACT_REJECTED', (e as Error).message, { cause: e });
    } finally {
      this.inputs = { secretKey: () => ZERO32 };
    }
  }

  /** Persistent transaction log for the admin helpers below (party calls are logged by the party use-case). */
  logger?: TxLogger;

  private adminRun(circuit: string, args: unknown[], sk: Uint8Array) {
    return withTxLog(this.logger, { mode: 'simulator', network: 'simulator', contractAddress: this.contractAddress, actor: 'admin', action: circuit }, () =>
      this.run(circuit, args, { secretKey: () => sk })
    );
  }

  /** Admin helpers for Simulator Mode setup. */
  configure(sk: Uint8Array, terms: ConfigureTerms) {
    return this.adminRun('configure', maybeTermsArgs(terms), sk);
  }
  addKycIssuer(sk: Uint8Array, issuerId: string, publicKey: { x: string; y: string }) {
    return this.adminRun('addKycIssuer', [hex32ToBytes(issuerId), { x: BigInt(publicKey.x), y: BigInt(publicKey.y) }], sk);
  }
  finalize(sk: Uint8Array) {
    return this.adminRun('finalizeInitialization', [], sk);
  }

  gateway(coinPublicKey: string | null = null): EscrowPartyGateway {
    const sim = this;
    return {
      mode: 'simulator',
      contractAddress: sim.contractAddress,
      readView: async () => sim.view(),
      now: async () => BigInt(sim.time),
      async call<C extends PartyCircuit>(circuit: C, args: CircuitArgs[C], material: CallMaterial): Promise<CallReceipt> {
        const v = sim.view();
        const ctx = { contractAddress: sim.contractAddress, escrowColor: v.escrowColor, material };
        const receipt = await sim.run(circuit, contractArgs(circuit, args, ctx), witnessInputs(ctx));
        // The simulator has no Merkle tree: the single contract-owned coin is index 0.
        return circuit === 'depositToEscrow' ? { ...receipt, vaultIndex: 0n } : receipt;
      },
      locateVaultIndex: async () => 0n,
      coinPublicKey: async () => coinPublicKey,
      shieldedBalance: async () => null
    };
  }
}

const missing = (what: string) => (): never => {
  throw new AppError('MISSING_MATERIAL', `This action needs ${what}, which was not supplied.`);
};

function effects(z: ZswapLike | undefined): ShieldedEffects | undefined {
  if (!z) return undefined;
  const ins = z.inputs ?? [];
  const outs = z.outputs ?? [];
  if (!ins.length && !outs.length) return undefined;
  return {
    inputs: ins.map((i) => ({ nonce: bytesToHex(i.nonce), color: bytesToHex(i.color), value: i.value.toString() })),
    outputs: outs.map((o) => ({
      nonce: bytesToHex(o.coinInfo.nonce),
      color: bytesToHex(o.coinInfo.color),
      value: o.coinInfo.value.toString(),
      recipient: bytesToHex(o.recipient.is_left ? o.recipient.left.bytes : o.recipient.right.bytes),
      recipientIsContract: !o.recipient.is_left
    }))
  };
}
