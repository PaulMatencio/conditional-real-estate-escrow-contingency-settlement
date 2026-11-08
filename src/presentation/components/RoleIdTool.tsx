'use client';
import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { isHex32 } from '@/domain/hex';
import { bytesToHex } from '@/domain/hex';
import { generateSecretKey, roleIdHex, secretKeyFromHex } from '@/infrastructure/crypto/identity';
import { useT } from '../i18n';
import { Alert, Card, Field, Mono } from './ui';

/**
 * Any party (buyer, seller, ...) derives its public role id here. The secret key lives only in this component's
 * state: it is never stored, never sent anywhere, and is gone when the page is closed. Share the role id only.
 */
export function RoleIdTool() {
  const { t } = useT();
  const [secret, setSecret] = useState<string | null>(null);
  const [imp, setImp] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const roleId = secret ? roleIdHex(secretKeyFromHex(secret)) : null;

  const useImported = () => {
    if (!isHex32(imp)) return setMsg(t('role.badKey'));
    setSecret(imp.trim().toLowerCase().replace(/^0x/, ''));
    setImp('');
    setMsg(null);
  };

  return (
    <main id="main" className="mx-auto max-w-3xl space-y-4 px-4 py-6">
      <div>
        <h1 className="text-2xl font-semibold text-white">{t('role.title')}</h1>
        <p className="text-sm text-slate-400">{t('role.subtitle')}</p>
      </div>
      <Alert tone="warn">{t('role.warn')}</Alert>
      <Card title={t('role.card')} tip={t('tip.role.roleId')} icon={<KeyRound size={16} aria-hidden />}>
        <div className="mb-3 flex flex-wrap gap-2">
          <button type="button" className="btn-primary" onClick={() => { setSecret(bytesToHex(generateSecretKey())); setMsg(null); }}>{t('role.generate')}</button>
          {secret && <button type="button" className="btn-ghost" onClick={() => setSecret(null)}>{t('role.clear')}</button>}
        </div>
        <Field label={t('role.import')} htmlFor="role-imp">
          <div className="flex gap-2">
            <input id="role-imp" type="password" className="input mono" value={imp} onChange={(e) => setImp(e.target.value)} autoComplete="off" spellCheck={false} />
            <button type="button" className="btn-ghost" onClick={useImported}>{t('role.derive')}</button>
          </div>
        </Field>
        {msg && <Alert tone="bad" onClose={() => setMsg(null)}>{msg}</Alert>}
        {secret && roleId && (
          <div className="mt-4 space-y-3">
            <Field label={t('role.roleId')} tip={t('tip.role.roleId')} hint={t('role.roleIdHint')}><Mono value={roleId} /></Field>
            <Field label={t('role.secret')} tip={t('tip.role.secret')} hint={t('role.secretHint')}><Mono value={secret} /></Field>
          </div>
        )}
      </Card>
    </main>
  );
}
