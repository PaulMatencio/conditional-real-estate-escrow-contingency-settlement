/**
 * Admin-side adapter: deploys the escrow contract in stages and administers its initialization through
 * midnight-js and the connected wallet (Lace / 1AM). Mirrors the staged-deploy pattern of the token workspace.
 */
import { deployContract, findDeployedContract, submitTx } from '@midnight-ntwrk/midnight-js-contracts';
import { ContractMaintenanceAuthority, ContractOperationVersionedVerifierKey, Intent, MaintenanceUpdate, ReplaceAuthority, Transaction, VerifierKeyInsert, signData, signatureVerifyingKey } from '@midnightntwrk/ledger-v9';
import { authorityLevel } from '@/domain/escrowView';
import { maintenanceOf } from '../contract/view';
import { signingKeyCapture } from '../storage/privateStateProvider';
import { toSigningKey, verifyingKeyId } from '../storage/signingKeyCodec';
import { sharedVault, vaultSigningKeys } from '../storage/vaultInstance';
import { LedgerTransaction, SucceedEntirely } from '@midnight-ntwrk/midnight-js-types';
import { operationNames, readContractState, type ChainContractState } from '../contract/chainState';
import { AppError, compactText, deepMessage } from '@/domain/errors';
import { bytesToHex, hex32ToBytes } from '@/domain/hex';
import type { AdminState, ConfigureTerms, DeployParams, TxReceipt } from '@/domain/escrow';
import { contractConfig } from '../config/network';
import { allCircuitIds, makeCompiledContract } from '../contract/compiled';
import { InitAttribute, ledger } from '../contract/module';
import { randomBytes } from '../crypto/identity';
import { shortError, withTxLog, type TxLogStart } from '@/application/txLog';
import { sharedTxLog } from '../storage/txLogStore';
import type { AppProviders } from '../wallet/providers';

type CallTx = Record<string, (...args: unknown[]) => Promise<{ public: { txId: string; txHash: string; blockHeight: number } }>>;
interface Found {
  callTx: CallTx;
  deployTxData: { public: { contractAddress: string; txId: string; txHash: string; blockHeight: number } };
}

type Maybe<T> = { is_some: boolean; value: T };
const some = <T,>(value: T): Maybe<T> => ({ is_some: true, value });
const none = <T,>(value: T): Maybe<T> => ({ is_some: false, value });
const ZERO32 = new Uint8Array(32);

/** Walks the cause chain: midnight-js wraps the real failure (proof server, wallet, node) several layers deep. */
export function describeError(e: unknown): string {
  const parts: string[] = [];
  for (let c: unknown = e, i = 0; c && i < 5; i++) {
    parts.push(c instanceof Error ? `${c.name}: ${c.message}` : typeof c === 'object' ? deepMessage(c).join(' ← ') : String(c));
    c = (c as { cause?: unknown }).cause;
  }
  const kept = parts.filter((part, i) => !parts.slice(0, i).some((outer) => outer.includes(part.replace(/^[A-Za-z]*Error: /, ''))));
  return compactText(kept.join(' ← '));
}

const toReceipt = (r: { public: { txId: string; txHash: string; blockHeight: number } }): TxReceipt => ({
  txId: String(r.public.txId),
  txHash: r.public.txHash,
  blockHeight: r.public.blockHeight
});

/** Circuits registered on-chain that this build does not know (a different contract version). */
export const foreignCircuits = (registered: Iterable<string>, known: readonly string[]): string[] => [...registered].filter((c) => !known.includes(c));

/** The `Maybe<…>` arguments of the constructor / `configure`, in contract order. */
function maybeTerms(t: ConfigureTerms) {
  const id = (h?: string) => (h ? some(hex32ToBytes(h, 'role id')) : none(ZERO32));
  const n = (v?: bigint) => (v !== undefined ? some(v) : none(0n));
  return [
    id(t.inspector),
    id(t.lender),
    id(t.titleAgent),
    id(t.resolver),
    t.buyerPayoutCommitment ? some(hex32ToBytes(t.buyerPayoutCommitment, 'buyer payout commitment')) : none(ZERO32),
    t.sellerPayoutCommitment ? some(hex32ToBytes(t.sellerPayoutCommitment, 'seller payout commitment')) : none(ZERO32),
    t.amountCommitment ? some(hex32ToBytes(t.amountCommitment, 'amount commitment')) : none(ZERO32),
    n(t.closingDeadline),
    n(t.disputeDeadline),
    t.kycPolicy ? some({ minKycLevel: BigInt(t.kycPolicy.minKycLevel), maxAmlRiskScore: BigInt(t.kycPolicy.maxAmlRiskScore) }) : none({ minKycLevel: 0n, maxAmlRiskScore: 0n })
  ];
}

export class AdminGateway {
  private constructor(
    readonly contractAddress: string,
    private found: Found,
    private readonly providers: AppProviders,
    private readonly getSecretKey: () => Uint8Array
  ) {}

  /** Circuit names whose verifier key is currently registered on-chain. */
  static async registered(providers: AppProviders, address: string): Promise<Set<string>> {
    const s = await readContractState(providers.publicDataProvider, address);
    if (!s) throw new AppError('CONTRACT_REJECTED', 'Contract state not found on this network');
    return operationNames(s);
  }

  /**
   * Opens the contract with exactly the circuits registered on-chain: midnight-js verifies that every circuit of the
   * definition it is given has a matching on-chain verifier key, so a staged deploy needs the subset until all keys exist.
   */
  private static async open(providers: AppProviders, address: string, getSecretKey: () => Uint8Array): Promise<Found> {
    const have = await AdminGateway.registered(providers, address);
    const all = allCircuitIds();
    const foreign = foreignCircuits(have, all);
    if (foreign.length > 0) {
      throw new AppError('CONTRACT_VERSION', `Contract ${address.slice(0, 10)}… is a different version of this escrow (circuits unknown to this build: ${foreign.join(', ')}). Nothing was changed.`);
    }
    const subset = all.every((c) => have.has(c)) ? undefined : all.filter((c) => have.has(c));
    return (await (findDeployedContract as unknown as (p: unknown, o: unknown) => Promise<Found>)(providers, {
      contractAddress: address,
      compiledContract: makeCompiledContract(getSecretKey, subset)
    })) as Found;
  }

  static async deploy(
    providers: AppProviders,
    params: DeployParams,
    getSecretKey: () => Uint8Array
  ): Promise<{ gateway: AdminGateway; receipt: TxReceipt }> {
    // Only the Initializing-phase circuits' verifier keys go into the deploy transaction (contractConfig.deployCircuits).
    const compiledContract = makeCompiledContract(getSecretKey, params.deployCircuits ?? contractConfig.deployCircuits);
    // The deploy creates the contract's maintenance-authority key; it is only ever stored in the encrypted vault.
    if (!sharedVault().unlocked) throw new AppError('VALIDATION', 'Unlock the vault before deploying: the contract authority key created by the deploy is stored only in the encrypted vault.');
    signingKeyCapture.on = true;
    // Persistent log: pending now, then confirmed with the new address (even if opening it afterwards fails) or failed.
    const log = sharedTxLog();
    const logId = log.begin({ mode: 'wallet', network: providers.config.networkId, contractAddress: null, actor: 'admin', action: 'deploy', circuits: [...(params.deployCircuits ?? contractConfig.deployCircuits)] });
    let logged = false;
    try {
      const deployed = (await (deployContract as unknown as (p: unknown, o: unknown) => Promise<Found>)(providers, {
        compiledContract,
        args: [
          hex32ToBytes(params.adminRoleId, 'admin role id'),
          hex32ToBytes(params.buyerRoleId, 'buyer role id'),
          hex32ToBytes(params.sellerRoleId, 'seller role id'),
          hex32ToBytes(params.tokenColor, 'token color'),
          params.ticker,
          ...maybeTerms(params.terms ?? {})
        ]
      })) as Found;
      const d = deployed.deployTxData.public;
      log.finish(logId, { status: 'confirmed', contractAddress: d.contractAddress, txId: String(d.txId), txHash: d.txHash, blockHeight: d.blockHeight });
      logged = true;
      let gateway: AdminGateway;
      try {
        gateway = await AdminGateway.connect(providers, d.contractAddress, getSecretKey);
      } catch (e) {
        // The deploy itself succeeded; never lose the address.
        throw new AppError('CONTRACT_REJECTED', `Contract deployed at ${d.contractAddress} (tx ${d.txHash}), but opening it failed: ${describeError(e)}. Attach to that address to continue.`, { cause: e });
      }
      return { gateway, receipt: { txId: String(d.txId), txHash: d.txHash, blockHeight: d.blockHeight } };
    } catch (e) {
      if (!logged) log.finish(logId, { status: 'failed', error: shortError(e) });
      if (e instanceof AppError) throw e;
      console.error('[deploy] failed', e);
      throw new AppError('CONTRACT_REJECTED', describeError(e), { cause: e });
    } finally {
      signingKeyCapture.on = false;
    }
  }

  static async connect(providers: AppProviders, contractAddress: string, getSecretKey: () => Uint8Array): Promise<AdminGateway> {
    const found = await AdminGateway.open(providers, contractAddress, getSecretKey);
    return new AdminGateway(contractAddress, found, providers, getSecretKey);
  }

  /** Public state of the contract, decoded (what the details panel shows). */
  static async readState(providers: AppProviders, address: string): Promise<AdminState> {
    const s = await readContractState(providers.publicDataProvider, address);
    if (!s) throw new AppError('CONTRACT_REJECTED', 'Contract state not found on this network');
    const L = ledger(s.data);
    const hex = (b: Uint8Array) => bytesToHex(b);
    const configured = new Set([...L.configured]);
    const have = await AdminGateway.registered(providers, address);
    const all = allCircuitIds();
    return {
      contractAddress: address,
      status: L.status,
      ticker: L.escrowTicker,
      tokenColor: hex(L.escrowColor),
      configVersion: L.configVersion,
      buyerAccepted: L.buyerAccepted,
      sellerAccepted: L.sellerAccepted,
      closingDeadline: L.closingDeadline,
      disputeDeadline: L.disputeDeadline,
      roles: {
        admin: hex(L.adminId),
        buyer: hex(L.buyerId),
        seller: hex(L.sellerId),
        inspector: configured.has(InitAttribute.Inspector) ? hex(L.inspectorId) : null,
        lender: configured.has(InitAttribute.Lender) ? hex(L.lenderId) : null,
        titleAgent: configured.has(InitAttribute.TitleAgent) ? hex(L.titleAgentId) : null,
        resolver: configured.has(InitAttribute.Resolver) ? hex(L.resolverId) : null
      },
      configured: [...configured].map((a) => InitAttribute[a as number] ?? String(a)),
      missingAttributes: Object.keys(InitAttribute)
        .filter((k) => Number.isNaN(Number(k)))
        .filter((k) => !configured.has(InitAttribute[k as keyof typeof InitAttribute])),
      registeredCircuits: [...have].sort(),
      missingCircuits: all.filter((c) => !have.has(c)),
      maintenance: maintenanceOf(s)
    };
  }

  /** Whether the authority key held in this browser is a member of the on-chain maintenance committee. */
  async authorityKeyStatus(): Promise<'match' | 'mismatch' | 'missing' | 'renounced'> {
    const s = await readContractState(this.providers.publicDataProvider, this.contractAddress);
    if (!s) throw new AppError('CONTRACT_REJECTED', 'Contract state not found on this network');
    if (authorityLevel(maintenanceOf(s)) === 'immutable') return 'renounced';
    const key = await vaultSigningKeys(sharedVault()).load(this.contractAddress);
    if (!key) return 'missing';
    // Compare by value: ledger 9 keys are tagged objects, and String() of two objects is always "[object Object]".
    const vk = verifyingKeyId(signatureVerifyingKey(toSigningKey(key) as never));
    return s.maintenanceAuthority.committee.some((k: unknown) => verifyingKeyId(k) === vk) ? 'match' : 'mismatch';
  }

  /**
   * Recommendation 1 (contract/delay-init.md): make the contract immutable by replacing the maintenance authority with
   * an empty committee (threshold 1, which no one can reach — the ledger's own "no authority" default). Irreversible:
   * no verifier key can ever be added, removed or replaced afterwards. Requires every circuit to be registered.
   * On success the now-useless authority key is deleted from the vault.
   */
  /** The log entry every transaction of this gateway starts with. */
  private logStart(action: string, circuits?: string[]): TxLogStart {
    return { mode: 'wallet', network: this.providers.config.networkId, contractAddress: this.contractAddress, actor: 'admin', action, circuits };
  }

  renounceAuthority(): Promise<TxReceipt> {
    return withTxLog(sharedTxLog(), this.logStart('renounceAuthority'), () => this.renounceAuthorityTx());
  }

  private async renounceAuthorityTx(): Promise<TxReceipt> {
    const missing = await this.missingCircuits();
    if (missing.length) throw new AppError('VALIDATION', `Register every circuit first (missing: ${missing.join(', ')}). After renouncing, no circuit can ever be added.`);
    const state = await readContractState(this.providers.publicDataProvider, this.contractAddress);
    if (!state) throw new AppError('CONTRACT_REJECTED', 'Contract state not found on this network');
    if (authorityLevel(maintenanceOf(state)) === 'immutable') return { txId: '', txHash: '(already immutable)' };
    const status = await this.authorityKeyStatus();
    if (status !== 'match') throw new AppError('VALIDATION', status === 'missing' ? 'No authority key for this contract in the vault. Import it on the Keys tab.' : 'The authority key in the vault is not the on-chain maintenance authority.');
    const key = (await vaultSigningKeys(sharedVault()).load(this.contractAddress))!;
    const counter = state.maintenanceAuthority.counter;
    const unsigned = new MaintenanceUpdate(this.contractAddress, [new ReplaceAuthority(new ContractMaintenanceAuthority([], 1, counter + 1n))], counter);
    const update = unsigned.addSignature(0n, signData(toSigningKey(key) as never, unsigned.dataToSign));
    const unprovenTx = this.maintenanceTx(update);
    try {
      const submit = (submitTx as unknown as (p: unknown, o: unknown) => Promise<{ status: string; txId?: string; txHash: string; blockHeight: number }>)(this.providers, { unprovenTx });
      submit.catch(() => {});
      const stop = { done: false };
      const confirmed = this.pollImmutable(stop);
      confirmed.catch(() => {});
      let r: Awaited<typeof submit> | null;
      try {
        r = (await Promise.race([submit.then((x) => ({ r: x })), confirmed.then(() => ({ r: null }))])).r;
      } finally {
        stop.done = true;
      }
      if (r && r.status !== SucceedEntirely) throw new AppError('CONTRACT_REJECTED', `Renounce transaction ${r.txHash} finished with status ${r.status}.`);
      const vault = sharedVault();
      await vaultSigningKeys(vault).remove(this.contractAddress);
      await vault.save(this.contractAddress, { ...(await vault.load(this.contractAddress)), authorityRenouncedAt: Date.now() });
      return r ? { txId: String(r.txId ?? r.txHash), txHash: r.txHash, blockHeight: r.blockHeight } : { txId: '', txHash: '(confirmed from chain state)' };
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError('CONTRACT_REJECTED', describeError(e), { cause: e });
    }
  }

  /**
   * An unproven transaction carrying only a signed maintenance update, as midnight-js 5 builds them: ledger 9 classes,
   * the network id and TTL from the providers' config, sealed into an era-tagged handle for `submitTx`.
   */
  private maintenanceTx(update: MaintenanceUpdate) {
    const ttl = new Date(Date.now() + this.providers.config.ttlSeconds * 1000);
    return LedgerTransaction.seal('v9', 'Unproven', Transaction.fromParts(this.providers.config.networkId, undefined, undefined, Intent.new(ttl).addMaintenanceUpdate(update)));
  }

  private async pollImmutable(stop: { done: boolean }, timeoutMs = 10 * 60_000, everyMs = 4_000): Promise<void> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end && !stop.done) {
      await new Promise((r) => setTimeout(r, everyMs));
      try {
        const s = await readContractState(this.providers.publicDataProvider, this.contractAddress);
        if (s && authorityLevel(maintenanceOf(s)) === 'immutable') return;
      } catch {
        /* keep polling */
      }
    }
    if (stop.done) return;
    throw new AppError('CONTRACT_REJECTED', 'Renouncing the authority was not confirmed on-chain within 10 minutes. Check your wallet history, then reload the Contract tab.');
  }

  private async call(circuit: string, ...args: unknown[]): Promise<TxReceipt> {
    const fn = this.found.callTx[circuit];
    if (!fn) throw new AppError('VALIDATION', `Circuit “${circuit}” is not registered on-chain yet. Register the remaining circuits first.`);
    try {
      return await withTxLog(sharedTxLog(), this.logStart(circuit), async () => toReceipt(await fn(...args)));
    } catch (e) {
      console.error(`[${circuit}] failed`, e);
      throw new AppError('CONTRACT_REJECTED', describeError(e), { cause: e });
    }
  }

  /** Fills in (or corrects) any subset of the missing terms — the delayed-initialization step. */
  configure(terms: ConfigureTerms): Promise<TxReceipt> {
    return this.call('configure', ...maybeTerms(terms));
  }

  finalize(): Promise<TxReceipt> {
    return this.call('finalizeInitialization');
  }

  /** FR-DEPLOY-03: whitelist a CASP issuer key (e.g. from the CASP's /.well-known/casp-keys). */
  addKycIssuer(issuerId: string, publicKey: { x: string; y: string }): Promise<TxReceipt> {
    return this.call('addKycIssuer', hex32ToBytes(issuerId, 'issuer id'), { x: BigInt(publicKey.x), y: BigInt(publicKey.y) });
  }

  removeKycIssuer(issuerId: string): Promise<TxReceipt> {
    return this.call('removeKycIssuer', hex32ToBytes(issuerId, 'issuer id'));
  }

  async missingCircuits(): Promise<string[]> {
    const have = await AdminGateway.registered(this.providers, this.contractAddress);
    return allCircuitIds().filter((c) => !have.has(c));
  }

  /** Registers one circuit (a batch of one). Kept for callers that register a single circuit. */
  registerCircuit(circuit: string): Promise<TxReceipt> {
    return this.registerCircuits([circuit]);
  }

  /**
   * One maintenance transaction inserting the verifier keys of several circuits (staged deploy, phase 2; batches of
   * `contract.maintenanceBatchSize`, default 4). The update is signed once with the deploy-time authority key.
   */
  async registerCircuits(circuits: string[]): Promise<TxReceipt> {
    const unknown = circuits.filter((c) => !allCircuitIds().includes(c));
    if (unknown.length) throw new AppError('VALIDATION', `Unknown circuit(s): ${unknown.join(', ')}`);
    if (circuits.length === 0) return { txId: '', txHash: '(nothing to register)' };
    try {
      return await withTxLog(sharedTxLog(), this.logStart('registerCircuits', circuits), () => this.withPendingRetry(circuits, () => this.submitBatch(circuits)));
    } catch (e) {
      console.error(`[register ${circuits.join(', ')}] failed`, e);
      throw new AppError('CONTRACT_REJECTED', describeError(e), { cause: e });
    }
  }

  /**
   * The chain can confirm a transaction before the wallet drops it from its own pending list, so the next one is
   * refused with "A transaction is already pending". That clears on its own: wait and retry, unless the circuits
   * turn out to be registered meanwhile.
   */
  private async withPendingRetry<T>(circuits: string[], attempt: () => Promise<T>, timeoutMs = 5 * 60_000, everyMs = 6_000): Promise<T> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      try {
        return await attempt();
      } catch (e) {
        const pending = /already pending/i.test(e instanceof Error ? e.message : String(e));
        if (!pending || Date.now() >= end) throw e;
        await new Promise((r) => setTimeout(r, everyMs));
        const have = await AdminGateway.registered(this.providers, this.contractAddress).catch(() => new Set<string>());
        if (circuits.every((c) => have.has(c))) {
          this.found = await AdminGateway.open(this.providers, this.contractAddress, this.getSecretKey);
          return { txId: '', txHash: '(confirmed from chain state)' } as T;
        }
      }
    }
  }

  /** Builds, signs and submits one MaintenanceUpdate with a VerifierKeyInsert per circuit not yet registered. */
  private async submitBatch(circuits: string[]): Promise<TxReceipt> {
    const state: ChainContractState | null = await readContractState(this.providers.publicDataProvider, this.contractAddress);
    if (!state) throw new AppError('CONTRACT_REJECTED', 'Contract state not found on this network');
    const todo = circuits.filter((c) => state.operation(c) === undefined); // resumable: skip what is already on-chain
    if (todo.length === 0) return { txId: '', txHash: '(already registered)' };
    const signingKey = await this.providers.privateStateProvider.getSigningKey(this.contractAddress);
    if (!signingKey || (await this.authorityKeyStatus()) !== 'match') {
      throw new AppError('VALIDATION', sharedVault().unlocked ? 'The contract authority key is not in the vault (or does not match the chain). Import it on the Keys tab.' : 'Unlock the vault: the contract authority key is stored there, encrypted.');
    }
    const updates = await Promise.all(
      // Ledger 9 verifier keys are operation version 'v4' (ZKIR v3 circuits), as midnight-js / compact-js 3 build them.
      todo.map(async (c) => new VerifierKeyInsert(c, new ContractOperationVersionedVerifierKey('v4', (await this.providers.zkConfigProvider.getVerifierKey(c)) as unknown as Uint8Array)))
    );
    // The update is valid against the authority's current counter; index 0 = the single deploy-time committee key.
    const unsigned = new MaintenanceUpdate(this.contractAddress, updates, state.maintenanceAuthority.counter);
    const update = unsigned.addSignature(0n, signData(toSigningKey(signingKey) as never, unsigned.dataToSign));
    const unprovenTx = this.maintenanceTx(update);

    const submit = (submitTx as unknown as (p: unknown, o: unknown) => Promise<{ status: string; txId?: string; txHash: string; blockHeight: number }>)(this.providers, { unprovenTx });
    submit.catch(() => {}); // a late rejection after the chain already confirmed must not surface as unhandled
    // midnight-js waits for the indexer to report the tx; that wait can stall even though the tx is final.
    // The chain's own state is the source of truth.
    const stop = { done: false };
    const confirmed = this.pollRegistered(todo, stop);
    confirmed.catch(() => {});
    let r: Awaited<typeof submit> | null;
    try {
      r = (await Promise.race([submit.then((x) => ({ r: x })), confirmed.then(() => ({ r: null }))])).r;
    } finally {
      stop.done = true;
    }
    if (r && r.status !== SucceedEntirely) throw new AppError('CONTRACT_REJECTED', `Maintenance transaction ${r.txHash} finished with status ${r.status}; registered circuits are re-checked on the next run.`);
    this.found = await AdminGateway.open(this.providers, this.contractAddress, this.getSecretKey);
    return r ? { txId: String(r.txId ?? r.txHash), txHash: r.txHash, blockHeight: r.blockHeight } : { txId: '', txHash: '(confirmed from chain state)' };
  }

  private async pollRegistered(circuits: string[], stop: { done: boolean }, timeoutMs = 10 * 60_000, everyMs = 4_000): Promise<void> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end && !stop.done) {
      await new Promise((r) => setTimeout(r, everyMs));
      try {
        const have = await AdminGateway.registered(this.providers, this.contractAddress);
        if (circuits.every((c) => have.has(c))) return;
      } catch {
        /* node/indexer hiccup: keep polling */
      }
    }
    if (stop.done) return;
    throw new AppError(
      'CONTRACT_REJECTED',
      `Registering ${circuits.join(', ')} was not confirmed on-chain within ${Math.round(timeoutMs / 60_000)} minutes. Check your wallet's history for a pending transaction, then register the remaining circuits again.`
    );
  }
}

export const newAdminSecret = (): Uint8Array => randomBytes(32);
