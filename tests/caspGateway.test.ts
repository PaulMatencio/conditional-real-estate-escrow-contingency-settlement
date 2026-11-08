/**
 * CASP integration. The fixture was issued by the running eu-counterparty-simulator (POST
 * /test/personas/buyer-clean/attestation on port 8787), so these checks prove the dApp verifies real CASP output with
 * the escrow contract's own pure circuits (kycMessage, kycReference) and the in-circuit Schnorr scheme.
 */
import { describe, expect, it, vi } from 'vitest';
import { HttpCaspGateway } from '@/infrastructure/casp/httpCaspGateway';
import { termsCrypto } from '@/infrastructure/crypto/termsCrypto';
import live from './fixtures/casp-sim-buyer-clean.json';
import type { AttestationBundle } from '@/domain/terms';

const bundle = live.bundle as AttestationBundle;

describe('attestation issued by the live CASP simulator', () => {
  it('verifies with the contract-compatible Schnorr check', () => {
    expect(termsCrypto.verifyBundleSignature(bundle, bundle.issuerPublicKey)).toBe(true);
  });
  it('its reference equals the contract kycReference(att)', () => {
    expect(termsCrypto.kycReference(bundle)).toBe(bundle.reference);
  });
  it('a single changed claim breaks the signature', () => {
    expect(termsCrypto.verifyBundleSignature({ ...bundle, attestation: { ...bundle.attestation, kycLevel: 3 } }, bundle.issuerPublicKey)).toBe(false);
  });
});

describe('HttpCaspGateway', () => {
  it('posts persona onboarding through the proxy and validates the bundle shape', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(live), { status: 200 }));
    const gw = new HttpCaspGateway('/api/casp', fetchFn as unknown as typeof fetch);
    const out = await gw.personaAttestation('buyer-clean', { subject: '11'.repeat(32), walletKey: '65'.repeat(32), role: 'originator' });
    expect(out.bundle?.issuerId).toBe(bundle.issuerId);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/casp/test/personas/buyer-clean/attestation');
    expect(JSON.parse(String(init.body))).toEqual({ subject: '11'.repeat(32), walletKey: '65'.repeat(32), role: 'originator' });
  });
  it('surfaces CASP errors with their code', async () => {
    const gw = new HttpCaspGateway('/api/casp', (async () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })) as unknown as typeof fetch);
    await expect(gw.revokeAttestation('ab'.repeat(32), 'test')).rejects.toThrow(/CASP 401: unauthorized/);
  });
});
