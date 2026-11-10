/**
 * Party use-cases: one entry point that pre-flights a circuit (phase / role / deadline, local material, terms and
 * KYC checks, shielded balance) before any proof is generated (FR-FUND-04, NFR-02), then calls the gateway and
 * records the result in the local history (FR-AUDIT-03).
 */
import { AppError } from '@/domain/errors';
import { authorityLevel, isFullyConfigured, type EscrowView } from '@/domain/escrowView';
import { ACTIONS, type PartyCircuit } from '@/domain/lifecycle';
import type { Caller } from '@/domain/roles';
import type { VaultRecord } from './partyPorts';
import type { CallMaterial, CallReceipt, CircuitArgs, EscrowPartyGateway } from './partyPorts';
import { assertTermsMatch, precheckAttestation, type TermsCrypto } from './termsService';
import { withTxLog, type TxLogger } from './txLog';

export interface PartyContext {
  gateway: EscrowPartyGateway;
  crypto: TermsCrypto;
  /** The caller's local vault record for this contract (terms, KYC bundles, vault index). */
  record: VaultRecord;
  secretKey?: Uint8Array;
  /** Persistent transaction log: every call that reaches the gateway is recorded (pending → confirmed / failed). */
  txLog?: TxLogger;
  /** Network id recorded in the log (e.g. 'preview'; 'simulator' in Simulator Mode). */
  network?: string;
}

/** Fee margin kept on top of the escrowed amount for the shielded balance check (FR-WALLET-06). */
export const DEPOSIT_MARGIN = 0n;

export interface Preflight {
  ok: boolean;
  problems: string[];
  warnings: string[];
}

/** Everything that can be checked locally before proving. Never throws; the UI shows the list. */
export async function preflight<C extends PartyCircuit>(ctx: PartyContext, view: EscrowView, caller: Caller, circuit: C, args: CircuitArgs[C], nowSec: bigint): Promise<Preflight> {
  const problems: string[] = [];
  const warnings: string[] = [];
  const spec = ACTIONS[circuit];
  if (!spec.callers.includes(caller) && !spec.callers.includes('anyone')) problems.push(`This action is not available to the ${caller}.`);
  const which = circuit === 'waiveContingency' || circuit === 'voidContingencyResult' ? (args as CircuitArgs['waiveContingency'])[0] : undefined;
  const phase = spec.check(view, caller, nowSec, which);
  if (phase) problems.push(phase);
  if (spec.witnesses.includes('localSecretKey') && !ctx.secretKey) problems.push('No role secret key loaded for this contract.');

  // Recommendation 3: parties see whether someone can still change the rules before committing to them.
  const authority = authorityLevel(view.maintenance);
  if (authority === 'open') problems.push('The contract maintenance authority has threshold 0: anyone could change the rules. Do not use this contract.');
  if (authority === 'controlled') {
    const msg = 'The contract maintenance authority is still active: its key holder can change the contract rules. Ask the admin to renounce it (contract immutable) first.';
    if (circuit === 'depositToEscrow') problems.push(msg);
    else if (circuit === 'acceptConfiguration') warnings.push(msg);
  }

  if (spec.witnesses.includes('privateTerms') || circuit === 'acceptConfiguration') {
    try {
      if (circuit === 'acceptConfiguration' && !isFullyConfigured(view)) throw new AppError('PREFLIGHT', 'Configuration is incomplete');
      assertTermsMatch(ctx.crypto, ctx.record.terms, view);
    } catch (e) {
      problems.push((e as Error).message);
    }
  }
  if (spec.witnesses.includes('kycAttestation')) {
    const role = circuit === 'depositToEscrow' ? 'buyer' : 'seller';
    const b = ctx.record.kyc?.[role];
    if (!b) problems.push(`No ${role} KYC attestation imported (Compliance → import or request from the CASP).`);
    else {
      const k = precheckAttestation(ctx.crypto, b, view, role, ctx.record.terms?.terms, Number(nowSec));
      problems.push(...k.problems);
      warnings.push(...k.warnings);
    }
  }
  if (spec.witnesses.includes('vaultCoin') && ctx.record.terms?.vaultIndex === undefined) {
    problems.push('Vault coin index unknown: run vault tracking (Funding) or import a package that carries it.');
  }
  if (circuit === 'depositToEscrow' && ctx.record.terms) {
    const need = BigInt(ctx.record.terms.terms.amount) + DEPOSIT_MARGIN;
    const bal = await ctx.gateway.shieldedBalance(view.escrowColor).catch(() => null);
    if (bal === null) warnings.push('The wallet did not report a shielded balance; the deposit fails if it holds too little.');
    else if (bal < need) problems.push(`Shielded balance too low: ${bal} ${view.escrowTicker}, need ${need} (shortfall ${need - bal}).`);
  }
  if (circuit === 'depositToEscrow' || circuit === 'submitSellerKyc') {
    const key = await ctx.gateway.coinPublicKey().catch(() => null);
    const committed = circuit === 'depositToEscrow' ? ctx.record.terms?.terms.buyerPayout : ctx.record.terms?.terms.sellerPayout;
    if (key && committed && key !== committed) warnings.push("FR-WALLET-05: the connected wallet's shielded key differs from the committed payout key; the payout will go to the committed key.");
  }
  return { ok: problems.length === 0, problems, warnings };
}

export function materialFor(ctx: PartyContext, circuit: PartyCircuit, role: Caller): CallMaterial {
  const spec = ACTIONS[circuit];
  return {
    secretKey: spec.witnesses.includes('localSecretKey') ? ctx.secretKey : undefined,
    terms: spec.witnesses.includes('privateTerms') ? ctx.record.terms?.terms : undefined,
    kyc: spec.witnesses.includes('kycAttestation') ? ctx.record.kyc?.[role === 'seller' ? 'seller' : 'buyer'] : undefined,
    vaultIndex: spec.witnesses.includes('vaultCoin') && ctx.record.terms?.vaultIndex !== undefined ? BigInt(ctx.record.terms.vaultIndex) : undefined
  };
}

export interface ActionOutcome {
  receipt: CallReceipt;
  /** Updated vault record (history, vault index) for the caller to persist. */
  record: VaultRecord;
}

/** Pre-flight, call, then record. Throws AppError('PREFLIGHT') with every problem when the pre-flight fails. */
export async function runPartyAction<C extends PartyCircuit>(ctx: PartyContext, caller: Caller, circuit: C, args: CircuitArgs[C]): Promise<ActionOutcome> {
  const view = await ctx.gateway.readView();
  const now = await ctx.gateway.now();
  if (ACTIONS[circuit].witnesses.includes('vaultCoin') && ctx.record.terms && ctx.record.terms.vaultIndex === undefined) {
    ctx = { ...ctx, record: await trackVault(ctx) };
  }
  const pf = await preflight(ctx, view, caller, circuit, args, now);
  if (!pf.ok) throw new AppError('PREFLIGHT', pf.problems.join(' · '));
  // Pre-flight passed: from here on a transaction is attempted, so it is logged whatever the outcome.
  const receipt = await withTxLog(
    ctx.txLog,
    { mode: ctx.gateway.mode, network: ctx.network ?? ctx.gateway.mode, contractAddress: ctx.gateway.contractAddress, actor: caller, action: circuit },
    () => ctx.gateway.call(circuit, args, materialFor(ctx, circuit, caller))
  );
  const record: VaultRecord = { ...ctx.record, history: [...(ctx.record.history ?? []), { at: Date.now(), circuit, txHash: receipt.txHash, blockHeight: receipt.blockHeight, status: 'confirmed', role: caller }] };
  if (circuit === 'depositToEscrow' && record.terms) {
    let index = receipt.vaultIndex ?? null;
    if (index === null) index = await ctx.gateway.locateVaultIndex(receipt.txHash, record.terms.terms).catch(() => null);
    record.terms = { ...record.terms, depositTxHash: receipt.txHash, vaultIndex: index === null ? undefined : index.toString() };
  }
  return { receipt, record };
}

/** FR-FUND-03: derive the vault coin index on this party's own (no dependency on the depositor) and store it. */
export async function trackVault(ctx: PartyContext): Promise<VaultRecord> {
  const t = ctx.record.terms;
  if (!t) return ctx.record;
  const index = await ctx.gateway.locateVaultIndex(t.depositTxHash ?? null, t.terms).catch(() => null);
  return index === null ? ctx.record : { ...ctx.record, terms: { ...t, vaultIndex: index.toString() } };
}

/** FR-DEPLOY-04 + FR-TERMS-04: the admin may finalize only with both acceptances and a confirmed terms backup. */
export function finalizeBlockers(view: EscrowView, record: VaultRecord, crypto: TermsCrypto, nowSec: bigint): string[] {
  const out: string[] = [];
  if (!isFullyConfigured(view)) out.push('Configuration is incomplete');
  if (!view.buyerAccepted || !view.sellerAccepted) out.push('Buyer and seller must accept the configuration');
  if (!record.backups?.length) out.push('Confirm at least one backup of the private terms package (FR-TERMS-04)');
  if (record.terms) {
    try {
      assertTermsMatch(crypto, record.terms, view);
    } catch (e) {
      out.push((e as Error).message);
    }
  }
  const r = view.roles;
  const others = [r.buyer, r.seller, r.inspector, r.lender, r.titleAgent];
  if (r.resolver && others.includes(r.resolver)) out.push('The dispute resolver must be distinct from every other role');
  if ([r.inspector, r.lender, r.titleAgent].includes(r.seller)) out.push('Attestors must be independent from the seller');
  if (view.disputeDeadline <= view.closingDeadline) out.push('Dispute deadline must follow closing deadline');
  if (nowSec >= view.closingDeadline) out.push('Closing deadline is already in the past');
  return out;
}
