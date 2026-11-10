'use client';
/**
 * Party session (Phase 2): which escrow, which mode (Wallet / Simulator, FR-WALLET-04), the unlocked encrypted vault
 * holding role keys, terms and attestations, the live public view, and one `run` entry point for every circuit.
 * Private material is read from the vault per call and never leaves this provider except to the gateway.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { IDENTITY_RECORD, type CallReceipt, type CircuitArgs, type EscrowPartyGateway, type VaultRecord } from '@/application/partyPorts';
import { runPartyAction, finalizeBlockers, trackVault } from '@/application/partyService';
import { createTermsPackage } from '@/application/termsService';
import { deployTracker } from '@/application/deployProgress';
import { friendlyMessage } from '@/domain/errors';
import type { EscrowView } from '@/domain/escrowView';
import { bytesToHex } from '@/domain/hex';
import type { PartyCircuit } from '@/domain/lifecycle';
import { PARTY_ROLES, type Caller, type PartyRole } from '@/domain/roles';
import { HttpCaspGateway } from '@/infrastructure/casp/httpCaspGateway';
import { generateRecipientKeyPair } from '@/infrastructure/crypto/aead';
import { generateSecretKey, roleIdHex, secretKeyFromHex } from '@/infrastructure/crypto/identity';
import { termsCrypto } from '@/infrastructure/crypto/termsCrypto';
import { PartyGateway } from '@/infrastructure/gateway/partyGateway';
import { EscrowSimulator } from '@/infrastructure/simulator/escrowSimulator';
import { migratePlaintextAdminKey, migratePlaintextAuthorityKeys, sharedVault, vaultSignal } from '@/infrastructure/storage/vaultInstance';
import { LocalStorageStore } from '@/infrastructure/storage/kv';
import { sharedTxLog } from '@/infrastructure/storage/txLogStore';
import { networkConfig } from '@/infrastructure/config/network';
import { createWalletProviders, type AppProviders } from '@/infrastructure/wallet/providers';
import { activeSink } from '@/application/deployProgress';
import { useApp } from './AppProvider';

export type Mode = 'wallet' | 'simulator';
const CONTRACT_SLOT = 'party:contract';
const MODE_SLOT = 'party:mode';

export interface TimelineEvent {
  at: number;
  round: string;
  status: string;
  circuit?: string;
  txHash?: string;
  role?: string;
}

interface EscrowCtx {
  mode: Mode;
  setMode: (m: Mode) => void;
  contractAddress: string | null;
  setContractAddress: (a: string | null) => Promise<void>;
  // vault
  vaultExists: boolean | null;
  vaultUnlocked: boolean;
  /** Resolves to null on success, or the reason it failed (shown next to the passphrase field). */
  unlockVault: (passphrase: string) => Promise<string | null>;
  lockVault: () => void;
  record: VaultRecord;
  updateRecord: (fn: (r: VaultRecord) => VaultRecord) => Promise<void>;
  identity: VaultRecord['identity'] | null;
  /** Current envelope key first, then earlier ones (restored from a backup); all are tried when opening envelopes. */
  identities: NonNullable<VaultRecord['identity']>[];
  /** Re-reads the vault (after a restore): envelope identities and the active escrow's record. */
  reloadVault: () => Promise<void>;
  eraseLocal: () => Promise<void>;
  // chain / simulator
  view: EscrowView | null;
  now: bigint;
  refresh: () => Promise<void>;
  gateway: () => Promise<EscrowPartyGateway>;
  run: <C extends PartyCircuit>(caller: Caller, circuit: C, args: CircuitArgs[C], role?: PartyRole) => Promise<CallReceipt | undefined>;
  busy: boolean;
  error: string | null;
  setError: (e: string | null) => void;
  notice: string | null;
  setNotice: (n: string | null) => void;
  // keys
  roleKey: (role: PartyRole) => string | null;
  setRoleKey: (role: PartyRole, hex: string | null) => Promise<void>;
  // simulator
  sim: EscrowSimulator | null;
  createSimulation: (opts?: { amount?: string; useCasp?: boolean }) => Promise<void>;
  simFinalize: () => Promise<void>;
  setSimTime: (sec: number) => void;
  timeline: TimelineEvent[];
  casp: HttpCaspGateway;
  trackVaultIndex: (depositTxHash?: string) => Promise<void>;
}

const Ctx = createContext<EscrowCtx | null>(null);
export const useEscrow = (): EscrowCtx => {
  const c = useContext(Ctx);
  if (!c) throw new Error('useEscrow must be used inside <EscrowProvider>');
  return c;
};

export function EscrowProvider({ children }: { children: ReactNode }) {
  const { connector } = useApp();
  const session = connector.status === 'connected' ? connector.session : null;
  const prefs = useMemo(() => new LocalStorageStore('escrow'), []);
  const vault = useMemo(() => sharedVault(), []);
  const casp = useMemo(() => new HttpCaspGateway(), []);

  const [mode, setModeState] = useState<Mode>('wallet');
  const [contractAddress, setAddr] = useState<string | null>(null);
  const [vaultExists, setVaultExists] = useState<boolean | null>(null);
  const [vaultUnlocked, setUnlocked] = useState(false);
  const [record, setRecord] = useState<VaultRecord>({});
  const [identity, setIdentity] = useState<VaultRecord['identity'] | null>(null);
  const [identityHistory, setIdentityHistory] = useState<NonNullable<VaultRecord['identity']>[]>([]);
  const [view, setView] = useState<EscrowView | null>(null);
  const [now, setNow] = useState<bigint>(BigInt(Math.floor(Date.now() / 1000)));
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sim, setSim] = useState<EscrowSimulator | null>(null);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const providersRef = useRef<AppProviders | null>(null);
  const gwRef = useRef<PartyGateway | null>(null);
  const lastRound = useRef<string | null>(null);
  const simVersion = useSyncExternalStore(
    useCallback((fn: () => void) => (sim ? sim.subscribe(fn) : () => {}), [sim]),
    () => (sim ? `${sim.log.length}:${sim.time}` : ''),
    () => ''
  );

  useEffect(() => {
    void (async () => {
      const m = (await prefs.get(MODE_SLOT)) as Mode | null;
      if (m === 'wallet' || m === 'simulator') setModeState(m);
      setAddr(await prefs.get(CONTRACT_SLOT));
      setVaultExists(await vault.exists());
    })();
  }, [prefs, vault]);

  useEffect(() => {
    providersRef.current = null;
    gwRef.current = null;
  }, [session, contractAddress]);

  const setMode = useCallback(
    (m: Mode) => {
      setModeState(m);
      setView(null);
      void prefs.set(MODE_SLOT, m);
    },
    [prefs]
  );

  const activeAddress = mode === 'simulator' ? (sim?.contractAddress ?? null) : contractAddress;

  const setContractAddress = useCallback(
    async (a: string | null) => {
      const addr = a ? a.trim().toLowerCase().replace(/^0x/, '') : null;
      if (addr && !/^[0-9a-f]{64}$/.test(addr)) throw new Error('Contract address must be 64 hex characters.');
      gwRef.current = null;
      setView(null);
      setTimeline([]);
      lastRound.current = null;
      if (addr) await prefs.set(CONTRACT_SLOT, addr);
      else await prefs.remove(CONTRACT_SLOT);
      setAddr(addr);
    },
    [prefs]
  );

  // Vault record for the active escrow.
  useEffect(() => {
    if (!vaultUnlocked || !activeAddress) return setRecord({});
    void vault.load(activeAddress).then(setRecord, (e) => setError(String(e.message)));
  }, [vault, vaultUnlocked, activeAddress]);

  const updateRecord = useCallback(
    async (fn: (r: VaultRecord) => VaultRecord) => {
      if (!activeAddress) throw new Error('Load an escrow first.');
      if (!vault.unlocked) throw new Error('Unlock the vault first.');
      const next = fn(await vault.load(activeAddress));
      await vault.save(activeAddress, next);
      setRecord(next);
    },
    [vault, activeAddress]
  );

  const unlockVault = useCallback(
    async (passphrase: string) => {
      try {
        await vault.unlock(passphrase);
        setVaultExists(true);
        let id = (await vault.load(IDENTITY_RECORD)).identity;
        if (!id) {
          try {
            id = await generateRecipientKeyPair();
            await vault.save(IDENTITY_RECORD, { identity: id });
          } catch {
            id = undefined; // X25519 unavailable in this browser: envelopes disabled, passphrase backups still work
          }
        }
        setIdentity(id ?? null);
        setIdentityHistory((await vault.load(IDENTITY_RECORD)).identityHistory ?? []);
        // Earlier versions kept the contract authority key in plain localStorage: move it into the vault, then delete it.
        const moved = await migratePlaintextAuthorityKeys(prefs, vault).catch(() => 0);
        const adminMoved = await migratePlaintextAdminKey(prefs, vault).catch(() => false);
        const notes = [
          moved ? `${moved} contract authority key(s)` : null,
          adminMoved ? 'the admin secret key' : null
        ].filter(Boolean);
        if (notes.length) setNotice(`Moved ${notes.join(' and ')} from plain browser storage into the encrypted vault.`);
        setUnlocked(true);
        vaultSignal.emit();
        return null;
      } catch (e) {
        vault.lock();
        return (e as Error).message || String(e);
      }
    },
    [vault, prefs]
  );

  const lockVault = useCallback(() => {
    vault.lock();
    setUnlocked(false);
    vaultSignal.emit();
    setRecord({});
    setIdentity(null);
    setIdentityHistory([]);
  }, [vault]);

  const gateway = useCallback(async (): Promise<EscrowPartyGateway> => {
    if (mode === 'simulator') {
      if (!sim) throw new Error('Create a simulated escrow first.');
      return sim.gateway(record.terms?.terms.buyerPayout ?? null);
    }
    if (!contractAddress) throw new Error('Load an escrow address first.');
    if (!session) throw new Error('Connect a wallet (Lace or 1AM) for Wallet Mode, or switch to Simulator Mode.');
    providersRef.current ??= await createWalletProviders(session, prefs, activeSink);
    gwRef.current ??= new PartyGateway(contractAddress, providersRef.current, session);
    return gwRef.current;
  }, [mode, sim, contractAddress, session, prefs, record.terms]);

  const refresh = useCallback(async () => {
    try {
      if (mode === 'simulator' && !sim) return;
      if (mode === 'wallet' && (!contractAddress || !session)) return;
      const gw = await gateway();
      const v = await gw.readView();
      setView(v);
      setNow(await gw.now());
      const round = v.lifecycleRound.toString();
      if (lastRound.current !== round) {
        // FR-AUDIT-01: one entry per lifecycleRound change seen by this browser.
        const last = sim?.log.at(-1);
        setTimeline((t) => [...t, { at: Date.now(), round, status: v.status, circuit: mode === 'simulator' ? last?.circuit : undefined, txHash: mode === 'simulator' ? last?.txHash : undefined }]);
        lastRound.current = round;
      }
    } catch (e) {
      setError(friendlyMessage(e));
    }
  }, [mode, sim, contractAddress, session, gateway]);

  useEffect(() => {
    void refresh();
    if (mode !== 'wallet') return;
    const id = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(id);
  }, [refresh, mode, simVersion]);

  const roleKey = useCallback((role: PartyRole) => record.roleKeys?.[role] ?? null, [record.roleKeys]);

  const setRoleKey = useCallback(
    async (role: PartyRole, hex: string | null) => {
      if (hex !== null) secretKeyFromHex(hex);
      await updateRecord((r) => {
        const keys = { ...(r.roleKeys ?? {}) };
        const previous = keys[role];
        const next = hex === null ? undefined : hex.trim().toLowerCase().replace(/^0x/, '');
        if (next === undefined) delete keys[role];
        else keys[role] = next;
        // A removed or replaced key is kept in the record's history so it can be put back (Restore removed key).
        const history =
          previous && previous !== next && !(r.roleKeyHistory ?? []).some((h) => h.role === role && h.key === previous)
            ? [...(r.roleKeyHistory ?? []), { role, key: previous, removedAt: Date.now() }]
            : r.roleKeyHistory;
        return { ...r, roleKeys: keys, roleKeyHistory: history };
      });
    },
    [updateRecord]
  );

  const run = useCallback(
    async <C extends PartyCircuit>(caller: Caller, circuit: C, args: CircuitArgs[C], role?: PartyRole): Promise<CallReceipt | undefined> => {
      setError(null);
      setBusy(true);
      deployTracker.start(mode === 'wallet' ? 'wallet' : 'test', undefined, circuit);
      deployTracker.begin('validate');
      try {
        const gw = await gateway();
        const keyRole = role ?? (caller === 'anyone' ? null : caller);
        const hex = keyRole ? (record.roleKeys?.[keyRole] ?? null) : null;
        const out = await runPartyAction(
          { gateway: gw, crypto: termsCrypto, record, secretKey: hex ? secretKeyFromHex(hex) : undefined, txLog: sharedTxLog(), network: gw.mode === 'wallet' ? networkConfig.networkId : 'simulator' },
          caller,
          circuit,
          args
        );
        deployTracker.done('validate');
        if (vault.unlocked && activeAddress) {
          await vault.save(activeAddress, out.record);
          setRecord(out.record);
        }
        deployTracker.succeed({ txHash: out.receipt.txHash });
        await refresh();
        return out.receipt;
      } catch (e) {
        const msg = friendlyMessage(e);
        deployTracker.fail(msg);
        setError(msg);
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [gateway, record, vault, activeAddress, refresh, mode]
  );

  const trackVaultIndex = useCallback(
    async (depositTxHash?: string) => {
      setError(null);
      try {
        const gw = await gateway();
        const base = depositTxHash && record.terms ? { ...record, terms: { ...record.terms, depositTxHash } } : record;
        const next = await trackVault({ gateway: gw, crypto: termsCrypto, record: base });
        if (next.terms?.vaultIndex === undefined) throw new Error('Vault index not found yet. Check the deposit transaction hash, or enter the index the depositor shared.');
        await updateRecord(() => next);
      } catch (e) {
        setError(friendlyMessage(e));
      }
    },
    [gateway, record, updateRecord]
  );

  /** Simulator Mode: a ready-to-use escrow with every role key in the vault and the live CASP simulator whitelisted. */
  const createSimulation = useCallback(
    async (opts: { amount?: string; useCasp?: boolean } = {}) => {
      setError(null);
      try {
        if (!vault.unlocked) throw new Error('Unlock the vault first: role keys and terms are kept encrypted.');
        const keys = Object.fromEntries(PARTY_ROLES.map((r) => [r, bytesToHex(generateSecretKey())])) as Record<PartyRole, string>;
        const id = (r: PartyRole) => roleIdHex(secretKeyFromHex(keys[r]));
        const t0 = Math.floor(Date.now() / 1000);
        const color = bytesToHex(generateSecretKey());
        const s = await EscrowSimulator.create({ adminRoleId: id('admin'), buyerRoleId: id('buyer'), sellerRoleId: id('seller'), tokenColor: color, ticker: 'EURe' }, { time: t0 });
        s.logger = sharedTxLog();
        const wallet = session ? await createWalletProviders(session, prefs).then((p) => p.walletProvider.getCoinPublicKey() as unknown as string).catch(() => null) : null;
        const pkg = {
          ...createTermsPackage(termsCrypto, { amount: opts.amount ?? '250000', buyerPayout: wallet ?? bytesToHex(generateSecretKey()), sellerPayout: bytesToHex(generateSecretKey()) }),
          contractAddress: s.contractAddress,
          escrowColor: color,
          escrowTicker: 'EURe'
        };
        const admin = secretKeyFromHex(keys.admin);
        await s.configure(admin, {
          inspector: id('inspector'),
          lender: id('lender'),
          titleAgent: id('titleAgent'),
          resolver: id('resolver'),
          buyerPayoutCommitment: pkg.commitments.buyerPayout,
          sellerPayoutCommitment: pkg.commitments.sellerPayout,
          amountCommitment: pkg.commitments.amount,
          closingDeadline: BigInt(t0 + 30 * 86400),
          disputeDeadline: BigInt(t0 + 45 * 86400),
          kycPolicy: { minKycLevel: 2, maxAmlRiskScore: 30 }
        });
        if (opts.useCasp !== false) {
          const { keys: issuers } = await casp.issuerKeys();
          for (const k of issuers.filter((i) => i.status === 'active')) await s.addKycIssuer(admin, k.issuerId, k.publicKey);
        }
        await vault.save(s.contractAddress, { terms: pkg, roleKeys: keys });
        lastRound.current = null;
        setTimeline([]);
        setSim(s);
        setModeState('simulator');
        void prefs.set(MODE_SLOT, 'simulator');
      } catch (e) {
        setError(friendlyMessage(e));
      }
    },
    [vault, session, prefs, casp]
  );

  const simFinalize = useCallback(async () => {
    setError(null);
    try {
      if (!sim) throw new Error('No simulated escrow.');
      const r = await vault.load(sim.contractAddress);
      const blockers = finalizeBlockers(sim.view(), r, termsCrypto, BigInt(sim.time));
      if (blockers.length) throw new Error(blockers.join(' · '));
      await sim.finalize(secretKeyFromHex(r.roleKeys!.admin));
      await refresh();
    } catch (e) {
      setError(friendlyMessage(e));
    }
  }, [sim, vault, refresh]);

  const reloadVault = useCallback(async () => {
    if (!vault.unlocked) return;
    const idRec = await vault.load(IDENTITY_RECORD);
    setIdentity(idRec.identity ?? null);
    setIdentityHistory(idRec.identityHistory ?? []);
    if (activeAddress) setRecord(await vault.load(activeAddress));
    vaultSignal.emit();
  }, [vault, activeAddress]);

  const eraseLocal = useCallback(async () => {
    if (!activeAddress) return;
    await vault.erase(activeAddress);
    setRecord({});
  }, [vault, activeAddress]);

  const value: EscrowCtx = {
    mode,
    setMode,
    contractAddress: activeAddress,
    setContractAddress,
    vaultExists,
    vaultUnlocked,
    unlockVault,
    lockVault,
    record,
    updateRecord,
    identity,
    identities: [...(identity ? [identity] : []), ...identityHistory],
    reloadVault,
    eraseLocal,
    view,
    now,
    refresh,
    gateway,
    run,
    busy,
    error,
    setError,
    notice,
    setNotice,
    roleKey,
    setRoleKey,
    sim,
    createSimulation,
    simFinalize,
    setSimTime: (sec) => sim?.setTime(sec),
    timeline,
    casp,
    trackVaultIndex
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
