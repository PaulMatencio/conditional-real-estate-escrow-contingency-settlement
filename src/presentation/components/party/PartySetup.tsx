'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { FlaskConical, KeyRound, Lock, Radio, Unlock, WalletCards } from 'lucide-react';
import { isHex32, bytesToHex } from '@/domain/hex';
import { ROLE_SLUG, rolesOf, type PartyRole } from '@/domain/roles';
import { generateSecretKey, roleIdHex, secretKeyFromHex } from '@/infrastructure/crypto/identity';
import { shieldedKeyToHex } from '@/infrastructure/wallet/providers';
import { useEscrow } from '../../providers/EscrowProvider';
import { useApp } from '../../providers/AppProvider';
import { useT } from '../../i18n';
import type { MessageKey } from '../../i18n/en';
import { Alert, Badge, Card, Field, Mono, Spinner } from '../ui';
import { TypedConfirmDialog, fmtTime } from './helpers';
import { insecureContextMessage } from '@/infrastructure/crypto/aead';

/** FR-WALLET-04: Wallet Mode ⇄ Simulator Mode, the escrow address and the simulator controls. */
export function ModeBar() {
  const { t } = useT();
  const { mode, setMode, contractAddress, setContractAddress, sim, createSimulation, simFinalize, setSimTime, now, view, vaultUnlocked, busy } = useEscrow();
  const { connector } = useApp();
  const [addr, setAddr] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (mode === 'wallet' && contractAddress) setAddr(contractAddress);
  }, [mode, contractAddress]);

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label={t('party.mode')}>
        <button type="button" role="radio" aria-checked={mode === 'wallet'} className={mode === 'wallet' ? 'btn-primary' : 'btn-ghost'} onClick={() => setMode('wallet')}>
          <Radio size={16} aria-hidden /> {t('party.mode.wallet')}
        </button>
        <button type="button" role="radio" aria-checked={mode === 'simulator'} className={mode === 'simulator' ? 'btn-primary' : 'btn-ghost'} onClick={() => setMode('simulator')}>
          <FlaskConical size={16} aria-hidden /> {t('party.mode.simulator')}
        </button>
        <span className="ml-auto text-xs text-slate-500">{mode === 'wallet' ? t('party.mode.walletHint') : t('party.mode.simHint')}</span>
      </div>

      {mode === 'wallet' ? (
        <div className="mt-3">
          {connector.status !== 'connected' && <Alert tone="warn">{t('admin.needWallet')}</Alert>}
          <Field label={t('contract.address')} htmlFor="party-addr">
            <div className="flex gap-2">
              <input id="party-addr" className="input mono" value={addr} onChange={(e) => setAddr(e.target.value)} spellCheck={false} />
              <button
                type="button"
                className="btn-primary"
                onClick={() =>
                  void setContractAddress(addr).then(
                    () => setErr(null),
                    (e) => setErr(e.message)
                  )
                }
              >
                {t('contract.attachBtn')}
              </button>
            </div>
          </Field>
          {err && <Alert tone="bad" onClose={() => setErr(null)}>{err}</Alert>}
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-primary" disabled={!vaultUnlocked || busy} onClick={() => void createSimulation()}>
              {t('sim.create')}
            </button>
            {sim && view?.status === 'Initializing' && (
              <button type="button" className="btn-ghost" onClick={() => void simFinalize()}>
                {t('sim.finalize')}
              </button>
            )}
          </div>
          {!vaultUnlocked && <p className="text-xs text-slate-500">{t('sim.needVault')}</p>}
          {sim && (
            <>
              <Field label={`${t('sim.time')}: ${fmtTime(now)}`} htmlFor="sim-time" hint={t('sim.timeHint')}>
                <input
                  id="sim-time"
                  type="range"
                  className="w-full accent-accent"
                  min={Number(sim.time) - 86400}
                  max={Number(view?.disputeDeadline ?? BigInt(sim.time)) + 7 * 86400}
                  step={3600}
                  value={Number(now)}
                  onChange={(e) => setSimTime(Number(e.target.value))}
                />
              </Field>
              <p className="text-xs text-slate-500">
                {t('sim.address')} <span className="mono">{sim.contractAddress}</span>
              </p>
            </>
          )}
        </div>
      )}
    </Card>
  );
}

/** Unlock (or create) the encrypted vault that holds role keys, terms and attestations (NFR-06). */
/** `whenMissing`: shown under the form when this address has no vault yet (e.g. the admin's "restore from a backup"). */
export function VaultGate({ whenMissing }: { whenMissing?: ReactNode } = {}) {
  const { t } = useT();
  const { vaultExists, vaultUnlocked, unlockVault, lockVault } = useEscrow();
  // Not https / localhost: the browser hides WebCrypto, so no vault can be created or opened here. Checked after
  // mount (the server always has WebCrypto, so computing it while rendering would mismatch on hydration).
  const [insecure, setInsecure] = useState(false);
  useEffect(() => setInsecure(insecureContextMessage() !== null), []);
  const [pass, setPass] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  if (vaultUnlocked)
    return (
      <div className="flex items-center gap-2 text-sm text-slate-400">
        <Unlock size={14} aria-hidden className="text-ok" /> {t('vault.unlocked')}
        <button type="button" className="btn-ghost !px-2 !py-1 text-xs" onClick={lockVault}>
          <Lock size={12} aria-hidden /> {t('vault.lock')}
        </button>
      </div>
    );
  const submit = async () => {
    setErr(null);
    if (pass.length < 8) return setErr(t('vault.tooShort'));
    setWorking(true);
    try {
      const problem = await unlockVault(pass);
      if (problem) setErr(problem);
      else setPass('');
    } finally {
      setWorking(false);
    }
  };
  return (
    <Card title={vaultExists ? t('vault.unlock') : t('vault.create')} icon={<Lock size={16} aria-hidden />}>
      <p className="mb-3 text-sm text-slate-400">{t('vault.hint')}</p>
      {vaultExists === false && whenMissing && <div className="mb-3">{whenMissing}</div>}
      {insecure && (
        <div className="mb-3">
          <Alert tone="bad">{t('vault.insecure').replace('{origin}', typeof location !== 'undefined' ? location.origin : '')}</Alert>
        </div>
      )}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <input type="password" className="input" value={pass} onChange={(e) => (setPass(e.target.value), setErr(null))} autoComplete="current-password" aria-label={t('vault.passphrase')} aria-invalid={!!err} placeholder={t('vault.passphrase')} />
        <button type="submit" className="btn-primary" disabled={working || vaultExists === null}>
          {working ? <Spinner /> : null} {vaultExists ? t('vault.unlock') : t('vault.create')}
        </button>
      </form>
      {err && (
        <div className="mt-3">
          <Alert tone="bad" onClose={() => setErr(null)}>
            {err}
          </Alert>
          {vaultExists && <p className="mt-2 text-xs text-slate-500">{t('vault.sameBrowser')}</p>}
        </div>
      )}
    </Card>
  );
}

/** FR-WALLET-02/03: the role secret for this escrow, its role id, and every on-chain role it matches. */
export function RoleKeyCard({ role, onRoleChange }: { role: PartyRole; onRoleChange?: (r: PartyRole) => void }) {
  const { t } = useT();
  const { roleKey, setRoleKey, view, vaultUnlocked, mode, record } = useEscrow();
  const [imp, setImp] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const removed = (record.roleKeyHistory ?? []).filter((h) => h.role === role).at(-1);
  // Translated role name, lower-cased for use mid-sentence ("act as buyer", "agir en tant que acheteur").
  const roleLabel = t(role === 'admin' ? 'nav.admin' : (`nav.${ROLE_SLUG[role]}` as MessageKey)).toLocaleLowerCase();
  const [msg, setMsg] = useState<string | null>(null);
  const hex = roleKey(role);
  const id = hex ? roleIdHex(secretKeyFromHex(hex)) : null;
  const held = view && id ? rolesOf(view, id) : [];
  const expected = view?.roles[role] ?? null;
  const ok = !!id && id === expected;

  if (!vaultUnlocked) return null;
  return (
    <Card title={t('party.roleKey')} tip={t('tip.party.roleKey')} icon={<KeyRound size={16} aria-hidden />}>
      {id ? (
        <div className="space-y-2">
          <Field label={t('role.roleId')} tip={t('tip.role.roleId')}>
            <Mono value={id} />
          </Field>
          {view &&
            (ok ? (
              <Alert tone="ok">
                {t('party.roleMatch')} {held.map((r) => <Badge key={r} tone="ok">{r}</Badge>)}
              </Alert>
            ) : (
              <Alert tone="bad">{expected ? t('party.roleNoMatch') : t('party.roleNotSet')}</Alert>
            ))}
          {held.length > 1 && onRoleChange && (
            <div className="flex flex-wrap items-center gap-2 text-sm" aria-label={t('party.switchRole')}>
              <span className="text-slate-400">{t('party.switchRole')}:</span>
              {held.map((r) => (
                <button key={r} type="button" className={r === role ? 'btn-primary !py-1' : 'btn-ghost !py-1'} onClick={() => onRoleChange(r)}>
                  {r}
                </button>
              ))}
            </div>
          )}
          {mode === 'wallet' && (
            <button type="button" className="btn-ghost text-xs" onClick={() => setConfirmRemove(true)}>
              {t('party.forgetKey')}
            </button>
          )}
          {confirmRemove && (
            <TypedConfirmDialog
              title={t('roleKey.removeTitle').replace('{role}', roleLabel)}
              phrase={t('confirm.phraseRemove')}
              alsoAccept={['REMOVE']}
              confirmLabel={t('roleKey.removeConfirm')}
              cancelLabel={t('confirm.keepKey')}
              body={
                <>
                  <p>{t('roleKey.removeBody').replace('{role}', roleLabel)}</p>
                  <p>{t('roleKey.removeHistory')}</p>
                  <p className="text-warn">{t('roleKey.removeWarn')}</p>
                </>
              }
              onCancel={() => setConfirmRemove(false)}
              onConfirm={() => {
                setConfirmRemove(false);
                void setRoleKey(role, null).catch((e) => setMsg((e as Error).message));
              }}
            />
          )}
        </div>
      ) : (
        <>
          <p className="mb-3 text-sm text-slate-400">{t('party.roleKeyHint')}</p>
          {removed && (
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <button type="button" className="btn-ghost" onClick={() => void setRoleKey(role, removed.key).catch((e) => setMsg((e as Error).message))}>
                {t('roleKey.restoreRemoved')}
              </button>
              <span className="text-xs text-slate-500">
                {t('roleKey.removedAt')} {new Date(removed.removedAt).toLocaleString()}
              </span>
            </div>
          )}
          <Field label={t('role.import')} htmlFor={`rk-${role}`}>
            <div className="flex gap-2">
              <input id={`rk-${role}`} type="password" className="input mono" value={imp} onChange={(e) => setImp(e.target.value)} autoComplete="off" spellCheck={false} />
              <button
                type="button"
                className="btn-primary"
                onClick={() => {
                  if (!isHex32(imp)) return setMsg(t('role.badKey'));
                  void setRoleKey(role, imp).then(() => setImp(''), (e) => setMsg(e.message));
                }}
              >
                {t('keys.importBtn')}
              </button>
            </div>
          </Field>
          {mode === 'simulator' && (
            <button type="button" className="btn-ghost" onClick={() => void setRoleKey(role, bytesToHex(generateSecretKey()))}>
              {t('keys.generate')}
            </button>
          )}
          {msg && <Alert tone="bad" onClose={() => setMsg(null)}>{msg}</Alert>}
        </>
      )}
    </Card>
  );
}

/**
 * FR-TERMS-02 / FR-WALLET-05: the party's shielded payout key, i.e. the connected wallet's shielded COIN public key
 * (not the full mn_shield-addr address), as the 64 hex the admin enters in the terms package. Available while the
 * escrow is still Initializing; compared with the committed key once a terms package is in the vault.
 */
export function PayoutKeyCard({ party }: { party: 'buyer' | 'seller' }) {
  const { t } = useT();
  const { connector } = useApp();
  const { record, mode } = useEscrow();
  const [key, setKey] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const session = connector.status === 'connected' ? connector.session : null;
  const committed = party === 'buyer' ? record.terms?.terms.buyerPayout : record.terms?.terms.sellerPayout;

  const reveal = async () => {
    setErr(null);
    try {
      if (!session) throw new Error(t('admin.needWallet'));
      const keys = await session.api.getShieldedAddresses();
      setKey(shieldedKeyToHex(keys.shieldedCoinPublicKey, 'coin', session.networkId));
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  if (mode !== 'wallet') return null;
  return (
    <Card title={t('payout.title')} tip={t('tip.payout.title')} icon={<WalletCards size={16} aria-hidden />}>
      <p className="mb-3 text-sm text-slate-400">{t('payout.hint')}</p>
      <button type="button" className="btn-primary" disabled={!session} onClick={() => void reveal()}>
        {t('payout.show')}
      </button>
      {!session && <p className="mt-2 text-xs text-slate-500">{t('admin.needWallet')}</p>}
      {err && <Alert tone="bad" onClose={() => setErr(null)}>{err}</Alert>}
      {key && (
        <div className="mt-3 space-y-2">
          <Field label={t('payout.key')} hint={t('payout.keyHint')}>
            <Mono value={key} />
          </Field>
          {committed &&
            (committed === key ? <Alert tone="ok">{t('payout.matches')}</Alert> : <Alert tone="warn">{t('payout.differs')}</Alert>)}
        </div>
      )}
    </Card>
  );
}
