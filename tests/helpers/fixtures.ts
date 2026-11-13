/** Shared test fixtures: role keys, a local CASP signer (contract/test/casp-signer.mjs) and a wired simulator. */
// @ts-expect-error untyped helper module from the contract package
import { createCaspSigner } from '../../contract/test/casp-signer.mjs';
import { createTermsPackage } from '@/application/termsService';
import { bytesToHex } from '@/domain/hex';
import type { AttestationBundle, TermsPackage } from '@/domain/terms';
import { pureCircuits } from '@/infrastructure/contract/module';
import { attestationFromWire } from '@/infrastructure/crypto/escrowCrypto';
import { termsCrypto } from '@/infrastructure/crypto/termsCrypto';
import { EscrowSimulator } from '@/infrastructure/simulator/escrowSimulator';

export const key = (n: number): Uint8Array => {
  const b = new Uint8Array(32);
  b[0] = n;
  return b;
};
export const K = { admin: key(8), buyer: key(1), seller: key(2), inspector: key(3), lender: key(4), title: key(5), resolver: key(6) };
export const rid = (sk: Uint8Array) => bytesToHex(pureCircuits.roleIdOf(sk));
export const hex = (n: number) => n.toString(16).padStart(2, '0').repeat(32);

export const T0 = 1_000_000;
export const DL = 2_000_000n;
export const DDL = 3_000_000n;
export const COLOR = hex(0x77);
export const BUYER_KEY = hex(0x65);
export const SELLER_KEY = hex(0x66);

const point = (p: { x: bigint; y: bigint }) => ({ x: p.x.toString(), y: p.y.toString() });

export function makeCasp(secret = 0x1234567890abcdefn, issuerId = hex(0xc0)) {
  const signer = createCaspSigner(secret, pureCircuits) as {
    publicKey: { x: bigint; y: bigint };
    sign(att: unknown): { announcement: { x: bigint; y: bigint }; response: bigint };
    revokeAttestation(ref: Uint8Array): { announcement: { x: bigint; y: bigint }; response: bigint };
    revokeIssuer(id: Uint8Array): { announcement: { x: bigint; y: bigint }; response: bigint };
  };
  return {
    issuerId,
    publicKey: point(signer.publicKey),
    signer,
    bundle(subject: string, wallet: string, over: Partial<AttestationBundle['attestation']> = {}): AttestationBundle {
      const attestation = { subject, wallet, kycLevel: 2, amlRiskScore: 10, validUntil: 5_000_000, travelRuleRef: hex(0x04), salt: hex(0x09), ...over };
      const att = attestationFromWire(attestation);
      const sig = signer.sign(att);
      return {
        format: 'KycAttestationV1',
        issuerId,
        issuerPublicKey: point(signer.publicKey),
        attestation,
        signature: { announcement: point(sig.announcement), response: sig.response.toString() },
        reference: bytesToHex(pureCircuits.kycReference(att)),
        issuedAt: T0
      };
    }
  };
}

/** A simulator escrow with every term configured and the CASP whitelisted (still Initializing), plus the terms package. */
/** Cooling-off options: the period in days (0 = off, the default) and the penalty in basis points of the price. */
export interface CoolingOffOpts {
  coolingOffDays?: number;
  penaltyRate?: string;
}
export const DAY = 86_400;

export async function configuredEscrow(opts: CoolingOffOpts = {}): Promise<{ sim: EscrowSimulator; pkg: TermsPackage; casp: ReturnType<typeof makeCasp> }> {
  const sim = await EscrowSimulator.create({ adminRoleId: rid(K.admin), buyerRoleId: rid(K.buyer), sellerRoleId: rid(K.seller), tokenColor: COLOR, ticker: 'EURe' }, { time: T0 });
  const days = opts.coolingOffDays ?? 0;
  const pkg0 = createTermsPackage(termsCrypto, { price: '250000', buyerPayout: BUYER_KEY, sellerPayout: SELLER_KEY, mode: 'attested', penaltyRate: opts.penaltyRate, coolingOff: days > 0 });
  const pkg: TermsPackage = { ...pkg0, contractAddress: sim.contractAddress, escrowColor: COLOR, escrowTicker: 'EURe' };
  const casp = makeCasp();
  await sim.configure(K.admin, {
    inspector: rid(K.inspector),
    lender: rid(K.lender),
    titleAgent: rid(K.title),
    resolver: rid(K.resolver),
    buyerPayoutCommitment: pkg.commitments.buyerPayout,
    sellerPayoutCommitment: pkg.commitments.sellerPayout,
    amountCommitment: pkg.commitments.amount,
    closingDeadline: DL,
    disputeDeadline: DDL,
    kycPolicy: { minKycLevel: 2, maxAmlRiskScore: 30 }
  });
  // v2: a cash deal (no loan); the financing commitments are still required.
  await sim.configureFinancing(K.admin, {
    mode: 'attested',
    priceCommitment: pkg.commitments.price,
    lenderShareCommitment: pkg.commitments.lenderShare,
    lenderPayoutCommitment: pkg.commitments.lenderPayout,
    loanTermsCommitment: pkg.commitments.loanTerms,
    loanOfferExpiry: 0n,
    topUpWindow: 0n,
    coolingOff: BigInt(days * DAY),
    coolingOffCommitment: pkg.commitments.coolingOff
  });
  await sim.addKycIssuer(K.admin, casp.issuerId, casp.publicKey);
  return { sim, pkg, casp };
}

export const LENDER_KEY = hex(0x68);
/** Loan offer expiry and top-up window of the loan fixture (simulated time starts at T0). */
export const OFFER_EXPIRY = 1_500_000n;
export const WINDOW = 100_000n;

/** v2: a loan-financed simulator escrow (price 250000 = buyer deposit 100000 + loan 150000), still Initializing. */
export async function configuredLoanEscrow(refundOnLoss = true, opts: CoolingOffOpts = {}): Promise<{ sim: EscrowSimulator; pkg: TermsPackage; casp: ReturnType<typeof makeCasp> }> {
  const sim = await EscrowSimulator.create({ adminRoleId: rid(K.admin), buyerRoleId: rid(K.buyer), sellerRoleId: rid(K.seller), tokenColor: COLOR, ticker: 'EURe' }, { time: T0 });
  const days = opts.coolingOffDays ?? 0;
  const pkg0 = createTermsPackage(termsCrypto, { price: '250000', buyerDeposit: '100000', buyerPayout: BUYER_KEY, sellerPayout: SELLER_KEY, lenderPayout: LENDER_KEY, refundOnLoss, mode: 'deposited', penaltyRate: opts.penaltyRate, coolingOff: days > 0 });
  const pkg: TermsPackage = { ...pkg0, contractAddress: sim.contractAddress, escrowColor: COLOR, escrowTicker: 'EURe' };
  const casp = makeCasp();
  await sim.configure(K.admin, {
    inspector: rid(K.inspector),
    lender: rid(K.lender),
    titleAgent: rid(K.title),
    resolver: rid(K.resolver),
    buyerPayoutCommitment: pkg.commitments.buyerPayout,
    sellerPayoutCommitment: pkg.commitments.sellerPayout,
    amountCommitment: pkg.commitments.amount,
    closingDeadline: DL,
    disputeDeadline: DDL,
    kycPolicy: { minKycLevel: 2, maxAmlRiskScore: 30 }
  });
  await sim.configureFinancing(K.admin, {
    mode: 'deposited',
    priceCommitment: pkg.commitments.price,
    lenderShareCommitment: pkg.commitments.lenderShare,
    lenderPayoutCommitment: pkg.commitments.lenderPayout,
    loanTermsCommitment: pkg.commitments.loanTerms,
    loanOfferExpiry: OFFER_EXPIRY,
    topUpWindow: WINDOW,
    coolingOff: BigInt(days * DAY),
    coolingOffCommitment: pkg.commitments.coolingOff
  });
  await sim.addKycIssuer(K.admin, casp.issuerId, casp.publicKey);
  return { sim, pkg, casp };
}
