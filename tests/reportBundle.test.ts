import { describe, expect, it } from 'vitest';
import type { ContingencyName, ContingencyState } from '@/domain/escrowView';
import { isDocumentBundle, matchReport, type DocumentBundle } from '@/domain/report';
import { b64, generateRecipientKeyPair, openEnvelope, openWithPassphrase, sealTo, sealWithPassphrase, unb64 } from '@/infrastructure/crypto/aead';
import { documentCommitment, newSalt } from '@/infrastructure/crypto/escrowCrypto';

const empty: ContingencyState = { submitted: false, passed: false, waived: false, reportHash: '0'.repeat(64) };
const viewWith = (c: Partial<Record<ContingencyName, ContingencyState>>, voided: string[] = []) => ({
  contingencies: { Inspection: empty, Financing: empty, Title: empty, ...c },
  voidedReportHistory: voided.map((reportHash, i) => ({ index: BigInt(i), reportHash }))
});

async function bundleFor(text: string): Promise<DocumentBundle> {
  const bytes = new TextEncoder().encode(text);
  const salt = newSalt();
  return { format: 'EscrowDocumentBundleV1', contingency: 'Inspection', fileName: 'inspection.pdf', salt, reportHash: await documentCommitment(bytes, salt), document: b64(bytes) };
}

/** What the buyer's browser does: recompute from the file and the salt, never trust the bundle's own hash. */
const verify = async (b: DocumentBundle, view: ReturnType<typeof viewWith>) => matchReport(view, await documentCommitment(unb64(b.document), b.salt), b.contingency);

describe('report bundle (buyer checks the inspection report)', () => {
  it('a passphrase-sealed bundle opens and matches the anchored inspection report', async () => {
    const b = await bundleFor('Inspection report: roof OK');
    const opened = await openWithPassphrase<unknown>(await sealWithPassphrase(b, 'correct horse'), 'correct horse');
    expect(isDocumentBundle(opened)).toBe(true);
    const view = viewWith({ Inspection: { submitted: true, passed: true, waived: false, reportHash: b.reportHash } });
    expect(await verify(opened as DocumentBundle, view)).toEqual({ kind: 'current', contingency: 'Inspection', submitted: true, passed: true });
  });

  it('a bundle sealed to the buyer’s envelope key opens only with that key', async () => {
    const buyer = await generateRecipientKeyPair();
    const b = await bundleFor('report');
    expect(await openEnvelope(await sealTo(b, buyer.publicKey), buyer)).toEqual(b);
  });

  it('a modified report, or a bundle that lies about its hash, does not match', async () => {
    const b = await bundleFor('original');
    const view = viewWith({ Inspection: { submitted: true, passed: false, waived: false, reportHash: b.reportHash } });
    expect(await verify({ ...b, document: b64(new TextEncoder().encode('edited')) }, view)).toEqual({ kind: 'none' });
    const other = await bundleFor('other');
    expect(await verify({ ...other, reportHash: b.reportHash }, view)).toEqual({ kind: 'none' });
  });

  it('a report the resolver voided is reported as voided, not as the current result', async () => {
    const b = await bundleFor('first report');
    expect(await verify(b, viewWith({}, [b.reportHash]))).toEqual({ kind: 'voided', contingency: 'Inspection' });
  });

  it('an empty (all-zero) report hash on-chain never matches', () => {
    expect(matchReport(viewWith({}), '0'.repeat(64))).toEqual({ kind: 'none' });
  });
});
