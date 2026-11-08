'use client';
import { useState } from 'react';
import { BadgeCheck } from 'lucide-react';
import { precheckAttestation } from '@/application/termsService';
import { shortHex } from '@/domain/hex';
import { isAttestationBundle } from '@/domain/terms';
import { CASP_PERSONAS } from '@/infrastructure/casp/httpCaspGateway';
import { termsCrypto } from '@/infrastructure/crypto/termsCrypto';
import { useEscrow } from '../../providers/EscrowProvider';
import { useT } from '../../i18n';
import { Alert, Badge, Card, Field } from '../ui';
import { Countdown, FilePick, fmtTime, readJsonFile } from './helpers';

/**
 * FR-KYC-01/02 for the buyer (originator) or seller (beneficiary): get a CASP-signed KycAttestationV1 bound to this
 * role id and the committed payout key — from the CASP simulator (TEST) or a file — and pre-check it before proving.
 */
export function KycPanel({ party }: { party: 'buyer' | 'seller' }) {
  const { t } = useT();
  const { record, updateRecord, view, now, casp, mode } = useEscrow();
  const [persona, setPersona] = useState(party === 'seller' ? 'seller-clean' : 'buyer-clean');
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad' | 'warn'; text: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const bundle = record.kyc?.[party];
  const check = bundle && view ? precheckAttestation(termsCrypto, bundle, view, party, record.terms?.terms, Number(now)) : null;
  const wallet = party === 'buyer' ? record.terms?.terms.buyerPayout : record.terms?.terms.sellerPayout;
  const subject = view?.roles[party];

  const store = async (b: unknown) => {
    if (!isAttestationBundle(b)) throw new Error(t('kyc.badFile'));
    await updateRecord((r) => ({ ...r, kyc: { ...(r.kyc ?? {}), [party]: b } }));
  };

  const request = async () => {
    setLoading(true);
    setMsg(null);
    try {
      if (!subject || !wallet) throw new Error(t('kyc.needTerms'));
      const out = await casp.personaAttestation(persona, { subject, walletKey: wallet, role: party === 'buyer' ? 'originator' : 'beneficiary' });
      if (!out.bundle) {
        setMsg({ tone: 'warn', text: `${t('kyc.notIssued')}: ${out.assessment.decision} (KYC ${out.assessment.kycLevel}, AML ${out.assessment.amlRiskScore}) ${out.assessment.reasons.join('; ')}` });
        return;
      }
      await store(out.bundle);
      setMsg({ tone: 'ok', text: `${t('kyc.issued')} ${out.assessment.decision} · KYC ${out.assessment.kycLevel} · AML ${out.assessment.amlRiskScore}` });
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as Error).message });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card title={t(party === 'buyer' ? 'kyc.titleBuyer' : 'kyc.titleSeller')} icon={<BadgeCheck size={16} aria-hidden />}>
      <p className="mb-3 text-sm text-slate-400">{t('kyc.hint')}</p>
      <div className="mb-3 grid gap-3">
        <Field label={t('kyc.persona')} htmlFor={`persona-${party}`} hint={t('kyc.personaHint')}>
          <select id={`persona-${party}`} className="input" value={persona} onChange={(e) => setPersona(e.target.value)}>
            {CASP_PERSONAS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.id} — {p.expect}
              </option>
            ))}
          </select>
        </Field>
        <div className="flex items-end gap-2">
          <button type="button" className="btn-primary" disabled={loading || !wallet} onClick={() => void request()}>
            {t('kyc.request')}
          </button>
          <FilePick label={t('kyc.importFile')} accept="application/json,.json" onFile={(f) => void readJsonFile(f).then(store).then(() => setMsg({ tone: 'ok', text: t('kyc.imported') }), (e) => setMsg({ tone: 'bad', text: e.message }))} />
        </div>
      </div>
      {mode === 'simulator' && <p className="mb-2 text-xs text-slate-500">{t('kyc.simNote')}</p>}
      {msg && <Alert tone={msg.tone} onClose={() => setMsg(null)}>{msg.text}</Alert>}

      {bundle && check && (
        <div className="mt-3 space-y-2 text-sm" aria-live="polite">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={check.ok ? 'ok' : 'bad'}>{check.ok ? t('kyc.precheckOk') : t('kyc.precheckFail')}</Badge>
            <span className="text-slate-400">
              issuer {shortHex(bundle.issuerId)} · ref {shortHex(check.reference)} · {t('status.validUntil')} {fmtTime(bundle.attestation.validUntil)}
            </span>
          </div>
          {check.problems.map((p) => (
            <Alert key={p} tone="bad">{p}</Alert>
          ))}
          {check.warnings.map((w) => (
            <Alert key={w} tone="warn">{w}</Alert>
          ))}
        </div>
      )}
      {party === 'seller' && view?.sellerKyc.verified && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Countdown to={view.sellerKyc.validUntil} now={now} label={t('kyc.onchainExpiry')} />
          {Number(view.sellerKyc.validUntil) - Number(now) < 3 * 86400 && <Alert tone="warn">{t('kyc.renew')}</Alert>}
        </div>
      )}
    </Card>
  );
}
