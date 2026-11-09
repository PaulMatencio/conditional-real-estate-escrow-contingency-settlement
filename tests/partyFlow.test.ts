/**
 * End-to-end party flows in Simulator Mode through the application layer (pre-flight → call → record):
 * the same code path the role pages use, with the compiled contract running in-process.
 */
import { describe, expect, it } from 'vitest';
import type { VaultRecord } from '@/application/partyPorts';
import { finalizeBlockers, preflight, runPartyAction, type PartyContext } from '@/application/partyService';
import { checkTermsAgainstLedger } from '@/application/termsService';
import type { Caller } from '@/domain/roles';
import { payoutCoinOf } from '@/infrastructure/crypto/escrowCrypto';
import { termsCrypto } from '@/infrastructure/crypto/termsCrypto';
import { BUYER_KEY, DDL, DL, K, SELLER_KEY, configuredEscrow, hex, rid } from './helpers/fixtures';

function party(sim: Awaited<ReturnType<typeof configuredEscrow>>['sim'], sk: Uint8Array, record: VaultRecord): PartyContext {
  return { gateway: sim.gateway(), crypto: termsCrypto, record, secretKey: sk };
}

async function act(ctx: PartyContext, caller: Caller, circuit: Parameters<typeof runPartyAction>[2], args: unknown[] = []) {
  const out = await runPartyAction(ctx, caller, circuit as never, args as never);
  ctx.record = out.record;
  return out.receipt;
}

async function toPending() {
  const { sim, pkg, casp } = await configuredEscrow();
  const buyer = party(sim, K.buyer, { terms: pkg, kyc: { buyer: casp.bundle(rid(K.buyer), BUYER_KEY) } });
  const seller = party(sim, K.seller, { terms: pkg, kyc: { seller: casp.bundle(rid(K.seller), SELLER_KEY, { travelRuleRef: hex(5) }) } });
  const v = sim.view();
  expect(checkTermsAgainstLedger(termsCrypto, pkg, v).ok).toBe(true);
  await act(buyer, 'buyer', 'acceptConfiguration', [v.configVersion]);
  await act(seller, 'seller', 'acceptConfiguration', [v.configVersion]);
  expect(finalizeBlockers(sim.view(), { terms: pkg }, termsCrypto, BigInt(sim.time))).toContain('Confirm at least one backup of the private terms package (FR-TERMS-04)');
  expect(finalizeBlockers(sim.view(), { terms: pkg, backups: [{ at: 1, kind: 'file' }] }, termsCrypto, BigInt(sim.time))).toEqual([]);
  await sim.finalize(K.admin);
  expect(sim.view().status).toBe('Created');
  const dep = await act(buyer, 'buyer', 'depositToEscrow');
  expect(dep.vaultIndex).toBe(0n);
  expect(buyer.record.terms?.vaultIndex).toBe('0');
  expect(sim.view().status).toBe('Funded');
  expect(sim.view().buyerKyc.verified).toBe(true);
  await act(seller, 'seller', 'openContingencyReview');
  return { sim, pkg, casp, buyer, seller };
}

describe('happy path: accept → finalize → deposit → attest → seller KYC → release', () => {
  it('releases the full vault coin to the committed seller key', async () => {
    const { sim, pkg, buyer, seller } = await toPending();
    const inspector = party(sim, K.inspector, {});
    const lender = party(sim, K.lender, {});
    const title = party(sim, K.title, {});
    await act(inspector, 'inspector', 'submitInspection', [true, hex(0x51)]);
    await act(lender, 'lender', 'submitFinancing', [true, hex(0x53)]);
    await act(title, 'titleAgent', 'submitTitle', [true, hex(0x54)]);
    expect(sim.view().status).toBe('ReadyToClose');

    // Release is blocked until the seller proves KYC (pre-flight catches it, no proof spent).
    const pf = await preflight({ ...seller, record: { ...seller.record, terms: { ...pkg, vaultIndex: '0' } } }, sim.view(), 'seller', 'releaseToSeller', [], BigInt(sim.time));
    expect(pf.problems).toContain('ERROR_SELLER_KYC_REQUIRED');

    await act(seller, 'seller', 'submitSellerKyc');
    expect(sim.view().sellerKyc.verified).toBe(true);
    seller.record = { ...seller.record, terms: { ...seller.record.terms!, vaultIndex: '0' } };
    const r = await act(seller, 'seller', 'releaseToSeller');
    const v = sim.view();
    expect(v.status).toBe('Closed');
    expect(v.disbursed).toBe(true);
    const out = r.shielded!.outputs[0];
    expect(out.recipient).toBe(SELLER_KEY);
    expect(out.value).toBe('250000');
    // FR-SETTLE-03: the dApp rebuilds exactly the payout coin the contract created.
    expect(out.nonce).toBe(payoutCoinOf(sim.contractAddress, v.escrowColor, pkg.terms).nonce);
    expect(seller.record.history?.map((h) => h.circuit)).toEqual(['acceptConfiguration', 'openContingencyReview', 'submitSellerKyc', 'releaseToSeller']);
    expect(buyer.record.history?.length).toBe(2);
  });
});

describe('refund paths', () => {
  it('failed contingency → cancelAndRefund → refundBuyer pays the committed buyer key', async () => {
    const { sim, buyer } = await toPending();
    await act(party(sim, K.title, {}), 'titleAgent', 'submitTitle', [false, hex(0x54)]);
    await act(buyer, 'buyer', 'cancelAndRefund');
    expect(sim.view().status).toBe('Refunded');
    const r = await act(buyer, 'buyer', 'refundBuyer');
    expect(sim.view().status).toBe('Closed');
    expect(r.shielded!.outputs[0].recipient).toBe(BUYER_KEY);
  });

  it('closing deadline passes → anyone expires → seller triggers refund to the buyer', async () => {
    const { sim, seller } = await toPending();
    sim.setTime(Number(DL) + 1);
    await act(party(sim, new Uint8Array(32), {}), 'anyone', 'expireEscrow');
    expect(sim.view().status).toBe('Expired');
    const r = await act(seller, 'seller', 'refundBuyer');
    expect(r.shielded!.outputs[0].recipient).toBe(BUYER_KEY);
  });

  it('dispute → resolver voids → original attestor re-attests', async () => {
    const { sim, buyer } = await toPending();
    const resolver = party(sim, K.resolver, {});
    const inspector = party(sim, K.inspector, {});
    await act(inspector, 'inspector', 'submitInspection', [false, hex(0x51)]);
    await act(buyer, 'buyer', 'openDispute');
    await expect(act(resolver, 'resolver', 'resolveDisputeSettlement')).rejects.toThrow(/Contingencies are not all cleared/);
    await act(resolver, 'resolver', 'voidContingencyResult', ['Inspection']);
    expect(sim.view().voidedReportHistory).toEqual([{ index: 0n, reportHash: hex(0x51) }]);
    await act(inspector, 'inspector', 'submitInspection', [true, hex(0x52)]);
    expect(sim.view().contingencies.Inspection).toMatchObject({ submitted: true, passed: true, reportHash: hex(0x52) });
    sim.setTime(Number(DDL));
    expect(sim.view().status).toBe('ContingenciesPending');
  });
});

describe('pre-flight guards (no proof is attempted)', () => {
  it('refuses a deposit with a tampered terms package (TERMS_COMMITMENT_MISMATCH)', async () => {
    const { sim, pkg, casp } = await configuredEscrow();
    const bad = { ...pkg, terms: { ...pkg.terms, amount: '1' } };
    const buyer = party(sim, K.buyer, { terms: bad, kyc: { buyer: casp.bundle(rid(K.buyer), BUYER_KEY) } });
    await expect(runPartyAction(buyer, 'buyer', 'acceptConfiguration', [sim.view().configVersion])).rejects.toThrow(/TERMS_COMMITMENT_MISMATCH: amount/);
  });

  it('flags an attestation bound to the wrong wallet, an untrusted issuer and a low KYC level', async () => {
    const { sim, pkg, casp } = await configuredEscrow();
    const v = sim.view();
    const ctx = party(sim, K.buyer, { terms: pkg, kyc: { buyer: casp.bundle(rid(K.buyer), SELLER_KEY, { kycLevel: 1 }) } });
    const pf = await preflight(ctx, { ...v, status: 'Created' }, 'buyer', 'depositToEscrow', [], BigInt(sim.time));
    expect(pf.problems.join('\n')).toMatch(/wallet is not the verified buyer wallet/);
    expect(pf.problems).toContain('ERROR_KYC_LEVEL_INSUFFICIENT');
    const rogue = { ...casp.bundle(rid(K.buyer), BUYER_KEY), issuerId: hex(0xee) };
    const pf2 = await preflight({ ...ctx, record: { terms: pkg, kyc: { buyer: rogue } } }, { ...v, status: 'Created' }, 'buyer', 'depositToEscrow', [], BigInt(sim.time));
    expect(pf2.problems.join('\n')).toMatch(/issuer is not a trusted CASP/);
  });

  it('a tampered signature fails the off-chain Schnorr check', async () => {
    const { sim, pkg, casp } = await configuredEscrow();
    const b = casp.bundle(rid(K.buyer), BUYER_KEY);
    const forged = { ...b, attestation: { ...b.attestation, amlRiskScore: 0 } };
    const pf = await preflight(party(sim, K.buyer, { terms: pkg, kyc: { buyer: forged } }), { ...sim.view(), status: 'Created' }, 'buyer', 'depositToEscrow', [], BigInt(sim.time));
    expect(pf.problems).toContain('ERROR_NOT_WHITELISTED: invalid KYC attestation signature');
  });
});
