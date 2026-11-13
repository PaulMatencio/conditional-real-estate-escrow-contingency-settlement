/**
 * Cooling-off period through the application layer in Simulator Mode (the code path of the buyer's Withdraw card and
 * the seller's Penalty card): terms validation, withdrawal inside / after the period, refund minus penalty, penalty
 * claim, release gate, openings and the notary certificate.
 */
import { describe, expect, it } from 'vitest';
import { buildCertificate, lockedFundsStatement } from '@/application/notaryService';
import type { VaultRecord } from '@/application/partyPorts';
import { preflight, runPartyAction, type PartyContext } from '@/application/partyService';
import { createTermsPackage, selectiveOpening, verifyOpening } from '@/application/termsService';
import { AppError } from '@/domain/errors';
import { insideCoolingOff } from '@/domain/escrowView';
import { availableActions, nextDeadline } from '@/domain/lifecycle';
import type { Caller } from '@/domain/roles';
import { penaltyOf, validateTerms } from '@/domain/terms';
import { withdrawalCoinsOf } from '@/infrastructure/crypto/escrowCrypto';
import { termsCrypto } from '@/infrastructure/crypto/termsCrypto';
import { BUYER_KEY, DAY, K, LENDER_KEY, SELLER_KEY, T0, configuredEscrow, configuredLoanEscrow, hex, rid } from './helpers/fixtures';

type Sim = Awaited<ReturnType<typeof configuredEscrow>>['sim'];
const party = (sim: Sim, sk: Uint8Array, record: VaultRecord): PartyContext => ({ gateway: sim.gateway(), crypto: termsCrypto, record, secretKey: sk });

async function act(ctx: PartyContext, caller: Caller, circuit: Parameters<typeof runPartyAction>[2], args: unknown[] = []) {
  const out = await runPartyAction(ctx, caller, circuit as never, args as never);
  ctx.record = out.record;
  return out.receipt;
}
const outs = (r: { shielded?: { outputs: { recipient: string; value: string; recipientIsContract: boolean }[] } }) =>
  (r.shielded?.outputs ?? []).map((o) => [o.recipientIsContract ? 'contract' : o.recipient, o.value]);

const PERIOD = 10;
/** Cash deal (price 250000), cooling-off 10 days, penalty 1.5 % = 3750; funded at T0. */
async function funded(opts: { coolingOffDays?: number; penaltyRate?: string; loan?: boolean } = {}) {
  const o = { coolingOffDays: opts.coolingOffDays ?? PERIOD, penaltyRate: opts.penaltyRate ?? '150' };
  const { sim, pkg, casp } = opts.loan ? await configuredLoanEscrow(true, o) : await configuredEscrow(o);
  const buyer = party(sim, K.buyer, { terms: pkg, kyc: { buyer: casp.bundle(rid(K.buyer), BUYER_KEY) } });
  const seller = party(sim, K.seller, { terms: pkg, kyc: { seller: casp.bundle(rid(K.seller), SELLER_KEY, { travelRuleRef: hex(5) }) } });
  const v = sim.view();
  await act(buyer, 'buyer', 'acceptConfiguration', [v.configVersion]);
  await act(seller, 'seller', 'acceptConfiguration', [v.configVersion]);
  await sim.finalize(K.admin);
  await act(buyer, 'buyer', 'depositToEscrow');
  return { sim, pkg, buyer, seller };
}

describe('cooling-off terms', () => {
  it('computes the penalty as the rate applied to the price, rounded down, and refuses bad terms', () => {
    expect(penaltyOf(250_000n, 150n)).toBe(3750n);
    expect(penaltyOf(999n, 150n)).toBe(14n);
    const pkg = createTermsPackage(termsCrypto, { price: '250000', buyerPayout: BUYER_KEY, sellerPayout: SELLER_KEY, mode: 'attested', penaltyRate: '150', coolingOff: true });
    expect(pkg.terms).toMatchObject({ penaltyRate: '150', penalty: '3750' });
    expect(validateTerms({ ...pkg.terms, penalty: '3749' })).toMatch(/rate applied to the price/);
    expect(validateTerms({ ...pkg.terms, penaltyRate: '10001', penalty: penaltyOf(250_000n, 10_001n).toString() })).toMatch(/100 %/);
    expect(validateTerms(pkg.terms, 'attested', false)).toMatch(/Without a cooling-off period/);
    expect(() =>
      createTermsPackage(termsCrypto, { price: '250000', buyerDeposit: '100000', buyerPayout: BUYER_KEY, sellerPayout: SELLER_KEY, lenderPayout: LENDER_KEY, mode: 'deposited', penaltyRate: '4000', coolingOff: true })
    ).toThrow(/lower than the buyer deposit/);
  });

  it('is off by default: no penalty, no end, an immediate withdrawal forfeits', async () => {
    const { sim, buyer, seller } = await funded({ coolingOffDays: 0, penaltyRate: '0' });
    expect(sim.view().coolingOff).toMatchObject({ period: 0n, end: 0n });
    expect(nextDeadline(sim.view(), BigInt(sim.time))?.kind).not.toBe('coolingOff');
    await act(buyer, 'buyer', 'buyerWithdraw');
    expect(sim.view().status).toBe('Forfeited');
    expect(lockedFundsStatement(sim.view()).statement).toMatch(/withdrew after the cooling-off period/);
    await act(seller, 'seller', 'submitSellerKyc');
    const r = await act(seller, 'seller', 'claimForfeit');
    expect(outs(r)).toEqual([[SELLER_KEY, '250000']]);
  });
});

describe('withdrawal inside the cooling-off period', () => {
  it('refunds the deposit minus the penalty, then the seller claims the penalty', async () => {
    const { sim, pkg, buyer, seller } = await funded();
    const v = sim.view();
    expect(v.coolingOff.end).toBe(BigInt(T0 + PERIOD * DAY));
    expect(insideCoolingOff(v, BigInt(sim.time))).toBe(true);
    expect(nextDeadline(v, BigInt(sim.time))).toEqual({ kind: 'coolingOff', at: v.coolingOff.end });

    sim.setTime(T0 + PERIOD * DAY - 1);
    await act(buyer, 'buyer', 'buyerWithdraw');
    expect(sim.view().status).toBe('Withdrawn');
    expect(lockedFundsStatement(sim.view()).statement).toMatch(/minus the committed penalty/);

    // The seller cannot claim before the refund, and the pre-flight says why.
    const pf = await preflight(seller, sim.view(), 'seller', 'claimPenalty', [], BigInt(sim.time));
    expect(pf.problems).toContain('Refund the buyer first');

    const r = await act(seller, 'seller', 'refundWithdrawal');
    expect(outs(r)).toEqual([
      [BUYER_KEY, '246250'],
      ['contract', '3750']
    ]);
    const coins = withdrawalCoinsOf(sim.contractAddress, pkg.escrowColor!, pkg.terms);
    expect(r.shielded!.outputs[0].nonce).toBe(coins.buyerRefund.nonce);
    expect(seller.record.penaltyCoin?.index).toBe('2');
    expect(sim.view().coolingOff).toMatchObject({ penaltyDue: true, penaltyPaid: false });
    expect(sim.view().status).toBe('Withdrawn');

    await expect(act(seller, 'seller', 'claimPenalty')).rejects.toThrow(/ERROR_SELLER_KYC_REQUIRED/);
    await act(seller, 'seller', 'submitSellerKyc');
    const c = await act(seller, 'seller', 'claimPenalty');
    expect(outs(c)).toEqual([[SELLER_KEY, '3750']]);
    expect(c.shielded!.outputs[0].nonce).toBe(coins.sellerPenalty!.nonce);
    expect(sim.view().status).toBe('Closed');
  });

  it('locates the penalty coin from the seller side when the buyer ran the refund', async () => {
    const { sim, buyer, seller } = await funded();
    await act(buyer, 'buyer', 'buyerWithdraw');
    await act(buyer, 'buyer', 'refundWithdrawal');
    expect(seller.record.penaltyCoin).toBeUndefined();
    await act(seller, 'seller', 'submitSellerKyc');
    await act(seller, 'seller', 'claimPenalty');
    expect(seller.record.penaltyCoin?.index).toBe('2');
    expect(sim.view().status).toBe('Closed');
  });

  it('returns the whole deposit with a zero penalty, and nothing is left to claim', async () => {
    const { sim, buyer } = await funded({ penaltyRate: '0' });
    await act(buyer, 'buyer', 'buyerWithdraw');
    const r = await act(buyer, 'buyer', 'refundWithdrawal');
    expect(outs(r)).toEqual([[BUYER_KEY, '250000']]);
    expect(sim.view().status).toBe('Closed');
    expect(availableActions(sim.view(), 'seller', BigInt(sim.time), { terms: true, kycAttestation: true, vaultCoin: true }).find((a) => a.circuit === 'claimPenalty')?.enabled).toBe(false);
  });

  it('sends a held loan back to the lender', async () => {
    const { sim, buyer, seller } = await funded({ loan: true });
    await act(seller, 'seller', 'openContingencyReview');
    const { lenderPackageOf } = await import('@/application/termsService');
    const lender = party(sim, K.lender, { lenderTerms: { ...lenderPackageOf(buyer.record.terms!), contractAddress: sim.contractAddress } });
    await act(lender, 'lender', 'depositLoan', [hex(0x60)]);
    await act(buyer, 'buyer', 'buyerWithdraw');
    const r = await act(lender, 'lender', 'refundLender');
    expect(outs(r)).toEqual([[LENDER_KEY, '150000']]);
    const b = await act(buyer, 'buyer', 'refundWithdrawal');
    expect(outs(b)).toEqual([
      [BUYER_KEY, '96250'],
      ['contract', '3750']
    ]);
  });
});

describe('after the cooling-off period', () => {
  it('blocks the release until the end, and a withdrawal then forfeits', async () => {
    const { sim, buyer, seller } = await funded();
    await act(seller, 'seller', 'openContingencyReview');
    await act(party(sim, K.inspector, {}), 'inspector', 'submitInspection', [true, hex(0x51)]);
    await act(party(sim, K.lender, {}), 'lender', 'submitFinancing', [true, hex(0x53)]);
    await act(party(sim, K.title, {}), 'titleAgent', 'submitTitle', [true, hex(0x54)]);
    await act(seller, 'seller', 'submitSellerKyc');
    expect(sim.view().status).toBe('ReadyToClose');
    await expect(act(seller, 'seller', 'releaseToSeller')).rejects.toThrow(/Cooling-off period is not over/);
    sim.setTime(T0 + PERIOD * DAY);
    expect(insideCoolingOff(sim.view(), BigInt(sim.time))).toBe(false);
    await act(buyer, 'buyer', 'buyerWithdraw');
    expect(sim.view().status).toBe('Forfeited');
  });

  it('refuses a withdrawal after a failed contingency: the buyer cancels for a full refund instead', async () => {
    const { sim, buyer, seller } = await funded();
    await act(seller, 'seller', 'openContingencyReview');
    await act(party(sim, K.inspector, {}), 'inspector', 'submitInspection', [false, hex(0x51)]);
    await expect(act(buyer, 'buyer', 'buyerWithdraw')).rejects.toThrow(/full refund instead/);
    sim.setTime(T0 + PERIOD * DAY + 1);
    await act(buyer, 'buyer', 'cancelAndRefund');
    const r = await act(buyer, 'buyer', 'refundBuyer');
    expect(outs(r)).toEqual([[BUYER_KEY, '250000']]);
  });

  it('lets the buyer leave a dispute only inside the period', async () => {
    let f = await funded();
    await act(f.seller, 'seller', 'openContingencyReview');
    await act(f.seller, 'seller', 'openDispute');
    await act(f.buyer, 'buyer', 'buyerWithdraw');
    expect(f.sim.view().status).toBe('Withdrawn');
    f = await funded();
    await act(f.seller, 'seller', 'openContingencyReview');
    await act(f.seller, 'seller', 'openDispute');
    f.sim.setTime(T0 + PERIOD * DAY);
    await expect(act(f.buyer, 'buyer', 'buyerWithdraw')).rejects.toBeInstanceOf(AppError);
  });
});

describe('notary', () => {
  it('verifies the penalty opening and reports it in the certificate', async () => {
    const { sim, pkg } = await funded();
    const o = selectiveOpening(pkg, 'coolingOff');
    expect(verifyOpening(termsCrypto, o, sim.view())).toEqual({ ok: true, detail: 'Cooling-off penalty verified: 1.5 % of the price = 3750 EURe' });
    expect(verifyOpening(termsCrypto, { ...o, penalty: '3751' } as typeof o, sim.view()).ok).toBe(false);
    const cert = (openings: Parameters<typeof buildCertificate>[2]['openings']) => buildCertificate(termsCrypto, sim.view(), { network: 'undeployed', openings });
    expect(cert([]).coolingOff).toMatchObject({ days: PERIOD, end: String(T0 + PERIOD * DAY), penalty: 'undisclosed', buyerWithdrew: false });
    expect(cert([o]).coolingOff.penalty).toBe('1.5 % = 3750 EURe');
  });
});
