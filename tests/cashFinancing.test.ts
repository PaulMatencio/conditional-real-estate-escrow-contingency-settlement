/**
 * Cash deal (financing mode Attested): the buyer waives the redundant Financing contingency (contract v2 still
 * requires it cleared), then inspection and title alone take the escrow to ReadyToClose.
 */
import { describe, expect, it } from 'vitest';
import type { VaultRecord } from '@/application/partyPorts';
import { runPartyAction, type PartyContext } from '@/application/partyService';
import { cashFinancingWaiver } from '@/domain/lifecycle';
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

describe('cash deal: waive financing', () => {
  it('is offered once the review is open, clears Financing, and the escrow closes on inspection and title alone', async () => {
    const { sim, pkg, casp } = await configuredEscrow();
    expect(sim.view().financing.mode).toBe('Attested');
    const buyer = party(sim, K.buyer, { terms: pkg, kyc: { buyer: casp.bundle(rid(K.buyer), BUYER_KEY) }, backups: [{ at: 1, kind: 'file' }] });
    const seller = party(sim, K.seller, { terms: pkg, kyc: { seller: casp.bundle(rid(K.seller), SELLER_KEY, { travelRuleRef: hex(5) }) } });
    const v0 = sim.view();
    await act(buyer, 'buyer', 'acceptConfiguration', [v0.configVersion]);
    await act(seller, 'seller', 'acceptConfiguration', [v0.configVersion]);
    await sim.finalize(K.admin);
    await act(buyer, 'buyer', 'depositToEscrow');
    expect(sim.view().status).toBe('Funded');
    expect(cashFinancingWaiver(sim.view())).toBe('later');

    await act(seller, 'seller', 'openContingencyReview');
    expect(cashFinancingWaiver(sim.view())).toBe('now');

    await act(buyer, 'buyer', 'waiveContingency', ['Financing']);
    expect(sim.view().contingencies.Financing.waived).toBe(true);
    expect(cashFinancingWaiver(sim.view())).toBe('hidden');

    await act(party(sim, K.inspector, {}), 'inspector', 'submitInspection', [true, hex(0x51)]);
    await act(party(sim, K.title, {}), 'titleAgent', 'submitTitle', [true, hex(0x54)]);
    expect(sim.view().status).toBe('ReadyToClose');
  });

  it('is never offered in a loan deal', async () => {
    const { sim } = await configuredLoanEscrow();
    expect(sim.view().financing.mode).toBe('Deposited');
    expect(cashFinancingWaiver(sim.view())).toBe('hidden');
  });
});
