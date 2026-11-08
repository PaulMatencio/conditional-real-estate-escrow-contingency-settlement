/**
 * CaspGateway over HTTP. In the browser it talks to the dApp's own `/api/casp/*` proxy (same origin, CSP-friendly,
 * tokens stay server-side); in tests or scripts it can point straight at the simulator (http://127.0.0.1:8787).
 * NFR-07: request bodies carry only role ids and the shielded payout key the CASP must bind — never amounts or salts.
 */
import type { CaspGateway } from '@/application/partyPorts';
import { AppError } from '@/domain/errors';
import { isAttestationBundle, isRevocationBundle, type AttestationBundle, type RevocationBundle } from '@/domain/terms';

export const CASP_PERSONAS = [
  { id: 'buyer-clean', expect: 'approve · level 2' },
  { id: 'seller-clean', expect: 'approve · level 2' },
  { id: 'buyer-corporate-edd', expect: 'approve · level 3' },
  { id: 'buyer-pep-edd', expect: 'approve · level 3, elevated score' },
  { id: 'buyer-basic-only', expect: 'approve · level 1 (below policy 2)' },
  { id: 'buyer-pep-no-edd', expect: 'refer · no attestation' },
  { id: 'buyer-high-risk', expect: 'reject' },
  { id: 'buyer-sanctioned', expect: 'reject · sanctions hit' },
  { id: 'buyer-unverified', expect: 'refer · no attestation' }
] as const;

export class HttpCaspGateway implements CaspGateway {
  constructor(
    private readonly base = '/api/casp',
    private readonly fetchFn: typeof fetch = (...a) => fetch(...a)
  ) {}

  private async req<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.base}${path}`, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store'
      });
    } catch (e) {
      throw new AppError('CASP', `CASP simulator unreachable: ${(e as Error).message}`, { cause: e });
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON error page */
    }
    if (!res.ok) {
      const j = json as { error?: string; message?: string } | null;
      throw new AppError('CASP', `CASP ${res.status}: ${j?.message ?? j?.error ?? text.slice(0, 200)}`);
    }
    return json as T;
  }

  health() {
    return this.req<{ ok: boolean; casp: string; testOnly?: boolean }>('GET', '/health');
  }

  issuerKeys() {
    return this.req<Awaited<ReturnType<CaspGateway['issuerKeys']>>>('GET', '/.well-known/casp-keys');
  }

  async personaAttestation(persona: string, r: { subject: string; walletKey: string; role: 'originator' | 'beneficiary'; validityDays?: number }) {
    const out = await this.req<Awaited<ReturnType<CaspGateway['personaAttestation']>>>('POST', `/test/personas/${encodeURIComponent(persona)}/attestation`, r);
    if (out.bundle !== null && !isAttestationBundle(out.bundle)) throw new AppError('CASP', 'The CASP returned an unexpected attestation format.');
    return out;
  }

  async revokeAttestation(reference: string, reason: string): Promise<RevocationBundle> {
    const b = await this.req<RevocationBundle>('POST', `/attestations/${encodeURIComponent(reference)}/revoke`, { reason });
    if (!isRevocationBundle(b)) throw new AppError('CASP', 'The CASP returned an unexpected revocation format.');
    return b;
  }

  async revokeIssuer(issuerId: string, reason: string): Promise<RevocationBundle> {
    const b = await this.req<RevocationBundle>('POST', `/issuer/keys/${encodeURIComponent(issuerId)}/revoke`, { reason });
    if (!isRevocationBundle(b)) throw new AppError('CASP', 'The CASP returned an unexpected revocation format.');
    return b;
  }

  attestationStatus(reference: string) {
    return this.req<Record<string, unknown>>('GET', `/attestations/${encodeURIComponent(reference)}`);
  }

  travelRule(reference: string) {
    return this.req<Record<string, unknown>>('GET', `/travel-rule/${encodeURIComponent(reference)}`);
  }
}

export type { AttestationBundle };
