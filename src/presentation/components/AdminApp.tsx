'use client';
import { useEffect, useState } from 'react';
import { Archive, Building2, FileLock2, KeyRound, ListChecks, Rocket } from 'lucide-react';
import { EscrowStatus } from '@/infrastructure/contract/module';
import { contractConfig } from '@/infrastructure/config/network';
import { useApp } from '../providers/AppProvider';
import { useT } from '../i18n';
import { Alert, Badge, Card, Field, Mono, Spinner } from './ui';
import { AuthorityBadge } from './party/StatusOverview';
import { ProgressPanel } from './ProgressPanel';
import { TermsKycTab } from './admin/TermsKycTab';
import { AuthorityCard } from './admin/AuthorityCard';
import { VaultTab } from './admin/VaultTab';
import { DustCard } from './DustCard';
import { VaultGate } from './party/PartySetup';
import { useEscrow } from '../providers/EscrowProvider';

type Tab = 'deploy' | 'contract' | 'initialize' | 'terms' | 'keys' | 'vault';

const TABS: { id: Tab; icon: typeof Rocket }[] = [
  { id: 'deploy', icon: Rocket },
  { id: 'contract', icon: Building2 },
  { id: 'initialize', icon: ListChecks },
  { id: 'terms', icon: FileLock2 },
  { id: 'keys', icon: KeyRound },
  { id: 'vault', icon: Archive }
];

export function AdminApp() {
  const { t } = useT();
  const { connector, error, clearError, progress } = useApp();
  const [tab, setTab] = useState<Tab>('deploy');
  const connected = connector.status === 'connected';

  return (
    <main id="main" className="mx-auto max-w-6xl space-y-4 px-4 py-6">
      <div>
        <h1 className="text-2xl font-semibold text-white">{t('admin.title')}</h1>
        <p className="text-sm text-slate-400">{t('admin.subtitle')}</p>
      </div>
      <VaultGate />
      {!connected && <Alert tone="warn">{t('admin.needWallet')}</Alert>}
      {error && <Alert tone="bad" onClose={clearError}>{error}</Alert>}
      <div role="tablist" aria-label={t('admin.title')} className="flex flex-wrap gap-2">
        {TABS.map(({ id, icon: Icon }) => (
          <button key={id} role="tab" aria-selected={tab === id} type="button" className={tab === id ? 'btn-primary' : 'btn-ghost'} onClick={() => setTab(id)}>
            <Icon size={16} aria-hidden /> {t(`admin.tab.${id}`)}
          </button>
        ))}
      </div>
      {progress && <ProgressPanel progress={progress} />}
      {tab === 'deploy' && <DeployTab />}
      {tab === 'contract' && <ContractTab />}
      {tab === 'initialize' && <InitializeTab />}
      {tab === 'terms' && <TermsKycTab />}
      {tab === 'keys' && <KeysTab />}
      {tab === 'vault' && <VaultTab />}
    </main>
  );
}

function DeployTab() {
  const { t } = useT();
  const { connector, deploy, adminRoleId, progress } = useApp();
  const { vaultUnlocked } = useEscrow();
  const [buyer, setBuyer] = useState('');
  const [seller, setSeller] = useState('');
  const [color, setColor] = useState('');
  const [ticker, setTicker] = useState('EURe');
  const busy = progress?.status === 'running';
  return (
    <div className="space-y-4">
    <Card title={t('deploy.title')} icon={<Rocket size={16} aria-hidden />}>
      <p className="mb-3 text-sm text-slate-400">{t('deploy.hint')}</p>
      <Field label={t('deploy.admin')} hint={t('deploy.adminHint')}>
        <input className="input mono" readOnly value={adminRoleId ?? ''} placeholder="Generate a key on the Keys tab" />
      </Field>
      <div className="grid gap-x-4 sm:grid-cols-2">
        <Field label={t('deploy.buyer')} htmlFor="buyer">
          <input id="buyer" className="input mono" value={buyer} onChange={(e) => setBuyer(e.target.value)} placeholder="64 hex" spellCheck={false} />
        </Field>
        <Field label={t('deploy.seller')} htmlFor="seller">
          <input id="seller" className="input mono" value={seller} onChange={(e) => setSeller(e.target.value)} placeholder="64 hex" spellCheck={false} />
        </Field>
        <Field label={t('deploy.color')} htmlFor="color">
          <input id="color" className="input mono" value={color} onChange={(e) => setColor(e.target.value)} placeholder="64 hex" spellCheck={false} />
        </Field>
        <Field label={t('deploy.ticker')} htmlFor="ticker">
          <input id="ticker" className="input" value={ticker} maxLength={12} onChange={(e) => setTicker(e.target.value)} />
        </Field>
      </div>
      <p className="mb-3 text-xs text-slate-500">
        {t('deploy.proofServer')} Core circuits in the deploy transaction: <span className="mono">{contractConfig.deployCircuits.join(', ')}</span>.
      </p>
      <button
        type="button"
        className="btn-primary"
        disabled={connector.status !== 'connected' || !adminRoleId || busy || !vaultUnlocked}
        onClick={() => adminRoleId && void deploy({ adminRoleId, buyerRoleId: buyer, sellerRoleId: seller, tokenColor: color, ticker })}
      >
        {busy ? <Spinner /> : <Rocket size={16} aria-hidden />} {t('deploy.start')}
      </button>
      {!vaultUnlocked && <p className="mt-2 text-xs text-warn">{t('authority.vaultForDeploy')}</p>}
    </Card>
    <DustCard />
    </div>
  );
}

function ContractTab() {
  const { t } = useT();
  const { contractAddress, loadContract, state, refresh, registerRemaining, progress } = useApp();
  const [addr, setAddr] = useState('');
  useEffect(() => {
    if (contractAddress) setAddr(contractAddress);
  }, [contractAddress]);
  const busy = progress?.status === 'running';
  const statusName = state ? (EscrowStatus[state.status] ?? String(state.status)) : '';
  return (
    <div className="space-y-4">
      <Card title={t('contract.attach')}>
        <Field label={t('contract.address')} htmlFor="addr">
          <input id="addr" className="input mono" value={addr} onChange={(e) => setAddr(e.target.value)} spellCheck={false} />
        </Field>
        <div className="flex gap-2">
          <button type="button" className="btn-primary" onClick={() => void loadContract(addr)}>
            {t('contract.attachBtn')}
          </button>
          <button type="button" className="btn-ghost" onClick={() => void refresh()}>
            {t('common.refresh')}
          </button>
        </div>
      </Card>
      {state && (
        <Card title={t('contract.title')} icon={<Building2 size={16} aria-hidden />}>
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="label">{t('contract.status')}</dt>
              <dd><Badge tone={state.status === 0 ? 'warn' : 'ok'}>{statusName}</Badge> v{String(state.configVersion)}</dd>
            </div>
            <div>
              <dt className="label">Token</dt>
              <dd>{state.ticker}</dd>
              <dd><Mono value={state.tokenColor} /></dd>
            </div>
            <div>
              <dt className="label">Acceptance (buyer / seller)</dt>
              <dd>{String(state.buyerAccepted)} / {String(state.sellerAccepted)}</dd>
            </div>
            <div>
              <dt className="label">Deadlines (closing / dispute, unix s)</dt>
              <dd className="mono">{String(state.closingDeadline)} / {String(state.disputeDeadline)}</dd>
            </div>
          </dl>
          <h3 className="label mt-4">{t('contract.roles')}</h3>
          <ul className="space-y-1.5 text-sm">
            {Object.entries(state.roles).map(([role, id]) => (
              <li key={role} className="flex flex-wrap items-start gap-2">
                <span className="w-24 text-slate-400">{role}</span>
                {id ? <Mono value={id} /> : <span className="text-slate-500">{t('contract.notSet')}</span>}
              </li>
            ))}
          </ul>
          <h3 className="label mt-4">{t('contract.circuits')} ({state.registeredCircuits.length}/{state.registeredCircuits.length + state.missingCircuits.length})</h3>
          {state.missingCircuits.length > 0 ? (
            <div className="space-y-2">
              <Alert tone="warn">{t('contract.missingCircuits')} <span className="mono">{state.missingCircuits.join(', ')}</span></Alert>
              <button type="button" className="btn-primary" disabled={busy} onClick={() => void registerRemaining()}>
                {busy ? <Spinner /> : null} {t('contract.registerRemaining')}
              </button>
            </div>
          ) : (
            <Alert tone="ok">{t('contract.allRegistered')}</Alert>
          )}
          <h3 className="label mt-4">{t('authority.title')}</h3>
          <AuthorityBadge maintenance={state.maintenance} />
        </Card>
      )}
    </div>
  );
}

const hexOrUndef = (s: string) => (s.trim() ? s.trim() : undefined);
const bigOrUndef = (s: string) => (s.trim() ? BigInt(s.trim()) : undefined);

function InitializeTab() {
  const { t } = useT();
  const { state, configure, progress } = useApp();
  const [f, setF] = useState({ inspector: '', lender: '', titleAgent: '', resolver: '', closing: '', dispute: '', kyc: '', aml: '' });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const busy = progress?.status === 'running';
  if (!state) return <Alert tone="warn">{t('contract.title')}: {t('contract.notSet')}</Alert>;
  if (state.status !== 0) return <Alert tone="ok">{t('contract.status')}: {EscrowStatus[state.status]}</Alert>;
  return (
    <Card title={t('init.title')} icon={<ListChecks size={16} aria-hidden />}>
      <p className="mb-2 text-sm text-slate-400">{t('init.hint')}</p>
      <p className="mb-3 text-sm">{t('init.missing')}: {state.missingAttributes.length ? state.missingAttributes.map((a) => <Badge key={a} tone="warn">{a}</Badge>) : '—'}</p>
      <div className="grid gap-x-4 sm:grid-cols-2">
        {(['inspector', 'lender', 'titleAgent', 'resolver'] as const).map((k) => (
          <Field key={k} label={`${k} role id`} htmlFor={k}>
            <input id={k} className="input mono" value={f[k]} onChange={set(k)} placeholder="64 hex" spellCheck={false} />
          </Field>
        ))}
        <Field label="Closing deadline (unix s)" htmlFor="closing"><input id="closing" inputMode="numeric" className="input" value={f.closing} onChange={set('closing')} /></Field>
        <Field label="Dispute deadline (unix s)" htmlFor="dispute"><input id="dispute" inputMode="numeric" className="input" value={f.dispute} onChange={set('dispute')} /></Field>
        <Field label="Min KYC level" htmlFor="kyc"><input id="kyc" inputMode="numeric" className="input" value={f.kyc} onChange={set('kyc')} /></Field>
        <Field label="Max AML risk score" htmlFor="aml"><input id="aml" inputMode="numeric" className="input" value={f.aml} onChange={set('aml')} /></Field>
      </div>
      <p className="mb-3 text-xs text-slate-500">{t('init.commitmentsHint')}</p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn-primary"
          disabled={busy}
          onClick={() =>
            void configure({
              inspector: hexOrUndef(f.inspector),
              lender: hexOrUndef(f.lender),
              titleAgent: hexOrUndef(f.titleAgent),
              resolver: hexOrUndef(f.resolver),
              closingDeadline: bigOrUndef(f.closing),
              disputeDeadline: bigOrUndef(f.dispute),
              kycPolicy: f.kyc.trim() && f.aml.trim() ? { minKycLevel: Number(f.kyc), maxAmlRiskScore: Number(f.aml) } : undefined
            })
          }
        >
          {t('init.apply')}
        </button>
      </div>
      <p className="mt-2 text-xs text-slate-500">{t('init.finalizeMoved')}</p>
    </Card>
  );
}

function KeysTab() {
  const { t } = useT();
  const { adminKey, adminRoleId, newAdminKey, setAdminKey, verifyAdminKey, state } = useApp();
  const [shown, setShown] = useState(false);
  const [imp, setImp] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, setPending] = useState<{ kind: 'generate' } | { kind: 'import'; hex: string } | null>(null);
  const [saved, setSaved] = useState(false);
  const verdict = verifyAdminKey();
  // Replacing a key that is the live admin of the loaded contract locks the admin out for good.
  const level: 'none' | 'confirm' | 'strict' = !adminKey ? 'none' : verdict === true ? 'strict' : 'confirm';
  const request = (action: NonNullable<typeof pending>) => {
    if (action.kind === 'import' && adminKey && action.hex.trim().toLowerCase().replace(/^0x/, '') === adminKey) return void setImp('');
    if (level === 'none') return void run(action);
    setPending(action);
  };
  const run = (action: NonNullable<typeof pending>) => {
    setPending(null);
    const op = action.kind === 'generate' ? newAdminKey().then(() => undefined) : setAdminKey(action.hex).then(() => setImp(''));
    void op.catch((e) => setMsg(String(e.message)));
  };
  return (
    <div className="space-y-4">
      <Card title={t('keys.title')} icon={<KeyRound size={16} aria-hidden />}>
        <p className="mb-3 text-sm text-slate-400">{t('keys.hint')}</p>
        {adminRoleId && <Field label={t('deploy.admin')}><Mono value={adminRoleId} /></Field>}
        <div className="mb-3 flex flex-wrap gap-2">
          <button type="button" className="btn-primary" onClick={() => request({ kind: 'generate' })}>{t('keys.generate')}</button>
          {adminKey && <button type="button" className="btn-ghost" onClick={() => { setShown(!shown); setSaved(true); }}>{t('keys.export')}</button>}
        </div>
        {shown && adminKey && <Mono value={adminKey} />}
        <Field label={t('keys.import')} htmlFor="imp">
          <div className="flex gap-2">
            <input id="imp" type="password" className="input mono" value={imp} onChange={(e) => setImp(e.target.value)} autoComplete="off" spellCheck={false} />
            <button type="button" className="btn-ghost" onClick={() => request({ kind: 'import', hex: imp })}>{t('keys.importBtn')}</button>
          </div>
        </Field>
        {msg && <Alert tone="bad" onClose={() => setMsg(null)}>{msg}</Alert>}
      </Card>
      {pending && <ReplaceKeyDialog strict={level === 'strict'} saved={saved} onCancel={() => setPending(null)} onConfirm={() => run(pending)} />}
      <Card title={t('keys.verify')}>
        <p className="mb-3 text-sm text-slate-400">{t('keys.verifyHint')}</p>
        {!state ? <Alert tone="warn">{t('contract.title')}: {t('contract.notSet')}</Alert> : verdict === null ? <Alert tone="warn">{t('keys.hint')}</Alert> : verdict ? <Alert tone="ok">{t('keys.match')}</Alert> : <Alert tone="bad">{t('keys.noMatch')}</Alert>}
      </Card>
      <AuthorityCard />
    </div>
  );
}

const REPLACE_PHRASE = 'REPLACE';

function ReplaceKeyDialog({ strict, saved, onCancel, onConfirm }: { strict: boolean; saved: boolean; onCancel: () => void; onConfirm: () => void }) {
  const { t } = useT();
  const [typed, setTyped] = useState('');
  const ok = !strict || (saved && typed === REPLACE_PHRASE);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onCancel}>
      <div role="alertdialog" aria-modal="true" aria-labelledby="rk-title" className="card w-full max-w-md space-y-3 p-5" onClick={(e) => e.stopPropagation()}>
        <h2 id="rk-title" className="text-base font-semibold">{t(strict ? 'keys.replaceStrictTitle' : 'keys.replaceTitle')}</h2>
        <Alert tone={strict ? 'bad' : 'warn'}>{t(strict ? 'keys.replaceStrictBody' : 'keys.replaceBody')}</Alert>
        {strict && (
          <>
            {!saved && <Alert tone="warn">{t('keys.replaceExportFirst')}</Alert>}
            <Field label={t('keys.replaceTypePhrase')} htmlFor="rk-phrase">
              <input id="rk-phrase" className="input mono" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
            </Field>
          </>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onCancel}>{t('keys.replaceCancel')}</button>
          <button type="button" className="btn-primary" disabled={!ok} onClick={onConfirm}>{t('keys.replaceConfirm')}</button>
        </div>
      </div>
    </div>
  );
}
