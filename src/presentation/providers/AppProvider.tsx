'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { CONTRACT_SLOT, registerMissing, runAction, stagedDeploy } from '@/application/adminService';
import { activeSink, deployTracker, type DeployProgress } from '@/application/deployProgress';
import { friendlyMessage } from '@/domain/errors';
import { bytesToHex } from '@/domain/hex';
import type { AdminState, ConfigureTerms, DeployParams } from '@/domain/escrow';
import { MAINTENANCE_BATCH_SIZE, networkConfig } from '@/infrastructure/config/network';
import { generateSecretKey, roleIdHex, secretKeyFromHex } from '@/infrastructure/crypto/identity';
import { AdminGateway } from '@/infrastructure/gateway/adminGateway';
import { LocalStorageStore } from '@/infrastructure/storage/kv';
import { exportAuthorityKey, importAuthorityKey } from '@/infrastructure/storage/authorityKey';
import { loadAdminKey, saveAdminKey, sharedVault, vaultSignal } from '@/infrastructure/storage/vaultInstance';
import { WalletConnector, detectWallets, waitForWallets, type ConnectorState, type DetectedWallet } from '@/infrastructure/wallet/connector';
import { createWalletProviders, type AppProviders } from '@/infrastructure/wallet/providers';
import { readDust, type DustReport } from '@/infrastructure/wallet/dust';


interface App {
  connector: ConnectorState;
  wallets: DetectedWallet[];
  rescanWallets: () => Promise<void>;
  connectWallet: (key: string) => Promise<void>;
  disconnectWallet: () => void;
  /** Hex of the admin secret key held in this browser, or null. */
  adminKey: string | null;
  adminRoleId: string | null;
  setAdminKey: (hex: string | null) => Promise<void>;
  newAdminKey: () => Promise<string>;
  contractAddress: string | null;
  state: AdminState | null;
  progress: DeployProgress | null;
  dismissProgress: () => void;
  error: string | null;
  clearError: () => void;
  loadContract: (address: string) => Promise<void>;
  refresh: () => Promise<void>;
  deploy: (p: DeployParams) => Promise<void>;
  registerRemaining: () => Promise<void>;
  configure: (t: ConfigureTerms) => Promise<void>;
  finalize: () => Promise<void>;
  addKycIssuer: (issuerId: string, publicKey: { x: string; y: string }) => Promise<void>;
  removeKycIssuer: (issuerId: string) => Promise<void>;
  authorityKey: () => Promise<string | null>;
  importAuthority: (key: string) => Promise<void>;
  /** Is the vault's authority key the on-chain maintenance authority? */
  authorityStatus: () => Promise<'match' | 'mismatch' | 'missing' | 'renounced' | null>;
  /** Recommendation 1: replace the authority with an empty committee (irreversible). */
  renounceAuthority: () => Promise<void>;
  /** Compares the stored admin key with the on-chain admin id of the loaded contract. */
  verifyAdminKey: () => boolean | null;
  /** Connected wallet's DUST as it reports it (null if not connected / not answering). */
  dust: DustReport | null;
  refreshDust: () => Promise<void>;
}

const Ctx = createContext<App | null>(null);
export const useApp = (): App => {
  const c = useContext(Ctx);
  if (!c) throw new Error('useApp must be used inside <AppProvider>');
  return c;
};

export function AppProvider({ children }: { children: ReactNode }) {
  const store = useMemo(() => new LocalStorageStore('escrow'), []);
  const connectorRef = useRef<WalletConnector | null>(null);
  if (!connectorRef.current) connectorRef.current = new WalletConnector(networkConfig.networkId);
  const connector = connectorRef.current;
  const connState = useSyncExternalStore(connector.subscribe, connector.getState, connector.getState);

  const [wallets, setWallets] = useState<DetectedWallet[]>([]);
  const [adminKey, setAdminKeyState] = useState<string | null>(null);
  const [contractAddress, setContractAddress] = useState<string | null>(null);
  const [state, setState] = useState<AdminState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const progress = useSyncExternalStore(deployTracker.subscribe, () => deployTracker.snapshot, () => null);
  const providersRef = useRef<AppProviders | null>(null);
  const gatewayRef = useRef<AdminGateway | null>(null);

  const getSecretKey = useCallback(() => {
    if (!adminKeyRef.current) throw new Error(sharedVault().unlocked ? 'No admin secret key. Generate or import one on the Keys tab.' : 'Unlock the vault: the admin secret key is stored there, encrypted.');
    return secretKeyFromHex(adminKeyRef.current);
  }, []);
  const adminKeyRef = useRef<string | null>(null);
  adminKeyRef.current = adminKey;

  const guard = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(friendlyMessage(e));
      return undefined;
    }
  }, []);

  // Restore persisted key / contract; reconnect the last wallet silently.
  useEffect(() => {
    void (async () => {
      setContractAddress(await store.get(CONTRACT_SLOT));
      setWallets(await waitForWallets());
      await connector.tryAutoReconnect();
    })();
  }, [store, connector]);

  // The admin secret key lives only in the encrypted vault: re-read it whenever the vault is unlocked, locked or restored.
  const vaultVersion = useSyncExternalStore(vaultSignal.subscribe, vaultSignal.getVersion, () => 0);
  useEffect(() => {
    gatewayRef.current = null;
    void loadAdminKey(sharedVault()).then(setAdminKeyState, () => setAdminKeyState(null));
  }, [vaultVersion]);

  const session = connState.status === 'connected' ? connState.session : null;
  const [dust, setDust] = useState<DustReport | null>(null);
  const refreshDust = useCallback(async () => setDust(session ? await readDust(session.api) : null), [session]);
  useEffect(() => {
    void refreshDust();
    if (!session) return;
    const id = setInterval(() => void refreshDust(), 30_000);
    return () => clearInterval(id);
  }, [refreshDust, session]);
  useEffect(() => {
    providersRef.current = null;
    gatewayRef.current = null;
  }, [session]);

  const providers = useCallback(async (): Promise<AppProviders> => {
    if (!session) throw new Error('Connect a wallet first.');
    providersRef.current ??= await createWalletProviders(session, store, activeSink);
    return providersRef.current;
  }, [session, store]);

  const gateway = useCallback(async (): Promise<AdminGateway> => {
    if (!contractAddress) throw new Error('No contract loaded. Deploy one or attach to an address.');
    gatewayRef.current ??= await AdminGateway.connect(await providers(), contractAddress, getSecretKey);
    return gatewayRef.current;
  }, [contractAddress, providers, getSecretKey]);

  const refresh = useCallback(async () => {
    if (!contractAddress || !session) return;
    await guard(async () => setState(await AdminGateway.readState(await providers(), contractAddress)));
  }, [contractAddress, session, providers, guard]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Other parties change the contract from their own pages (acceptances, deposit…): re-read it quietly in the
  // background so the admin console does not show a stale status. Skipped while an admin transaction is running.
  useEffect(() => {
    if (!contractAddress || !session) return;
    const id = setInterval(() => {
      if (deployTracker.snapshot?.status === 'running') return;
      void providers()
        .then((p) => AdminGateway.readState(p, contractAddress))
        .then(setState, () => undefined);
    }, 20_000);
    return () => clearInterval(id);
  }, [contractAddress, session, providers]);

  const adoptAddress = useCallback(
    async (address: string) => {
      gatewayRef.current = null;
      await store.set(CONTRACT_SLOT, address);
      setContractAddress(address);
    },
    [store]
  );

  const value: App = {
    connector: connState,
    wallets,
    rescanWallets: async () => setWallets(detectWallets().length ? detectWallets() : await waitForWallets(800)),
    connectWallet: async (key) => void (await guard(() => connector.connect(key))),
    disconnectWallet: () => {
      connector.disconnect();
      setState(null);
    },
    adminKey,
    adminRoleId: adminKey ? roleIdHex(secretKeyFromHex(adminKey)) : null,
    setAdminKey: async (hex) => {
      if (hex !== null) secretKeyFromHex(hex); // validates
      gatewayRef.current = null;
      await saveAdminKey(sharedVault(), hex);
      setAdminKeyState(hex ? hex.toLowerCase().replace(/^0x/, '') : null);
    },
    newAdminKey: async () => {
      const hex = bytesToHex(generateSecretKey());
      gatewayRef.current = null;
      await saveAdminKey(sharedVault(), hex);
      setAdminKeyState(hex);
      return hex;
    },
    contractAddress,
    state,
    progress,
    dismissProgress: () => deployTracker.dismiss(),
    error,
    clearError: () => setError(null),
    loadContract: async (address) => {
      await guard(async () => {
        const a = address.trim().replace(/^0x/, '').toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(a)) throw new Error('Contract address must be 64 hex characters.');
        await adoptAddress(a);
      });
    },
    refresh,
    deploy: async (params) => {
      await guard(async () => {
        const p = await providers();
        const out = await stagedDeploy(
          { tracker: deployTracker, store, batchSize: MAINTENANCE_BATCH_SIZE, deploy: (x) => AdminGateway.deploy(p, x, getSecretKey) },
          params
        );
        gatewayRef.current = out.gateway as AdminGateway;
        await adoptAddress(out.gateway.contractAddress);
        setState(await AdminGateway.readState(p, out.gateway.contractAddress));
      });
    },
    registerRemaining: async () => {
      await guard(async () => {
        const gw = await gateway();
        deployTracker.start('wallet', [], 'Register remaining circuits');
        try {
          await registerMissing(gw, deployTracker, MAINTENANCE_BATCH_SIZE);
          deployTracker.succeed({ contractAddress: gw.contractAddress });
        } catch (e) {
          deployTracker.fail(e instanceof Error ? e.message : String(e));
          throw e;
        }
        gatewayRef.current = null;
        await refresh();
      });
    },
    configure: async (terms) => {
      await guard(async () => {
        const gw = await gateway();
        await runAction(deployTracker, 'Configure terms', () => gw.configure(terms));
        await refresh();
      });
    },
    finalize: async () => {
      await guard(async () => {
        const gw = await gateway();
        await runAction(deployTracker, 'Finalize initialization', () => gw.finalize());
        await refresh();
      });
    },
    addKycIssuer: async (issuerId, publicKey) => {
      await guard(async () => {
        const gw = await gateway();
        await runAction(deployTracker, 'Whitelist CASP issuer', () => gw.addKycIssuer(issuerId, publicKey));
        await refresh();
      });
    },
    removeKycIssuer: async (issuerId) => {
      await guard(async () => {
        const gw = await gateway();
        await runAction(deployTracker, 'Remove CASP issuer', () => gw.removeKycIssuer(issuerId));
        await refresh();
      });
    },
    authorityKey: async () => {
      if (!contractAddress) return null;
      const saved = await guard(() => exportAuthorityKey(sharedVault(), contractAddress));
      if (saved) return saved;
      // Not in the vault (e.g. the vault save failed right after a deploy): last resort, the in-memory copy.
      return providersRef.current ? ((await providersRef.current.privateStateProvider.getSigningKey(contractAddress)) as string | null) : null;
    },
    importAuthority: async (key) => {
      await guard(async () => {
        if (!contractAddress) throw new Error('Load a contract first.');
        await importAuthorityKey(sharedVault(), contractAddress, key);
        gatewayRef.current = null;
      });
    },
    authorityStatus: async () => {
      if (!contractAddress || !session) return null;
      return (await guard(async () => (await gateway()).authorityKeyStatus())) ?? null;
    },
    renounceAuthority: async () => {
      await guard(async () => {
        const gw = await gateway();
        await runAction(deployTracker, 'Renounce maintenance authority (make the contract immutable)', () => gw.renounceAuthority());
        await refresh();
      });
    },
    verifyAdminKey: () => (state && value.adminRoleId ? state.roles.admin === value.adminRoleId : null),
    dust,
    refreshDust
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
