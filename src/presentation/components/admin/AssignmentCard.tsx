'use client';
import { useState } from 'react';
import { UserCheck } from 'lucide-react';
import { ATTESTOR_ROLES, assignmentLink, createAssignment, type AttestorRole } from '@/domain/assignment';
import { wireMetaOf } from '@/domain/escrowMeta';
import { shortHex } from '@/domain/hex';
import { ROLE_SLUG } from '@/domain/roles';
import { networkConfig } from '@/infrastructure/config/network';
import { sealTo } from '@/infrastructure/crypto/aead';
import { sharedVault } from '@/infrastructure/storage/vaultInstance';
import { useApp } from '../../providers/AppProvider';
import { useEscrow } from '../../providers/EscrowProvider';
import { useT, type MessageKey } from '../../i18n';
import { Alert, Card, Field, Mono } from '../ui';
import { downloadJson } from '../party/helpers';

/**
 * Assignment notices (admin): tells the inspector, title agent and dispute resolver which escrow they work on. For each
 * attestor role set on-chain: a link to their page with the escrow preselected (address and role only, both public),
 * and a notice file sealed to their envelope key that also carries the escrow's name and deadlines. They import it
 * once; the escrow then sits in their vault's directory.
 */
export function AssignmentCard() {
  const { t } = useT();
  const { contractAddress, state } = useApp();
  const { vaultUnlocked, record } = useEscrow();
  const [env, setEnv] = useState<Record<AttestorRole, string>>({ inspector: '', titleAgent: '', resolver: '' });
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  if (!contractAddress || !state) return null;
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const assigned = ATTESTOR_ROLES.filter((r) => !!state.roles[r]);
  const roleName = (r: AttestorRole) => t(`nav.${ROLE_SLUG[r]}` as MessageKey);

  const seal = async (role: AttestorRole) => {
    setMsg(null);
    try {
      // The escrow's current name (from this vault), so a rename after deploying is picked up.
      const meta = wireMetaOf(vaultUnlocked ? (await sharedVault().load(contractAddress)).meta : record.meta);
      const notice = createAssignment({
        contractAddress,
        role,
        roleId: state.roles[role] ?? '',
        network: networkConfig.networkId,
        closingDeadline: state.closingDeadline,
        disputeDeadline: state.disputeDeadline,
        issuedAt: Date.now(),
        meta
      });
      downloadJson(`assignment-for-${ROLE_SLUG[role]}.json`, await sealTo(notice, env[role].trim(), role));
      setMsg({ tone: 'ok', text: t('assign.sealed').replace('{role}', roleName(role)) });
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as Error).message });
    }
  };

  return (
    <Card title={t('assign.title')} icon={<UserCheck size={16} aria-hidden />}>
      <p className="mb-3 text-sm text-slate-400">{t('assign.hint')}</p>
      {assigned.length === 0 && <Alert tone="warn">{t('assign.noneSet')}</Alert>}
      <ul className="space-y-3">
        {assigned.map((r) => {
          const link = assignmentLink(origin, contractAddress, r);
          return (
            <li key={r} className="rounded-xl border border-midnight-700 bg-midnight-900/60 p-3">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="font-medium text-white">{roleName(r)}</span>
                <span className="mono text-slate-500">{shortHex(state.roles[r] ?? '', 10, 6)}</span>
              </div>
              <Field label={t('assign.link')} hint={t('assign.linkHint')}>
                <Mono value={link} />
              </Field>
              <Field label={t('assign.envKey').replace('{role}', roleName(r))} hint={t('assign.envKeyHint')} htmlFor={`assign-env-${r}`}>
                <div className="flex gap-2">
                  <input id={`assign-env-${r}`} className="input mono" value={env[r]} onChange={(e) => setEnv({ ...env, [r]: e.target.value })} spellCheck={false} />
                  <button type="button" className="btn-ghost" disabled={!env[r].trim()} onClick={() => void seal(r)}>
                    {t('assign.seal')}
                  </button>
                </div>
              </Field>
            </li>
          );
        })}
      </ul>
      {msg && (
        <div className="mt-3">
          <Alert tone={msg.tone} onClose={() => setMsg(null)}>
            {msg.text}
          </Alert>
        </div>
      )}
    </Card>
  );
}
