'use client';
import { useCallback, useEffect, useState } from 'react';
import { Ban, Building, RefreshCw, Search } from 'lucide-react';
import type { CaspIssuerKey } from '@/application/partyPorts';
import { friendlyMessage } from '@/domain/errors';
import type { EscrowView } from '@/domain/escrowView';
import { isRevocationBundle, type RevocationBundle } from '@/domain/terms';
import { shortHex } from '@/domain/hex';
import { pointFromWire, sigFromWire, verifyAttestationRevocation, verifyIssuerRevocation } from '@/infrastructure/crypto/escrowCrypto';
import { readPublicView } from '@/infrastructure/gateway/publicReader';
import { useApp } from '../../providers/AppProvider';
import { useEscrow } from '../../providers/EscrowProvider';
import { useT } from '../../i18n';
import { Alert, Badge, Card, Field } from '../ui';
import { ModeBar } from '../party/PartySetup';
import { StatusOverview } from '../party/StatusOverview';
import { FilePick, readJsonFile } from '../party/helpers';

/**
 * Compliance console (§3.1.1, FR-KYC-03..05): CASP connectivity and keys vs the escrow's whitelist, a one-click
 * broadcaster for CASP-signed revocations (permissionless circuits), and attestation / Travel Rule / source-of-funds
 * status from the CASP. Talks to the eu-counterparty-simulator through /api/casp (TEST ONLY).
 *
 * Monitoring needs no wallet: without one, the escrow is read straight from the indexer (like the Notary portal).
 * Only broadcasting a revocation is a transaction, so only that asks for a wallet (it pays the fee).
 */
export function ComplianceConsole() {
  const { t } = useT();
  const { casp, view: walletView, now: walletNow, run, busy, error, setError, mode, contractAddress } = useEscrow();
  const { connector } = useApp();
  const walletConnected = connector.status === 'connected';
  const [publicView, setPublicView] = useState<EscrowView | null>(null);
  const [publicErr, setPublicErr] = useState<string | null>(null);
  // Wallet Mode with an address but no wallet: read the public ledger from the indexer instead (refreshed every 20 s).
  const readOnly = mode === 'wallet' && !!contractAddress && !walletConnected;
  // midnight-js retries a failing indexer for a long time instead of failing: never start a read while one is still
  // running, and say so after 15 s rather than showing nothing.
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setPublicView(null);
    setPublicErr(null);
    setSlow(false);
    if (!readOnly || !contractAddress) return;
    let live = true;
    let inFlight = false;
    const read = async () => {
      if (inFlight) return;
      inFlight = true;
      const timer = setTimeout(() => live && setSlow(true), 15_000);
      try {
        const v = await readPublicView(contractAddress);
        if (live) (setPublicView(v), setPublicErr(null));
      } catch (e) {
        if (live) setPublicErr(friendlyMessage(e));
      } finally {
        clearTimeout(timer);
        inFlight = false;
        if (live) setSlow(false);
      }
    };
    void read();
    const id = setInterval(() => void read(), 20_000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [readOnly, contractAddress]);
  const view = walletView ?? (readOnly ? publicView : null);
  const now = walletView ? walletNow : BigInt(Math.floor(Date.now() / 1000));
  const [health, setHealth] = useState<string | null>(null);
  const [keys, setKeys] = useState<CaspIssuerKey[]>([]);
  const [caspErr, setCaspErr] = useState<string | null>(null);
  const [ref, setRef] = useState('');
  const [reason, setReason] = useState('');
  const [revocation, setRevocation] = useState<RevocationBundle | null>(null);
  const [status, setStatus] = useState<Record<string, unknown> | null>(null);

  const load = useCallback(async () => {
    setCaspErr(null);
    try {
      const h = await casp.health();
      setHealth(`${h.casp}${h.testOnly ? ' (TEST)' : ''}`);
      setKeys((await casp.issuerKeys()).keys);
    } catch (e) {
      setHealth(null);
      setCaspErr((e as Error).message);
    }
  }, [casp]);
  useEffect(() => void load(), [load]);

  const whitelisted = (id: string) => view?.kycIssuers.some((i) => i.issuerId === id.toLowerCase()) ?? false;
  const sigOk = (b: RevocationBundle) => {
    const issuer = view?.kycIssuers.find((i) => i.issuerId === b.issuerId.toLowerCase());
    if (!issuer) return false;
    const pk = pointFromWire(issuer.publicKey);
    return b.kind === 'attestation' ? verifyAttestationRevocation(pk, b.reference ?? '', sigFromWire(b.signature)) : verifyIssuerRevocation(pk, b.issuerId, sigFromWire(b.signature));
  };

  const broadcast = async (b: RevocationBundle) => {
    if (b.kind === 'attestation') await run('anyone', 'revokeKycAttestation', [b.issuerId, b.reference!, b.signature]);
    else await run('anyone', 'revokeKycIssuer', [b.issuerId, b.signature]);
  };

  return (
    <main id="main" className="mx-auto max-w-6xl space-y-4 px-4 py-6">
      <div>
        <h1 className="text-2xl font-semibold text-white">{t('page.compliance.title')}</h1>
        <p className="text-sm text-slate-400">{t('page.compliance.subtitle')}</p>
      </div>
      <ModeBar walletNote={t('compliance.walletNote')} />
      {readOnly && publicErr && <Alert tone="bad" onClose={() => setPublicErr(null)}>{t('compliance.readFailed')} ({publicErr})</Alert>}
      {readOnly && !publicView && slow && <Alert tone="warn">{t('compliance.indexerSlow')}</Alert>}
      {error && <Alert tone="bad" onClose={() => setError(null)}>{error}</Alert>}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <Card title={t('casp.title')} tip={t('tip.casp.title')} icon={<Building size={16} aria-hidden />} actions={<button type="button" className="btn-ghost !p-1.5" onClick={() => void load()} aria-label={t('common.refresh')}><RefreshCw size={14} /></button>}>
            {health ? <Alert tone="ok">{t('casp.connected')}: {health}</Alert> : <Alert tone="bad">{caspErr ?? t('casp.offline')}</Alert>}
            <ul className="mt-3 space-y-2 text-sm">
              {keys.map((k) => (
                <li key={k.issuerId} className="flex flex-wrap items-center gap-2">
                  <span className="mono">{shortHex(k.issuerId)}</span>
                  <Badge tone={k.status === 'active' ? 'ok' : 'bad'}>{k.status}</Badge>
                  {view && <Badge tone={whitelisted(k.issuerId) ? 'ok' : 'muted'}>{whitelisted(k.issuerId) ? t('casp.whitelisted') : t('casp.notWhitelisted')}</Badge>}
                </li>
              ))}
            </ul>
          </Card>

          <Card title={t('casp.revoke')} icon={<Ban size={16} aria-hidden />}>
            <p className="mb-3 text-sm text-slate-400">{t('casp.revokeHint')}</p>
            <Field label={t('casp.reference')} tip={t('tip.casp.reference')} htmlFor="rev-ref">
              <input id="rev-ref" className="input mono" value={ref} onChange={(e) => setRef(e.target.value)} spellCheck={false} />
            </Field>
            {view && (
              <div className="mb-2 flex flex-wrap gap-2 text-xs">
                {view.buyerKyc.verified && <button type="button" className="btn-ghost !py-1" onClick={() => setRef(view.buyerKyc.ref)}>buyerKycRef</button>}
                {view.sellerKyc.verified && <button type="button" className="btn-ghost !py-1" onClick={() => setRef(view.sellerKyc.ref)}>sellerKycRef</button>}
              </div>
            )}
            <Field label={t('casp.reason')} htmlFor="rev-reason">
              <input id="rev-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="btn-ghost"
                disabled={!ref.trim()}
                onClick={() => void casp.revokeAttestation(ref.trim(), reason || 'unspecified').then(setRevocation, (e) => setCaspErr(e.message))}
              >
                {t('casp.requestRevocation')}
              </button>
              <FilePick
                label={t('casp.importRevocation')}
                accept="application/json,.json"
                onFile={(f) =>
                  void readJsonFile(f).then((b) => {
                    if (!isRevocationBundle(b)) throw new Error(t('kyc.badFile'));
                    setRevocation(b);
                  }).catch((e) => setCaspErr(e.message))
                }
              />
              <button type="button" className="btn-ghost" disabled={!ref.trim()} onClick={() => void casp.attestationStatus(ref.trim()).then(setStatus, (e) => setCaspErr(e.message))}>
                <Search size={14} aria-hidden /> {t('casp.status')}
              </button>
              <button type="button" className="btn-ghost" disabled={!ref.trim()} onClick={() => void casp.travelRule(ref.trim()).then(setStatus, (e) => setCaspErr(e.message))}>
                {t('casp.travelRule')}
              </button>
            </div>
            {caspErr && <Alert tone="bad" onClose={() => setCaspErr(null)}>{caspErr}</Alert>}
            {revocation && (
              <div className="mt-3 space-y-2 text-sm">
                <p>
                  {revocation.kind} · issuer <span className="mono">{shortHex(revocation.issuerId)}</span> {revocation.reference && <>· ref <span className="mono">{shortHex(revocation.reference)}</span></>}
                </p>
                {view ? (
                  sigOk(revocation) ? <Alert tone="ok">{t('casp.sigOk')}</Alert> : <Alert tone="bad">{t('casp.sigBad')}</Alert>
                ) : (
                  <Alert tone="warn">{t('party.noEscrow')}</Alert>
                )}
                {view && view.revokedKycRefs.includes((revocation.reference ?? '').toLowerCase()) && <Alert tone="ok">{t('casp.alreadyRevoked')}</Alert>}
                <button type="button" className="btn-danger" disabled={busy || !view || !sigOk(revocation) || !walletConnected} onClick={() => void broadcast(revocation)}>
                  {t('casp.broadcast')}
                </button>
                {!walletConnected && <p className="text-xs text-slate-400">{t('compliance.broadcastNeedsWallet')}</p>}
              </div>
            )}
            {status && (
              <div className="mt-3">
                <h3 className="label">{t('casp.record')}</h3>
                <pre className="mono max-h-64 overflow-auto rounded-lg bg-midnight-900 p-2 text-slate-300">{JSON.stringify(status, null, 2)}</pre>
                <p className="mt-1 text-xs text-slate-500">{t('casp.sof')}</p>
              </div>
            )}
          </Card>
        </div>
        <div>{view ? <StatusOverview view={view} now={now} compact={false} /> : <Alert tone="warn">{t('party.noEscrow')}</Alert>}</div>
      </div>
    </main>
  );
}
