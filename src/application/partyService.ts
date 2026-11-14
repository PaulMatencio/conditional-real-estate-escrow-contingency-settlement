/**
 * Party use-cases: one entry point that pre-flights a circuit (phase / role / deadline, local material, terms and
 * KYC checks, shielded balance) before any proof is generated (FR-FUND-04, NFR-02), then calls the gateway and
 * records the result in the local history (FR-AUDIT-03).
 */
import { AppError } from '@/domain/errors';
import { decimalsOf, formatAmount } from '@/domain/amount';
import { authorityLevel, isFullyConfigured, type EscrowView } from '@/domain/escrowView';
import { ACTIONS, needsSecondCoin, type PartyCircuit } from '@/domain/lifecycle';
import type { Caller } from '@/domain/roles';
import type { VaultRecord } from './partyPorts';
import type { CallMaterial, CallReceipt, CircuitArgs, EscrowPartyGateway } from './partyPorts';
import { assertTermsMatch, checkLenderPackage, precheckAttestation, type TermsCrypto } from './termsService';
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
  const dec = decimalsOf(ctx.record.terms?.escrowDecimals, ctx.record.lenderTerms?.escrowDecimals, ctx.record.meta?.decimals);
  const amt = (v: bigint) => formatAmount(v, dec, view.escrowTicker);
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
  if (spec.witnesses.includes('lenderTerms')) {
    if (ctx.record.lenderTerms) {
      const c = checkLenderPackage(ctx.crypto, ctx.record.lenderTerms, view);
      if (!c.ok) problems.push(`TERMS_COMMITMENT_MISMATCH: the lender terms do not open the on-chain commitments (${(['price', 'lenderShare', 'lenderPayout', 'loanTerms'] as const).filter((k) => c[k] !== 'match').join(', ')}).`);
    } else if (ctx.record.terms) {
      if (!spec.witnesses.includes('privateTerms')) {
        try {
          assertTermsMatch(ctx.crypto, ctx.record.terms, view);
        } catch (e) {
          problems.push((e as Error).message);
        }
      }
    } else problems.push('No lender terms in this browser (Lender terms card: import the package the admin sent).');
  }
  if (needsSecondCoin(circuit, view) && ctx.record.secondCoin?.index === undefined) {
    problems.push('Index of the loan or top-up coin unknown: it is read from its deposit transaction, which was not found yet.');
  }
  if (spec.witnesses.includes('penaltyCoin') && ctx.record.penaltyCoin?.index === undefined) {
    problems.push('Index of the penalty coin unknown: it is read from the withdrawal refund transaction, which was not found yet.');
  }
  if (spec.witnesses.includes('kycAttestation')) {
    const role = circuit === 'depositToEscrow' || circuit === 'depositTopUp' ? 'buyer' : 'seller';
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
    else if (bal < need) problems.push(`Shielded balance too low: ${amt(bal)}, need ${amt(need)} (shortfall ${amt(need - bal)}).`);
  }
  if ((circuit === 'depositTopUp' || circuit === 'depositLoan') && (ctx.record.terms || ctx.record.lenderTerms)) {
    const need = BigInt(ctx.record.lenderTerms?.lenderShare ?? ctx.record.terms!.terms.lenderShare);
    const bal = await ctx.gateway.shieldedBalance(view.escrowColor).catch(() => null);
    if (bal === null) warnings.push('The wallet did not report a shielded balance; the deposit fails if it holds too little.');
    else if (bal < need) problems.push(`Shielded balance too low: ${amt(bal)}, need ${amt(need)} (shortfall ${amt(need - bal)}).`);
  }
  if (circuit === 'depositLoan' && ctx.record.lenderTerms) {
    const key = await ctx.gateway.coinPublicKey().catch(() => null);
    if (key && key !== ctx.record.lenderTerms.lenderPayout) warnings.push("The connected wallet's shielded key differs from the committed lender payout key; a repayment will go to the committed key.");
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
  const lt = ctx.record.lenderTerms;
  const sc = ctx.record.secondCoin;
  const usesSecond = spec.witnesses.includes('secondCoin');
  return {
    secretKey: spec.witnesses.includes('localSecretKey') ? ctx.secretKey : undefined,
    // The full terms also serve the lender witness (refundLender by a party) and the top-up coin.
    terms: spec.witnesses.includes('privateTerms') || ((spec.witnesses.includes('lenderTerms') || usesSecond) && !lt) ? ctx.record.terms?.terms : undefined,
    kyc: spec.witnesses.includes('kycAttestation') ? ctx.record.kyc?.[role === 'seller' ? 'seller' : 'buyer'] : undefined,
    vaultIndex: spec.witnesses.includes('vaultCoin') && ctx.record.terms?.vaultIndex !== undefined ? BigInt(ctx.record.terms.vaultIndex) : undefined,
    lenderTerms:
      (spec.witnesses.includes('lenderTerms') || usesSecond) && lt
        ? { lenderShare: lt.lenderShare, lenderShareSalt: lt.lenderShareSalt, lenderPayout: lt.lenderPayout, lenderPayoutSalt: lt.lenderPayoutSalt, refundOnLoss: lt.refundOnLoss, loanTermsSalt: lt.loanTermsSalt }
        : undefined,
    secondCoin: usesSecond && sc?.index !== undefined ? { kind: sc.kind, index: BigInt(sc.index) } : undefined,
    penaltyIndex: spec.witnesses.includes('penaltyCoin') && ctx.record.penaltyCoin?.index !== undefined ? BigInt(ctx.record.penaltyCoin.index) : undefined
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
  if (needsSecondCoin(circuit, view) && ctx.record.secondCoin?.index === undefined) {
    ctx = { ...ctx, record: await trackSecondCoin(ctx, view) };
  }
  if (ACTIONS[circuit].witnesses.includes('penaltyCoin') && ctx.record.penaltyCoin?.index === undefined) {
    ctx = { ...ctx, record: await trackPenaltyCoin(ctx) };
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
  if (circuit === 'depositLoan' || circuit === 'depositTopUp') {
    let index = receipt.vaultIndex ?? null;
    if (index === null) index = await ctx.gateway.locateCoinIndex(circuit, receipt.txHash).catch(() => null);
    record.secondCoin = { kind: circuit === 'depositLoan' ? 'loan' : 'topup', txHash: receipt.txHash, index: index === null ? undefined : index.toString() };
  }
  if (circuit === 'refundWithdrawal') {
    const after = await ctx.gateway.readView().catch(() => null);
    if (after?.coolingOff.penaltyDue) {
      let index = receipt.vaultIndex ?? null;
      if (index === null) index = await ctx.gateway.locateCoinIndex('refundWithdrawal', receipt.txHash).catch(() => null);
      record.penaltyCoin = { txHash: receipt.txHash, index: index === null ? undefined : index.toString() };
    }
  }
  return { receipt, record };
}

/** v2: locate the second coin (loan or top-up) from its deposit transaction, from any party's browser. */
export async function trackSecondCoin(ctx: PartyContext, view: EscrowView): Promise<VaultRecord> {
  const f = view.financing;
  if (!f.loanHeld && !f.topUpHeld) return ctx.record;
  const kind = f.loanHeld ? 'loan' : 'topup';
  const known = ctx.record.secondCoin?.kind === kind ? ctx.record.secondCoin : undefined;
  const index = await ctx.gateway.locateCoinIndex(kind === 'loan' ? 'depositLoan' : 'depositTopUp', known?.txHash ?? null).catch(() => null);
  return index === null ? ctx.record : { ...ctx.record, secondCoin: { kind, txHash: known?.txHash, index: index.toString() } };
}

/** Cooling-off: locate the penalty coin from the withdrawal refund transaction, from any party's browser (the seller's). */
export async function trackPenaltyCoin(ctx: PartyContext): Promise<VaultRecord> {
  const known = ctx.record.penaltyCoin;
  const index = await ctx.gateway.locateCoinIndex('refundWithdrawal', known?.txHash ?? null).catch(() => null);
  return index === null ? ctx.record : { ...ctx.record, penaltyCoin: { txHash: known?.txHash, index: index.toString() } };
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
