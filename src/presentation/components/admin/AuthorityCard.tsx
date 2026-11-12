'use client';
import { useCallback, useEffect, useState } from 'react';
import { ShieldOff } from 'lucide-react';
import { authorityLevel } from '@/domain/escrowView';
import { useApp } from '../../providers/AppProvider';
import { useEscrow } from '../../providers/EscrowProvider';
import { useT } from '../../i18n';
import { Alert, Card, Field, Mono, Spinner } from '../ui';
import { AuthorityBadge } from '../party/StatusOverview';
import { ConfirmDialog } from '../party/helpers';

const PHRASE = 'RENOUNCE';

/**
 * Contract maintenance authority (admin, Keys tab). The key lives only in the encrypted vault. Once every circuit is
 * registered the admin renounces it (recommendation 1): the contract becomes immutable and the key is deleted.
 */
export function AuthorityCard() {
  const { t } = useT();
  const { state, contractAddress, authorityKey, importAuthority, authorityStatus, renounceAuthority, progress } = useApp();
  const { vaultUnlocked, notice, setNotice } = useEscrow();
  const [shown, setShown] = useState<string | null>(null);
  const [imp, setImp] = useState('');
  const [status, setStatus] = useState<Awaited<ReturnType<typeof authorityStatus>>>(null);
  const [confirm, setConfirm] = useState(false);
  const [typed, setTyped] = useState('');
  const busy = progress?.status === 'running';
  const level = authorityLevel(state?.maintenance);

  const check = useCallback(async () => setStatus(vaultUnlocked ? await authorityStatus() : null), [authorityStatus, vaultUnlocked]);
  useEffect(() => void check(), [check, state]);

  const missing = state?.missingCircuits.length ?? 0;
  const canRenounce = !!state && level === 'controlled' && missing === 0 && status === 'match' && !busy;

  return (
    <Card title={t('authority.title')} tip={t('tip.authority.title')} icon={<ShieldOff size={16} aria-hidden />}>
      <p className="mb-3 text-sm text-slate-400">{t('authority.hint')}</p>
      {notice && <Alert tone="ok" onClose={() => setNotice(null)}>{notice}</Alert>}
      {state && <AuthorityBadge maintenance={state.maintenance} />}
      {!vaultUnlocked ? (
        <Alert tone="warn">{t('authority.unlock')}</Alert>
      ) : level === 'immutable' ? (
        <Alert tone="ok">{t('authority.renouncedDone')}</Alert>
      ) : (
        <div className="mt-3 space-y-3">
          {status === 'match' && <Alert tone="ok">{t('authority.keyMatch')}</Alert>}
          {status === 'mismatch' && <Alert tone="bad">{t('authority.keyMismatch')}</Alert>}
          {status === 'missing' && <Alert tone="warn">{t('authority.keyMissing')}</Alert>}
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-ghost" disabled={!contractAddress} onClick={() => void authorityKey().then((k) => setShown(typeof k === 'string' ? k : ''))}>
              {t('keys.export')}
            </button>
          </div>
          {shown !== null && (shown ? <Mono value={shown} /> : <Alert tone="warn">{t('authority.none')}</Alert>)}
          <Field label={t('keys.import')} htmlFor="authImp">
            <div className="flex gap-2">
              <input id="authImp" type="password" className="input mono" value={imp} onChange={(e) => setImp(e.target.value)} autoComplete="off" spellCheck={false} />
              <button type="button" className="btn-ghost" disabled={!contractAddress || !imp.trim()} onClick={() => void importAuthority(imp).then(() => (setImp(''), void check()))}>
                {t('keys.importBtn')}
              </button>
            </div>
          </Field>

          <div className="rounded-xl border border-bad/40 bg-bad/5 p-3">
            <h3 className="mb-1 text-sm font-semibold text-white">{t('authority.renounce')}</h3>
            <p className="mb-2 text-sm text-slate-400">{t('authority.renounceHint')}</p>
            {missing > 0 && <Alert tone="warn">{t('authority.registerFirst')} ({missing})</Alert>}
            <button type="button" className="btn-danger mt-2" disabled={!canRenounce} onClick={() => setConfirm(true)}>
              {busy ? <Spinner /> : null} {t('authority.renounce')}
            </button>
          </div>
        </div>
      )}
      {confirm && (
        <ConfirmDialog
          title={t('authority.confirmTitle')}
          body={t('authority.confirmBody')}
          confirmLabel={t('authority.renounce')}
          onCancel={() => (setConfirm(false), setTyped(''))}
          onConfirm={() => {
            if (typed !== PHRASE) return;
            setConfirm(false);
            setTyped('');
            void renounceAuthority().then(() => void check());
          }}
        >
          <Field label={t('authority.typePhrase')} htmlFor="renounce-phrase">
            <input id="renounce-phrase" className="input mono" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
          </Field>
        </ConfirmDialog>
      )}
    </Card>
  );
}
