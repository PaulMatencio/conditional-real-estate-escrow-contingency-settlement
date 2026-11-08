'use client';
import { CheckCircle2, CircleDashed, ListChecks, ShieldCheck, XCircle } from 'lucide-react';
import { CONTINGENCIES, INIT_ATTRIBUTES, authorityLevel, isZeroHex, type EscrowView, type MaintenanceStatus, type StatusName } from '@/domain/escrowView';
import { nextDeadline } from '@/domain/lifecycle';
import { shortHex } from '@/domain/hex';
import { useT } from '../../i18n';
import { Alert, Badge, Card, Mono, Stat } from '../ui';
import { Countdown, fmtTime } from './helpers';

const PATH: StatusName[] = ['Initializing', 'Created', 'Funded', 'ContingenciesPending', 'ReadyToClose', 'Closed'];
const tone = (s: StatusName) =>
  s === 'Closed' ? 'ok' : s === 'Cancelled' || s === 'Refunded' || s === 'Expired' ? 'bad' : s === 'Disputed' ? 'warn' : s === 'Initializing' ? 'muted' : 'accent';

/** Recommendation 3: who can still change this contract's rules, read from the chain. */
export function AuthorityBadge({ maintenance }: { maintenance: MaintenanceStatus | null }) {
  const { t } = useT();
  const level = authorityLevel(maintenance);
  if (level === 'unknown') return <p className="text-xs text-slate-500">{t('authority.unknown')}</p>;
  if (level === 'immutable') return <Alert tone="ok">{t('authority.immutable')}</Alert>;
  if (level === 'open') return <Alert tone="bad">{t('authority.open')}</Alert>;
  return (
    <Alert tone="warn">
      {t('authority.controlled')} ({maintenance!.threshold}/{maintenance!.committeeSize})
    </Alert>
  );
}

/** Public state of one escrow. Shared by every role page and the notary portal; shows commitments, never values. */
export function StatusOverview({ view, now, compact = false }: { view: EscrowView; now: bigint; compact?: boolean }) {
  const { t } = useT();
  const d = nextDeadline(view);
  const idx = PATH.indexOf(view.status);
  return (
    <div className="space-y-4">
      <Card title={t('status.title')} icon={<ShieldCheck size={16} aria-hidden />}>
        <div className="mb-4 flex flex-wrap items-center gap-2" aria-live="polite">
          <Badge tone={tone(view.status)}>{view.status}</Badge>
          <span className="text-xs text-slate-400">
            {t('status.round')} {view.lifecycleRound.toString()} · v{view.configVersion.toString()} · {view.escrowTicker}
          </span>
          {view.disbursed && <Badge tone="ok">{t('status.disbursed')}</Badge>}
        </div>
        <ol className="mb-4 flex flex-wrap gap-1 text-xs" aria-label={t('status.path')}>
          {PATH.map((s, i) => (
            <li key={s} className={`rounded-full border px-2 py-0.5 ${s === view.status ? 'border-accent bg-accent/20 text-white' : idx > i ? 'border-ok/40 text-ok' : 'border-midnight-600 text-slate-500'}`}>
              {s}
            </li>
          ))}
          {!PATH.includes(view.status) && <li className="rounded-full border border-warn/50 bg-warn/10 px-2 py-0.5 text-warn">{view.status}</li>}
        </ol>
        <div className="mb-3">
          <AuthorityBadge maintenance={view.maintenance} />
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          {d && <Countdown to={d.at} now={now} label={t(`deadline.${d.kind}`)} />}
          <Stat label={t('deadline.closing')} tip={t('tip.deadline.closing')} value={<span className="text-sm">{fmtTime(view.closingDeadline)}</span>} />
          <Stat label={t('deadline.dispute')} tip={t('tip.deadline.dispute')} value={<span className="text-sm">{fmtTime(view.disputeDeadline)}</span>} />
        </div>
      </Card>

      {view.status === 'Initializing' && (
        <Card title={t('status.checklist')} icon={<ListChecks size={16} aria-hidden />}>
          <ul className="grid gap-1.5 text-sm sm:grid-cols-2">
            {INIT_ATTRIBUTES.map((a) => {
              const set = view.configured.includes(a);
              const commitment = a === 'EscrowAmount' ? view.commitments.amount : a === 'BuyerPayout' ? view.commitments.buyerPayout : a === 'SellerPayout' ? view.commitments.sellerPayout : null;
              return (
                <li key={a} className="flex items-center gap-2">
                  {set ? <CheckCircle2 size={14} className="text-ok" aria-label="set" /> : <CircleDashed size={14} className="text-warn" aria-label="missing" />}
                  <span className="text-slate-300">{a}</span>
                  {set && commitment && <span className="mono text-slate-500" title={commitment}>{t('status.commitmentSet')} {shortHex(commitment)}</span>}
                </li>
              );
            })}
          </ul>
          <p className="mt-3 text-sm text-slate-400">
            {t('status.acceptance')}: buyer {view.buyerAccepted ? '✓' : '—'} · seller {view.sellerAccepted ? '✓' : '—'}
          </p>
        </Card>
      )}

      <Card title={t('status.contingencies')} tip={t('tip.status.contingencies')}>
        <ul className="space-y-2 text-sm">
          {CONTINGENCIES.map((c) => {
            const s = view.contingencies[c];
            return (
              <li key={c} className="flex flex-wrap items-center gap-2">
                {!s.submitted ? <CircleDashed size={14} className="text-slate-500" aria-hidden /> : s.passed ? <CheckCircle2 size={14} className="text-ok" aria-hidden /> : <XCircle size={14} className="text-bad" aria-hidden />}
                <span className="w-24 text-slate-300">{c}</span>
                <Badge tone={!s.submitted ? 'muted' : s.waived ? 'warn' : s.passed ? 'ok' : 'bad'}>{!s.submitted ? t('status.pending') : s.waived ? t('status.waived') : s.passed ? t('status.cleared') : t('status.failed')}</Badge>
                {!isZeroHex(s.reportHash) && <span className="mono text-slate-500" title={s.reportHash}>#{shortHex(s.reportHash)}</span>}
              </li>
            );
          })}
        </ul>
        {view.voidedReportHistory.length > 0 && (
          <div className="mt-3">
            <h3 className="label">
              {t('status.voided')} ({t('status.corrections')}: {view.correctionCount.toString()})
            </h3>
            <ul className="space-y-1">
              {view.voidedReportHistory.map((h) => (
                <li key={h.index.toString()} className="mono text-slate-400">
                  [{h.index.toString()}] {h.reportHash}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      {!compact && (
        <Card title={t('status.anchors')} tip={t('tip.status.anchors')}>
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="label">{t('status.commitments')}</dt>
              <dd className="space-y-1">
                {(['amount', 'buyerPayout', 'sellerPayout'] as const).map((k) => (
                  <div key={k}>
                    <span className="text-xs text-slate-500">{k}</span>
                    {view.commitments[k] ? <Mono value={view.commitments[k]!} /> : <span className="text-slate-500"> {t('contract.notSet')}</span>}
                  </div>
                ))}
              </dd>
            </div>
            <div className="space-y-2">
              {(['buyer', 'seller'] as const).map((p) => {
                const k = p === 'buyer' ? view.buyerKyc : view.sellerKyc;
                return (
                  <div key={p}>
                    <dt className="label">
                      KYC {p} <Badge tone={k.verified ? 'ok' : 'muted'}>{k.verified ? t('status.verified') : t('status.pending')}</Badge>
                    </dt>
                    {k.verified && (
                      <dd className="mono text-slate-400">
                        issuer {shortHex(k.issuerId)} · ref {shortHex(k.ref)} · travel-rule {shortHex(k.travelRuleRef)}
                        {p === 'seller' && <> · {t('status.validUntil')} {fmtTime(view.sellerKyc.validUntil)}</>}
                      </dd>
                    )}
                  </div>
                );
              })}
              <div>
                <dt className="label">{t('status.issuers')}</dt>
                <dd className="mono text-slate-400">{view.kycIssuers.map((i) => shortHex(i.issuerId)).join(', ') || '—'}</dd>
                <dd className="text-xs text-slate-500">
                  {t('status.policy')}: KYC ≥ {view.kycPolicy.minKycLevel}, AML ≤ {view.kycPolicy.maxAmlRiskScore} · {t('status.revoked')}: {view.revokedKycRefs.length}
                </dd>
              </div>
            </div>
          </dl>
        </Card>
      )}
    </div>
  );
}
