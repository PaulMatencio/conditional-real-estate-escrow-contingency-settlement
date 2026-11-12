'use client';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { FileSearch, Landmark, Printer, Stamp } from 'lucide-react';
import { buildCertificate, lockedFundsStatement } from '@/application/notaryService';
import { verifyOpening } from '@/application/termsService';
import { friendlyMessage } from '@/domain/errors';
import type { EscrowView } from '@/domain/escrowView';
import { isAttestationBundle, type Opening } from '@/domain/terms';
import { shortHex } from '@/domain/hex';
import { networkConfig } from '@/infrastructure/config/network';
import { documentCommitment } from '@/infrastructure/crypto/escrowCrypto';
import { termsCrypto } from '@/infrastructure/crypto/termsCrypto';
import { readPublicView } from '@/infrastructure/gateway/publicReader';
import { useEscrow } from '../../providers/EscrowProvider';
import { useT } from '../../i18n';
import { Alert, Badge, Card, Field } from '../ui';
import { StatusOverview } from '../party/StatusOverview';
import { CustodianCard } from './CustodianCard';
import { VaultBackupSection, backupEscrows } from '../vault/VaultBackup';
import { FilePick, downloadJson, readFileBytes, readJsonFile } from '../party/helpers';

type Verdict = { label: string; ok: boolean; detail: string };

/**
 * Notary & Land Registry Verification Portal (§3.1.4, FR-NOTARY-01..03). Read-only, no wallet: live state from the
 * indexer, local verification of openings, documents and CASP records (nothing is uploaded), certificate export.
 */
export function NotaryPortal({ address }: { address?: string }) {
  const { t } = useT();
  const router = useRouter();
  const { sim } = useEscrow();
  const [input, setInput] = useState(address ?? '');
  const [view, setView] = useState<EscrowView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [openings, setOpenings] = useState<Opening[]>([]);
  const [verdicts, setVerdicts] = useState<Verdict[]>([]);
  const [docSalt, setDocSalt] = useState('');

  const load = useCallback(async () => {
    if (!address) return;
    try {
      const a = address.toLowerCase();
      setView(sim && sim.contractAddress === a ? sim.view() : await readPublicView(a));
      setErr(null);
    } catch (e) {
      setErr(friendlyMessage(e));
    }
  }, [address, sim]);
  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 20_000);
    return () => clearInterval(id);
  }, [load]);

  const now = BigInt(sim && view && sim.contractAddress === view.contractAddress ? sim.time : Math.floor(Date.now() / 1000));
  const add = (v: Verdict) => setVerdicts((x) => [v, ...x]);

  /** Verifies an opening (from a file or from the custodian copy) and, if it matches, adds it to the certificate. */
  const acceptOpening = (o: Opening, label: string) => {
    if (!view) return;
    const r = verifyOpening(termsCrypto, o, view);
    if (r.ok) setOpenings((x) => [...x.filter((y) => y.kind !== o.kind), o]);
    add({ label, ...r });
  };

  const onOpening = async (f: File) => {
    if (!view) return;
    const o = await readJsonFile<Opening>(f);
    if (o?.format !== 'EscrowOpeningV1') return add({ label: f.name, ok: false, detail: t('notary.notOpening') });
    const r = verifyOpening(termsCrypto, o, view);
    if (r.ok) setOpenings((x) => [...x.filter((y) => y.kind !== o.kind), o]);
    add({ label: `${t('notary.opening')} ${o.kind}`, ...r });
  };

  const onDocument = async (f: File) => {
    if (!view) return;
    if (!/^[0-9a-fA-F]{64}$/.test(docSalt.trim())) return add({ label: f.name, ok: false, detail: t('notary.needSalt') });
    const h = await documentCommitment(await readFileBytes(f), docSalt.trim());
    const hit = Object.entries(view.contingencies).find(([, c]) => c.reportHash === h)?.[0] ?? (view.voidedReportHistory.some((v) => v.reportHash === h) ? 'voided report' : null);
    add({ label: f.name, ok: !!hit, detail: hit ? `${t('notary.docMatches')} ${hit}` : t('notary.docNoMatch') });
  };

  const onCasp = async (f: File) => {
    if (!view) return;
    const b = await readJsonFile(f);
    if (!isAttestationBundle(b)) return add({ label: f.name, ok: false, detail: t('kyc.badFile') });
    const issuer = view.kycIssuers.find((i) => i.issuerId === b.issuerId.toLowerCase());
    const sig = issuer ? termsCrypto.verifyBundleSignature(b, issuer.publicKey) : false;
    const ref = termsCrypto.kycReference(b);
    const anchored = ref === view.buyerKyc.ref ? 'buyerKycRef' : ref === view.sellerKyc.ref ? 'sellerKycRef' : null;
    add({ label: `CASP ${f.name}`, ok: sig && !!anchored, detail: `${issuer ? (sig ? t('casp.sigOk') : t('casp.sigBad')) : t('casp.notWhitelisted')} · ${anchored ? `${t('notary.anchoredAs')} ${anchored}` : t('notary.notAnchored')}` });
  };

  return (
    <main id="main" className="mx-auto max-w-6xl space-y-4 px-4 py-6 print:max-w-none">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold text-white">
          <Landmark className="text-accent" aria-hidden /> {t('page.notary.title')}
        </h1>
        <p className="text-sm text-slate-400">{t('page.notary.subtitle')}</p>
      </div>
      <Card className="print:hidden">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const a = input.trim().toLowerCase().replace(/^0x/, '');
            if (/^[0-9a-f]{64}$/.test(a)) router.push(`/verify/${a}`);
            else setErr(t('role.badKey'));
          }}
        >
          <input className="input mono" value={input} onChange={(e) => setInput(e.target.value)} aria-label={t('contract.address')} placeholder={t('contract.address')} spellCheck={false} />
          <button type="submit" className="btn-primary">{t('notary.verify')}</button>
        </form>
        <p className="mt-2 text-xs text-slate-500">{t('notary.network')}: {networkConfig.networkId} · {t('notary.local')}</p>
      </Card>
      {err && <Alert tone="bad" onClose={() => setErr(null)}>{err}</Alert>}

      {view && (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-4">
            <Card title={t('notary.locked')} icon={<Stamp size={16} aria-hidden />}>
              {(() => {
                const l = lockedFundsStatement(view);
                const price = openings.find((o) => o.kind === 'amount');
                return (
                  <>
                    <Alert tone={l.locked ? 'ok' : 'warn'}>{l.statement}</Alert>
                    {price && price.kind === 'amount' && <Alert tone="ok">{t('notary.priceVerified')}: {price.amount} {view.escrowTicker}</Alert>}
                  </>
                );
              })()}
            </Card>
            <Card title={t('notary.verifier')} icon={<FileSearch size={16} aria-hidden />} className="print:hidden">
              <p className="mb-3 text-sm text-slate-400">{t('notary.verifierHint')}</p>
              <div className="flex flex-wrap gap-2">
                <FilePick label={t('notary.loadOpening')} accept="application/json,.json" onFile={(f) => void onOpening(f)} />
                <FilePick label={t('notary.loadCasp')} accept="application/json,.json" onFile={(f) => void onCasp(f)} />
              </div>
              <Field label={t('notary.docSalt')} tip={t('tip.notary.docSalt')} htmlFor="doc-salt">
                <div className="flex gap-2">
                  <input id="doc-salt" className="input mono" value={docSalt} onChange={(e) => setDocSalt(e.target.value)} spellCheck={false} />
                  <FilePick label={t('notary.loadDoc')} onFile={(f) => void onDocument(f)} />
                </div>
              </Field>
              <ul className="space-y-1 text-sm" aria-live="polite">
                {verdicts.map((v, i) => (
                  <li key={i} className="flex flex-wrap items-center gap-2">
                    <Badge tone={v.ok ? 'ok' : 'bad'}>{v.ok ? '✓' : '✗'}</Badge>
                    <span className="text-slate-300">{v.label}</span>
                    <span className="text-slate-500">{v.detail}</span>
                  </li>
                ))}
              </ul>
            </Card>
            <CustodianCard view={view} onOpening={(o) => acceptOpening(o, `${t('notary.opening')} ${o.kind} (${t('custody.badge')})`)} />
            <Card title={t('notary.certificate')} className="print:hidden">
              <p className="mb-3 text-sm text-slate-400">{t('notary.certificateHint')}</p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => downloadJson(`eu-notarial-escrow-certificate-${shortHex(view.contractAddress, 8, 0)}.json`, buildCertificate(termsCrypto, view, { network: networkConfig.networkId, openings }))}
                >
                  {t('notary.exportJson')}
                </button>
                <button type="button" className="btn-ghost" onClick={() => window.print()}>
                  <Printer size={14} aria-hidden /> {t('notary.print')}
                </button>
              </div>
            </Card>
          </div>
          <StatusOverview view={view} now={now} />
        </div>
      )}
      <VaultBackupSection
        contractAddress={address ?? null}
        onRestored={async (b) => {
          // Custodian restoring on a fresh address: open the escrow whose terms it holds, if there is just one.
          const ids = backupEscrows(b).filter((id) => !!b.records[id].custody);
          if (!address && ids.length === 1) router.push(`/verify/${ids[0]}`);
        }}
      />
    </main>
  );
}
