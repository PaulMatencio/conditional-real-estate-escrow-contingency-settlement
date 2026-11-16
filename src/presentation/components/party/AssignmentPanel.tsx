'use client';
import { useEffect, useState } from 'react';
import { ClipboardList } from 'lucide-react';
import { createAssignment, escrowFromQuery, isAssignment, type AssignmentNotice, type AttestorRole } from '@/domain/assignment';
import { displayLabel } from '@/domain/escrowMeta';
import { shortHex } from '@/domain/hex';
import { ROLE_SLUG } from '@/domain/roles';
import { networkConfig } from '@/infrastructure/config/network';
import { isEnvelope, openEnvelope } from '@/infrastructure/crypto/aead';
import { readPublicView } from '@/infrastructure/gateway/publicReader';
import { useEscrow } from '../../providers/EscrowProvider';
import { useT, type MessageKey } from '../../i18n';
import { Alert, Card, Field, Mono, Spinner } from '../ui';
import { FilePick, fmtTime, readJsonFile } from './helpers';

/**
 * Attestor side of the assignment notice (inspector, title agent, dispute resolver): shows this browser's envelope key
 * (to send to the admin), imports the sealed notice or follows an assignment link (`?escrow=<address>`), checks it
 * against the escrow's public ledger, adds the escrow to the vault and opens it on every page.
 */
export function AssignmentPanel({ role }: { role: AttestorRole }) {
  const { t } = useT();
  const { identity, identities, vaultUnlocked, contractAddress, record, updateRecordAt, switchEscrow } = useEscrow();
  const [linked, setLinked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad' | 'warn'; text: string } | null>(null);
  const roleName = (r: AttestorRole) => t(`nav.${ROLE_SLUG[r]}` as MessageKey);

  // An assignment link opens this page with ?escrow=<address>: offer it until handled (needs the vault unlocked).
  useEffect(() => {
    const a = escrowFromQuery(window.location.search);
    if (a && a !== contractAddress) setLinked(a);
  }, [contractAddress]);

  const clearQuery = () => {
    const url = new URL(window.location.href);
    url.searchParams.delete('escrow');
    window.history.replaceState(null, '', url.toString());
  };

  /** Checks the role on-chain, stores the notice in the escrow's vault record and opens the escrow everywhere. */
  const adopt = async (address: string, notice?: AssignmentNotice) => {
    const view = await readPublicView(address);
    const expected = view.roles[role];
    if (!expected) throw new Error(t('assign.roleNotSet').replace('{role}', roleName(role)));
    if (notice && notice.roleId !== expected.toLowerCase()) throw new Error(t('assign.roleChanged').replace('{role}', roleName(role)));
    const stored =
      notice ??
      createAssignment({ contractAddress: address, role, roleId: expected, network: networkConfig.networkId, closingDeadline: view.closingDeadline, disputeDeadline: view.disputeDeadline, issuedAt: Date.now() });
    await updateRecordAt(address, (r) => ({ ...r, assignment: stored }));
    await switchEscrow(address);
  };

  const run = async (fn: () => Promise<void>, ok: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg({ tone: 'ok', text: ok });
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const importFile = (f: File) =>
    run(async () => {
      const raw = await readJsonFile(f);
      let n: unknown = raw;
      if (isEnvelope(raw)) {
        const me = identities.find((k) => k.publicKey === raw.recipient);
        if (!me) throw new Error(identities.length ? t('assign.notForMe') : t('terms.noIdentity'));
        n = await openEnvelope(raw, me);
      }
      if (!isAssignment(n)) throw new Error(t('assign.badFile'));
      if (n.role !== role) throw new Error(t('assign.otherRole').replace('{role}', roleName(n.role)).replace('{page}', `/${ROLE_SLUG[n.role]}`));
      if (n.network !== networkConfig.networkId) throw new Error(t('assign.otherNetwork').replace('{network}', n.network));
      await adopt(n.contractAddress, n);
    }, t('assign.imported'));

  const mine = record.assignment?.role === role ? record.assignment : null;

  return (
    <Card title={t('assign.myTitle')} icon={<ClipboardList size={16} aria-hidden />}>
      <p className="mb-3 text-sm text-slate-400">{t('assign.myHint')}</p>
      {linked && (
        <div role="alertdialog" className="mb-3 rounded-xl border border-accent/40 bg-accent/10 px-4 py-3 text-sm text-slate-200">
          <p>{t('assign.linkAsk').replace('{escrow}', shortHex(linked, 6, 4)).replace('{role}', roleName(role))}</p>
          {!vaultUnlocked && <p className="mt-1 text-warn">{t('assign.unlockFirst')}</p>}
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-primary"
              disabled={busy || !vaultUnlocked}
              onClick={() =>
                void run(async () => {
                  await adopt(linked);
                  setLinked(null);
                  clearQuery();
                }, t('assign.imported'))
              }
            >
              {busy && <Spinner />} {t('assign.addOpen')}
            </button>
            <button
              type="button"
              className="btn-ghost"
              disabled={busy}
              onClick={() => {
                setLinked(null);
                clearQuery();
              }}
            >
              {t('terms.otherEscrow.cancel')}
            </button>
          </div>
        </div>
      )}
      {identity && (
        <Field label={t('terms.myEnvelopeKey')} hint={t('assign.envelopeHint')}>
          <Mono value={identity.publicKey} />
        </Field>
      )}
      {vaultUnlocked && (
        <div className="mb-3 flex flex-wrap items-end gap-2">
          <FilePick label={t('assign.import')} accept="application/json,.json" onFile={(f) => void importFile(f)} />
        </div>
      )}
      {msg && (
        <div className="mb-3">
          <Alert tone={msg.tone} onClose={() => setMsg(null)}>
            {msg.text}
          </Alert>
        </div>
      )}
      {mine && contractAddress === mine.contractAddress && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-slate-400">{t('assign.escrow')}</dt>
          <dd className="text-slate-200">{displayLabel(mine.contractAddress, record.meta)}</dd>
          <dt className="text-slate-400">{t('assign.role')}</dt>
          <dd className="text-slate-200">{roleName(mine.role)}</dd>
          <dt className="text-slate-400">{t('assign.closing')}</dt>
          <dd className="text-slate-200">{fmtTime(BigInt(mine.closingDeadline))}</dd>
          <dt className="text-slate-400">{t('assign.dispute')}</dt>
          <dd className="text-slate-200">{fmtTime(BigInt(mine.disputeDeadline))}</dd>
        </dl>
      )}
    </Card>
  );
}
