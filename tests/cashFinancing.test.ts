/**
 * Cash deal (financing mode Attested): the buyer's deposit clears the Financing contingency in the contract itself.
 * No lender attests it and the buyer does not waive it; inspection and title alone take the escrow to ReadyToClose.
 */
import { describe, expect, it } from 'vitest';
import type { VaultRecord } from '@/application/partyPorts';
import { runPartyAction, type PartyContext } from '@/application/partyService';
import { ACTIONS } from '@/domain/lifecycle';
import type { Caller } from '@/domain/roles';
import { termsCrypto } from '@/infrastructure/crypto/termsCrypto';
import { BUYER_KEY, K, SELLER_KEY, configuredEscrow, configuredLoanEscrow, hex, rid } from './helpers/fixtures';

type Sim = Awaited<ReturnType<typeof configuredEscrow>>['sim'];
const party = (sim: Sim, sk: Uint8Array, record: VaultRecord): PartyContext => ({ gateway: sim.gateway(), crypto: termsCrypto, record, secretKey: sk });
async function act(ctx: PartyContext, caller: Caller, circuit: Parameters<typeof runPartyAction>[2], args: unknown[] = []) {
  const out = await runPartyAction(ctx, caller, circuit as never, args as never);
  ctx.record = out.record;
  return out.receipt;
}

describe('cash deal: the deposit clears financing', () => {
  it('needs no financing step from anyone, and the clearance cannot be waived or voided', async () => {
    const { sim, pkg, casp } = await configuredEscrow();
    expect(sim.view().financing.mode).toBe('Attested');
    const buyer = party(sim, K.buyer, { terms: pkg, kyc: { buyer: casp.bundle(rid(K.buyer), BUYER_KEY) }, backups: [{ at: 1, kind: 'file' }] });
    const seller = party(sim, K.seller, { terms: pkg, kyc: { seller: casp.bundle(rid(K.seller), SELLER_KEY, { travelRuleRef: hex(5) }) } });
    const v0 = sim.view();
    await act(buyer, 'buyer', 'acceptConfiguration', [v0.configVersion]);
    await act(seller, 'seller', 'acceptConfiguration', [v0.configVersion]);
    await sim.finalize(K.admin);
    expect(sim.view().contingencies.Financing).toMatchObject({ submitted: false, passed: false });

    await act(buyer, 'buyer', 'depositToEscrow');
    expect(sim.view().status).toBe('Funded');
    expect(sim.view().contingencies.Financing).toMatchObject({ submitted: true, passed: true, waived: false });

    await act(seller, 'seller', 'openContingencyReview');
    const waive = ACTIONS.waiveContingency.check(sim.view(), 'buyer', BigInt(sim.time), 'Financing');
    expect(waive).toBe("Cash deal: financing is cleared by the buyer's deposit");
    await expect(act(buyer, 'buyer', 'waiveContingency', ['Financing'])).rejects.toThrow(/Cash deal: financing is cleared/);

    await act(party(sim, K.inspector, {}), 'inspector', 'submitInspection', [true, hex(0x51)]);
    expect(sim.view().status).toBe('ContingenciesPending');
    await act(party(sim, K.title, {}), 'titleAgent', 'submitTitle', [true, hex(0x54)]);
    expect(sim.view().status).toBe('ReadyToClose');

    await act(buyer, 'buyer', 'openDispute');
    expect(ACTIONS.voidContingencyResult.check(sim.view(), 'resolver', BigInt(sim.time), 'Financing')).toMatch(/cannot be voided/);
  });

  it('loan deals keep their rules: financing is not cleared by the buyer’s deposit', async () => {
    const { sim } = await configuredLoanEscrow();
    expect(sim.view().financing.mode).toBe('Deposited');
    expect(ACTIONS.waiveContingency.check(sim.view(), 'buyer', 0n, 'Financing')).toMatch(/Not in contingency review|top up instead/);
  });
});
