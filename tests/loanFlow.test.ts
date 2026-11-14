/**
 * Contract v2 loan flows in Simulator Mode through the application layer (pre-flight → call → record), the code path
 * of the lender page and the buyer's top-up card: lender package, loan deposit, refusal, withdrawal, top-up, refunds.
 */
import { describe, expect, it } from 'vitest';
import type { VaultRecord } from '@/application/partyPorts';
import { preflight, runPartyAction, type PartyContext } from '@/application/partyService';
import { buildCertificate, lockedFundsStatement } from '@/application/notaryService';
import { checkLenderPackage, lenderOpening, lenderPackageOf, selectiveOpening, verifyOpening } from '@/application/termsService';
import type { Caller } from '@/domain/roles';
import { termsCrypto } from '@/infrastructure/crypto/termsCrypto';
import { BUYER_KEY, K, LENDER_KEY, OFFER_EXPIRY, SELLER_KEY, WINDOW, configuredLoanEscrow, hex, rid } from './helpers/fixtures';

type Sim = Awaited<ReturnType<typeof configuredLoanEscrow>>['sim'];
const party = (sim: Sim, sk: Uint8Array, record: VaultRecord): PartyContext => ({ gateway: sim.gateway(), crypto: termsCrypto, record, secretKey: sk });

async function act(ctx: PartyContext, caller: Caller, circuit: Parameters<typeof runPartyAction>[2], args: unknown[] = []) {
  const out = await runPartyAction(ctx, caller, circuit as never, args as never);
  ctx.record = out.record;
  return out.receipt;
}

/** Deployed, accepted, finalized, buyer deposit in, review open. */
async function inReview(refundOnLoss = true) {
  const { sim, pkg, casp } = await configuredLoanEscrow(refundOnLoss);
  const buyer = party(sim, K.buyer, { terms: pkg, kyc: { buyer: casp.bundle(rid(K.buyer), BUYER_KEY) } });
  const seller = party(sim, K.seller, { terms: pkg, kyc: { seller: casp.bundle(rid(K.seller), SELLER_KEY, { travelRuleRef: hex(5) }) } });
  const lender = party(sim, K.lender, { lenderTerms: { ...lenderPackageOf(pkg), contractAddress: sim.contractAddress } });
  const v = sim.view();
  await act(buyer, 'buyer', 'acceptConfiguration', [v.configVersion]);
  await act(seller, 'seller', 'acceptConfiguration', [v.configVersion]);
  await sim.finalize(K.admin);
  await act(buyer, 'buyer', 'depositToEscrow');
  await act(seller, 'seller', 'openContingencyReview');
  return { sim, pkg, buyer, seller, lender, inspector: party(sim, K.inspector, {}), title: party(sim, K.title, {}) };
}

describe('lender package', () => {
  it('opens the four lender commitments on-chain', async () => {
    const { sim, pkg } = await configuredLoanEscrow();
    const lp = lenderPackageOf(pkg);
    expect(checkLenderPackage(termsCrypto, lp, sim.view())).toMatchObject({ ok: true, price: 'match', lenderShare: 'match', lenderPayout: 'match', loanTerms: 'match' });
    expect(checkLenderPackage(termsCrypto, { ...lp, lenderShare: '1' }, sim.view()).lenderShare).toBe('mismatch');
  });
});

describe('the lender funds the loan, the release pays the full price', () => {
  it('deposits the exact loan coin, records its index, and pays the seller both coins', async () => {
    const { sim, buyer, seller, lender, inspector, title } = await inReview();
    expect(sim.view().financing.mode).toBe('Deposited');
    await act(lender, 'lender', 'depositLoan', [hex(0x60)]);
    expect(lender.record.secondCoin).toMatchObject({ kind: 'loan', index: '1' });
    expect(sim.view().financing.loanHeld).toBe(true);
    await act(inspector, 'inspector', 'submitInspection', [true, hex(0x51)]);
    await act(title, 'titleAgent', 'submitTitle', [true, hex(0x54)]);
    expect(sim.view().status).toBe('ReadyToClose');
    await act(seller, 'seller', 'submitSellerKyc');
    const r = await act(seller, 'seller', 'releaseToSeller');
    expect(sim.view().status).toBe('Closed');
    expect(r.shielded!.outputs.map((o) => [o.recipient, o.value]).sort()).toEqual([[SELLER_KEY, '100000'], [SELLER_KEY, '150000']]);
    expect(seller.record.secondCoin).toMatchObject({ kind: 'loan', index: '1' });
  });

  it('refuses a lender action without the lender package or with a wrong one', async () => {
    const { sim, lender } = await inReview();
    const pf = await preflight({ ...lender, record: {} }, sim.view(), 'lender', 'depositLoan', [hex(0x60)], BigInt(sim.time));
    expect(pf.problems.join()).toMatch(/No lender terms/);
    const bad = { ...lender, record: { lenderTerms: { ...lender.record.lenderTerms!, lenderShare: '1' } } };
    const pf2 = await preflight(bad, sim.view(), 'lender', 'depositLoan', [hex(0x60)], BigInt(sim.time));
    expect(pf2.problems.join()).toMatch(/TERMS_COMMITMENT_MISMATCH/);
  });
});

describe('refusal with the refund term on: top-up window', () => {
  it('lets the buyer top up inside the window, and refunds both buyer coins on an unwind', async () => {
    const { sim, buyer, lender, inspector } = await inReview(true);
    await act(lender, 'lender', 'declineLoan', [hex(0x61)]);
    const f = sim.view().financing;
    expect(f).toMatchObject({ loanLost: true, loanLostRefund: true, topUpWindowEnd: BigInt(sim.time) + WINDOW });
    await act(buyer, 'buyer', 'depositTopUp');
    expect(buyer.record.secondCoin).toMatchObject({ kind: 'topup', index: '1' });
    await act(inspector, 'inspector', 'submitInspection', [false, hex(0x51)]);
    await act(buyer, 'buyer', 'cancelAndRefund');
    const r = await act(buyer, 'buyer', 'refundBuyer');
    expect(r.shielded!.outputs.map((o) => [o.recipient, o.value])).toEqual([[BUYER_KEY, '100000']]);
    expect(sim.view().status).toBe('Refunded');
    // The top-up comes back in its own transaction (one payout per circuit).
    const r2 = await act(buyer, 'buyer', 'refundTopUp');
    expect(r2.shielded!.outputs.map((o) => [o.recipient, o.value])).toEqual([[BUYER_KEY, '150000']]);
    expect(sim.view().status).toBe('Closed');
    await expect(act(buyer, 'buyer', 'refundTopUp')).rejects.toThrow(/No top-up to refund|not refundable/);
  });

  it('refunds the buyer after the window when nobody tops up', async () => {
    const { sim, buyer, lender, seller } = await inReview(true);
    await act(lender, 'lender', 'declineLoan', [hex(0x61)]);
    await expect(act(seller, 'anyone', 'endTopUpWindow')).rejects.toThrow(/not over/);
    sim.setTime(sim.time + Number(WINDOW));
    await expect(act(buyer, 'buyer', 'depositTopUp')).rejects.toThrow(/window is over/);
    await act(seller, 'anyone', 'endTopUpWindow');
    expect(sim.view().status).toBe('Refunded');
    await act(seller, 'seller', 'refundBuyer');
    expect(sim.view().status).toBe('Closed');
  });
});

describe('refusal with the refund term off: forfeit', () => {
  it('lets the seller claim the buyer deposit after the closing deadline', async () => {
    const { sim, buyer, seller, lender } = await inReview(false);
    await act(lender, 'lender', 'declineLoan', [hex(0x61)]);
    await expect(act(buyer, 'buyer', 'cancelAndRefund')).rejects.toThrow(/No submitted contingency/);
    sim.setTime(Number(sim.view().closingDeadline));
    await act(seller, 'anyone', 'expireEscrow');
    expect(sim.view().status).toBe('Forfeited');
    await act(seller, 'seller', 'submitSellerKyc');
    const r = await act(seller, 'seller', 'claimForfeit');
    expect(sim.view().status).toBe('Closed');
    expect(r.shielded!.outputs.map((o) => [o.recipient, o.value])).toEqual([[SELLER_KEY, '100000']]);
  });
});

describe('withdrawal after the loan offer expiry', () => {
  it('pays the lender back and counts as a refusal', async () => {
    const { sim, buyer, lender } = await inReview(true);
    await act(lender, 'lender', 'depositLoan', [hex(0x60)]);
    await expect(act(lender, 'lender', 'withdrawLoan')).rejects.toThrow(/not expired yet/);
    sim.setTime(Number(OFFER_EXPIRY));
    const r = await act(lender, 'lender', 'withdrawLoan');
    expect(r.shielded!.outputs.map((o) => [o.recipient, o.value])).toEqual([[LENDER_KEY, '150000']]);
    expect(sim.view().financing).toMatchObject({ loanHeld: false, loanLost: true, loanWithdrawn: true });
    await act(buyer, 'buyer', 'cancelAndRefund');
    await act(buyer, 'buyer', 'refundBuyer');
    expect(sim.view().status).toBe('Closed');
  });

  it('lets the lender (or a party) claim the loan back on an unwind', async () => {
    const { sim, seller, lender } = await inReview();
    await act(lender, 'lender', 'depositLoan', [hex(0x60)]);
    await act(seller, 'seller', 'sellerWithdraw');
    await act(seller, 'seller', 'refundBuyer');
    expect(sim.view().status).toBe('Refunded');
    // A party with the full terms can trigger the lender's refund too (the coin goes to the committed lender key).
    const r = await act(seller, 'seller', 'refundLender');
    expect(r.shielded!.outputs.map((o) => [o.recipient, o.value])).toEqual([[LENDER_KEY, '150000']]);
    expect(sim.view().status).toBe('Closed');
  });
});

describe('notary openings and certificate V2 (loan mode)', () => {
  it('verifies price, deposit, loan amount and refund term separately, and rejects a tampered value', async () => {
    const { sim, pkg } = await configuredLoanEscrow(false);
    const v = sim.view();
    const check = (kind: Parameters<typeof selectiveOpening>[1]) => verifyOpening(termsCrypto, selectiveOpening(pkg, kind), v);
    expect(check('price')).toEqual({ ok: true, detail: 'Total price verified: 0.25 EURe' });
    expect(check('amount')).toEqual({ ok: true, detail: 'Buyer deposit verified: 0.10 EURe' });
    expect(check('lenderShare')).toEqual({ ok: true, detail: 'Loan amount verified: 0.15 EURe' });
    expect(check('loanTerms').ok).toBe(true);
    expect(check('loanTerms').detail).toMatch(/off/);
    expect(check('lenderPayout').ok).toBe(true);
    const price = selectiveOpening(pkg, 'price');
    expect(verifyOpening(termsCrypto, { ...price, amount: '250001' } as typeof price, v).ok).toBe(false);
    // A price opening must not pass as a deposit opening.
    expect(verifyOpening(termsCrypto, { ...price, kind: 'amount' } as never, v).ok).toBe(false);
  });

  it('lets the lender export only its own openings', async () => {
    const { sim, pkg } = await configuredLoanEscrow();
    const lp = lenderPackageOf(pkg);
    for (const kind of ['price', 'lenderShare', 'loanTerms', 'lenderPayout'] as const) expect(verifyOpening(termsCrypto, lenderOpening(lp, kind), sim.view()).ok).toBe(true);
  });

  it('reports the refund term as undisclosed, from an opening, or from the ledger once the loan is lost', async () => {
    const { sim, pkg, lender } = await inReview(false);
    const cert = (openings: Parameters<typeof buildCertificate>[2]['openings']) => buildCertificate(termsCrypto, sim.view(), { network: 'undeployed', openings });
    expect(cert([]).format).toBe('EuNotarialEscrowCertificateV2');
    expect(cert([]).financing.mode).toBe('Deposited');
    expect(cert([]).financing.refundTerm).toBe('undisclosed');
    expect(cert([selectiveOpening(pkg, 'loanTerms')]).financing.refundTerm).toBe('off');
    await act(lender, 'lender', 'declineLoan', [hex(0x61)]);
    expect(cert([]).financing.loanLost).toBe(true);
    expect(cert([]).financing.refundTerm).toBe('off');
    expect(cert([]).financing.topUpWindowEnd).toBeNull();
  });

  it('states that a forfeited deposit is payable only to the seller', async () => {
    const { sim, seller, lender } = await inReview(false);
    await act(lender, 'lender', 'declineLoan', [hex(0x61)]);
    sim.setTime(Number(sim.view().closingDeadline));
    await act(seller, 'anyone', 'expireEscrow');
    const s = lockedFundsStatement(sim.view());
    expect(s.locked).toBe(true);
    expect(s.statement).toMatch(/payable only to the seller/);
  });
});
