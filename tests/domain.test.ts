import { describe, expect, it } from 'vitest';
import { classifyContractError } from '@/domain/contractErrors';
import { friendlyMessage, AppError } from '@/domain/errors';
import { availableActions, enabledActions, nextDeadline } from '@/domain/lifecycle';
import { rolesOf, roleFromSlug } from '@/domain/roles';
import { lockedFundsStatement } from '@/application/notaryService';
import { BUYER_KEY, K, SELLER_KEY, configuredEscrow, rid } from './helpers/fixtures';

const none = { terms: false, kycAttestation: false, vaultCoin: false };
const all = { terms: true, kycAttestation: true, vaultCoin: true };

describe('lifecycle table', () => {
  const { sim } = configuredEscrow();
  const init = sim.view();
  it('offers acceptConfiguration to buyer and seller only while initializing', () => {
    expect(availableActions(init, 'buyer', 0n, none).find((a) => a.circuit === 'acceptConfiguration')?.enabled).toBe(true);
    expect(availableActions(init, 'inspector', 0n, none).some((a) => a.circuit === 'acceptConfiguration')).toBe(false);
  });
  it('requires local material for the deposit', () => {
    const created = { ...init, status: 'Created' as const };
    const dep = availableActions(created, 'buyer', 0n, none).find((a) => a.circuit === 'depositToEscrow');
    expect(dep).toMatchObject({ enabled: false, reason: expect.stringMatching(/private terms/) });
    expect(availableActions(created, 'buyer', 0n, all).find((a) => a.circuit === 'depositToEscrow')?.enabled).toBe(true);
    expect(availableActions(created, 'buyer', init.closingDeadline, all).find((a) => a.circuit === 'depositToEscrow')?.reason).toBe('Closing deadline has passed');
  });
  it('lists only valid resolver circuits in Disputed (resolveDisputeSettlement needs allCleared)', () => {
    const disputed = { ...init, status: 'Disputed' as const };
    expect(enabledActions(disputed, 'resolver', 0n, none).map((a) => a.circuit).sort()).toEqual(['dismissDispute', 'resolveDisputeRefund']);
    const cleared = { ...disputed, contingencies: { Inspection: { submitted: true, passed: true, waived: false, reportHash: '' }, Financing: { submitted: true, passed: true, waived: false, reportHash: '' }, Title: { submitted: true, passed: true, waived: true, reportHash: '' } } };
    expect(enabledActions(cleared, 'resolver', 0n, none).map((a) => a.circuit)).toContain('resolveDisputeSettlement');
  });
  it('expireEscrow is permissionless and time-gated', () => {
    const funded = { ...init, status: 'Funded' as const };
    expect(availableActions(funded, 'inspector', 0n, none).find((a) => a.circuit === 'expireEscrow')?.enabled).toBe(false);
    expect(availableActions(funded, 'inspector', init.closingDeadline, none).find((a) => a.circuit === 'expireEscrow')?.enabled).toBe(true);
  });
  it('nextDeadline follows the phase', () => {
    expect(nextDeadline({ ...init, status: 'Funded' })).toEqual({ kind: 'closing', at: init.closingDeadline });
    expect(nextDeadline({ ...init, status: 'Disputed' })).toEqual({ kind: 'dispute', at: init.disputeDeadline });
    expect(nextDeadline({ ...init, status: 'Closed' })).toBeNull();
  });
  it('rolesOf finds every role a key holds', () => {
    expect(rolesOf(init, rid(K.buyer))).toEqual(['buyer']);
    expect(rolesOf({ roles: { ...init.roles, lender: rid(K.buyer) } }, rid(K.buyer))).toEqual(['buyer', 'lender']);
    expect(roleFromSlug('title-agent')).toBe('titleAgent');
  });
  it('the notary statement reflects locked funds', () => {
    expect(lockedFundsStatement({ ...init, status: 'Funded' }).locked).toBe(true);
    expect(lockedFundsStatement({ ...init, status: 'Closed', disbursed: true }).locked).toBe(false);
  });
  void BUYER_KEY;
  void SELLER_KEY;
});

describe('error catalogue (§3.3)', () => {
  it.each([
    ['failed assert: ERROR_TERMS_MISMATCH: amount', 'TERMS_MISMATCH'],
    ['ERROR_DEPOSIT_COIN_MISMATCH', 'DEPOSIT_COIN_MISMATCH'],
    ['x ERROR_VAULT_COIN_MISMATCH y', 'VAULT_COIN_MISMATCH'],
    ['ERROR_NOT_WHITELISTED: issuer is not a trusted CASP', 'NOT_WHITELISTED'],
    ['ERROR_KYC_EXPIRED', 'KYC_EXPIRED'],
    ['ERROR_SELLER_KYC_REQUIRED', 'SELLER_KYC_REQUIRED'],
    ['failed assert: Dispute window is closed', 'PHASE_ROLE_DEADLINE'],
    ['Caller is not the buyer', 'PHASE_ROLE_DEADLINE'],
    ['something else', 'UNKNOWN']
  ])('%s → %s', (msg, code) => expect(classifyContractError(msg).code).toBe(code));
  it('friendlyMessage appends the guidance', () => {
    expect(friendlyMessage(new AppError('CONTRACT_REJECTED', 'boom: ERROR_KYC_REVOKED (during prove)'))).toMatch(/^ERROR_KYC_REVOKED — The attestation was revoked/);
  });
});
