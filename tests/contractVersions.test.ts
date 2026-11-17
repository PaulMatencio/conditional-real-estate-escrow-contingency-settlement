/**
 * CLAUDE.md "Backward compatibility after a contract upgrade": escrows deployed with an earlier supported contract
 * version keep working with this dApp, with that version's rules, keys and circuits.
 */
import { describe, expect, it } from 'vitest';
import type { VaultRecord } from '@/application/partyPorts';
import { finalizeBlockers, runPartyAction, type PartyContext } from '@/application/partyService';
import { ACTIONS, cashFinancingWaiver } from '@/domain/lifecycle';
import type { Caller } from '@/domain/roles';
import { contractConfig } from '@/infrastructure/config/network';
import { allCircuitIds } from '@/infrastructure/contract/compiled';
import { resolveVersion } from '@/infrastructure/contract/compat';
import { CURRENT_VERSION, SUPPORTED_VERSIONS, circuitsOf, detectVersion, versionById, zkPathOf } from '@/infrastructure/contract/versions';
import { termsCrypto } from '@/infrastructure/crypto/termsCrypto';
import { BUYER_KEY, K, SELLER_KEY, configuredEscrow, configuredLoanEscrow, hex, rid } from './helpers/fixtures';

const V2 = versionById('v2')!;
type Sim = Awaited<ReturnType<typeof configuredEscrow>>['sim'];
const party = (sim: Sim, sk: Uint8Array, record: VaultRecord): PartyContext => ({ gateway: sim.gateway(), crypto: termsCrypto, record, secretKey: sk });
async function act(ctx: PartyContext, caller: Caller, circuit: Parameters<typeof runPartyAction>[2], args: unknown[] = []) {
  const out = await runPartyAction(ctx, caller, circuit as never, args as never);
  ctx.record = out.record;
  return out.receipt;
}

/** Accepts, finalizes, deposits and opens the review of a configured cash escrow. */
async function toReview(sim: Sim, pkg: Awaited<ReturnType<typeof configuredEscrow>>['pkg'], casp: Awaited<ReturnType<typeof configuredEscrow>>['casp']) {
  const buyer = party(sim, K.buyer, { terms: pkg, kyc: { buyer: casp.bundle(rid(K.buyer), BUYER_KEY) }, backups: [{ at: 1, kind: 'file' }] });
  const seller = party(sim, K.seller, { terms: pkg, kyc: { seller: casp.bundle(rid(K.seller), SELLER_KEY, { travelRuleRef: hex(5) }) } });
  const v0 = sim.view();
  await act(buyer, 'buyer', 'acceptConfiguration', [v0.configVersion]);
  await act(seller, 'seller', 'acceptConfiguration', [v0.configVersion]);
  await sim.finalize(K.admin);
  await act(buyer, 'buyer', 'depositToEscrow');
  await act(seller, 'seller', 'openContingencyReview');
  return { buyer, seller };
}

describe('supported versions', () => {
  it('match midnight.config.json and each has its own key path', () => {
    expect(CURRENT_VERSION.id).toBe(contractConfig.version);
    expect(SUPPORTED_VERSIONS.filter((v) => !v.current).map((v) => v.name)).toEqual((contractConfig.previousVersions ?? []).map((p) => p.name));
    expect(zkPathOf(CURRENT_VERSION)).toBe(`/zk/${contractConfig.name}`);
    expect(zkPathOf(V2)).toBe('/zk/escrow-v2');
  });

  it('share the ledger layout and witnesses (one EscrowView decoder serves them all)', () => {
    const shape = (info: unknown) => {
      const i = info as { ledger: unknown; witnesses: unknown };
      return JSON.stringify({ ledger: i.ledger, witnesses: i.witnesses });
    };
    for (const v of SUPPORTED_VERSIONS) expect(shape(v.info)).toBe(shape(CURRENT_VERSION.info));
  });

  it('v2 still has the financing attestation; the current version does not', () => {
    expect(circuitsOf(V2)).toContain('submitFinancing');
    expect(allCircuitIds()).not.toContain('submitFinancing');
    expect(allCircuitIds(V2)).toEqual(circuitsOf(V2));
  });
});

describe('detecting an escrow’s version from its on-chain circuits', () => {
  it('a fully registered escrow is unambiguous', () => {
    expect(detectVersion(circuitsOf(V2))?.id).toBe('v2');
    expect(detectVersion(circuitsOf(CURRENT_VERSION))?.id).toBe(CURRENT_VERSION.id);
  });

  it('a staged deploy (deploy circuits only) is the current version unless the vault recorded another', () => {
    expect(detectVersion(contractConfig.deployCircuits)?.id).toBe(CURRENT_VERSION.id);
    expect(detectVersion(contractConfig.deployCircuits, 'v2')?.id).toBe('v2');
    expect(detectVersion(contractConfig.deployCircuits, 'v9')?.id).toBe(CURRENT_VERSION.id);
  });

  it('circuits no supported version has: clear CONTRACT_VERSION error', () => {
    expect(detectVersion([...circuitsOf(CURRENT_VERSION), 'someFutureCircuit'])).toBeNull();
    expect(() => resolveVersion('ab'.repeat(32), [...circuitsOf(V2), 'someFutureCircuit'])).toThrowError(/no longer supports.*someFutureCircuit/);
    expect(resolveVersion('ab'.repeat(32), circuitsOf(V2)).id).toBe('v2');
  });
});

describe('a contract v2 escrow keeps its v2 rules', () => {
  it('cash deal: the lender attests financing, then inspection and title close the review', async () => {
    const { sim, pkg, casp } = await configuredEscrow({ version: V2 });
    expect(sim.view().contractVersion).toBe('v2');
    await toReview(sim, pkg, casp);
    // v2: the deposit does NOT clear financing.
    expect(sim.view().contingencies.Financing).toMatchObject({ submitted: false, passed: false });
    expect(ACTIONS.submitFinancing.check(sim.view(), 'lender', BigInt(sim.time))).toBeNull();
    await act(party(sim, K.lender, {}), 'lender', 'submitFinancing', [true, hex(0x52)]);
    expect(sim.view().contingencies.Financing).toMatchObject({ submitted: true, passed: true });
    await act(party(sim, K.inspector, {}), 'inspector', 'submitInspection', [true, hex(0x51)]);
    await act(party(sim, K.title, {}), 'titleAgent', 'submitTitle', [true, hex(0x54)]);
    expect(sim.view().status).toBe('ReadyToClose');
  });

  it('cash deal: the buyer may waive financing instead, and the dispute resolver may void the lender’s result', async () => {
    const { sim, pkg, casp } = await configuredEscrow({ version: V2 });
    const { buyer } = await toReview(sim, pkg, casp);
    expect(cashFinancingWaiver(sim.view())).toBe('now');
    expect(ACTIONS.waiveContingency.check(sim.view(), 'buyer', BigInt(sim.time), 'Financing')).toBeNull();
    await act(buyer, 'buyer', 'waiveContingency', ['Financing']);
    expect(sim.view().contingencies.Financing).toMatchObject({ waived: true });
    expect(cashFinancingWaiver(sim.view())).toBe('hidden');

    const other = await configuredEscrow({ version: V2 });
    const r = await toReview(other.sim, other.pkg, other.casp);
    await act(party(other.sim, K.lender, {}), 'lender', 'submitFinancing', [false, hex(0x52)]);
    await act(r.buyer, 'buyer', 'openDispute');
    expect(ACTIONS.voidContingencyResult.check(other.sim.view(), 'resolver', BigInt(other.sim.time), 'Financing')).toBeNull();
  });

  it('v2 finalize still checks the cash-deal lender against the resolver and the seller', async () => {
    const { sim } = await configuredEscrow({ version: V2 });
    const v = { ...sim.view(), roles: { ...sim.view().roles, lender: sim.view().roles.seller } };
    expect(finalizeBlockers(v, {}, termsCrypto, 0n)).toContain('Attestors must be independent from the seller');
  });

  it('loan deals behave the same in both versions', async () => {
    for (const version of SUPPORTED_VERSIONS) {
      const { sim } = await configuredLoanEscrow(true, { version });
      expect(sim.view().contractVersion).toBe(version.id);
      expect(sim.view().financing.mode).toBe('Deposited');
      expect(ACTIONS.submitFinancing.check(sim.view(), 'lender', 0n)).not.toBeNull();
    }
  });
});

describe('the current version keeps its own rules', () => {
  it('cash deal: no financing attestation, nothing for the buyer to waive', async () => {
    const { sim, pkg, casp } = await configuredEscrow();
    await toReview(sim, pkg, casp);
    expect(sim.view().contingencies.Financing).toMatchObject({ submitted: true, passed: true });
    expect(ACTIONS.submitFinancing.check(sim.view(), 'lender', BigInt(sim.time))).toMatch(/no financing attestation/);
    expect(cashFinancingWaiver(sim.view())).toBe('hidden');
  });
});
