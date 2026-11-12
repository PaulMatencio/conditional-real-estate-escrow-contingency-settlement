import type { ConnectedAPI } from '@midnightntwrk/dapp-connector-api';
import { dappConnectorWalletProviders } from '@midnight-ntwrk/midnight-js-dapp-connector-proof-provider';
import { FetchZkConfigProvider } from '@midnight-ntwrk/midnight-js-fetch-zk-config-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import type { MidnightProviders, PrivateStateProvider, ProofProvider } from '@midnight-ntwrk/midnight-js-types';
import { MidnightBech32m, ShieldedCoinPublicKey, ShieldedEncryptionPublicKey } from '@midnightntwrk/wallet-sdk-address-format';
import type { KeyValueStore } from '@/application/ports';
import type { StepSink } from '@/application/deployProgress';
import { compactText, deepMessage } from '@/domain/errors';
import { indexerHttpUrl, networkConfig } from '../config/network';
import { ZK_ASSET_PATH } from '../contract/compiled';
import { persistentPrivateStateProvider } from '../storage/privateStateProvider';
import { sharedVault, vaultSigningKeys } from '../storage/vaultInstance';
import type { WalletSession } from './connector';
import { describeDust, readDust } from './dust';

const HEX64 = /^[0-9a-fA-F]{64}$/;

/**
 * The DApp Connector returns shielded keys Bech32m-encoded (mn_shield-cpk_…),
 * but midnight-js / the ledger want raw hex — passing the Bech32m string is
 * what makes the constructor context fail ("Failed to configure constructor
 * context with coin public key"). Accepts either form.
 */
export function shieldedKeyToHex(value: string, kind: 'coin' | 'encryption', networkId: string): string {
  if (HEX64.test(value)) return value.toLowerCase();
  const parsed = MidnightBech32m.parse(value);
  return kind === 'coin'
    ? ShieldedCoinPublicKey.codec.decode(networkId, parsed).toHexString()
    : ShieldedEncryptionPublicKey.codec.decode(networkId, parsed).toHexString();
}

/** DApp Connector errors are plain objects; show "Rejected: reason" rather than raw JSON. */
function readable(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === 'object') {
    const o = e as { type?: string; code?: string; reason?: string; message?: string };
    if (o.type === 'DAppConnectorAPIError') return `${o.code ?? 'Error'}${o.reason ? `: ${o.reason}` : ''}`;
    const parts = [...new Set(deepMessage(e))];
    return parts.length ? parts.join(' ← ') : compactText(JSON.stringify(e));
  }
  return String(e);
}

/** Fails fast, with an actionable message, when the local proof server isn't running. */
export async function assertProofServerReachable(url: string, timeoutMs = 4000): Promise<void> {
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    throw new Error(
      `Local proof server not reachable at ${url} (${e instanceof Error ? e.message : String(e)}). Start it (docker: midnightntwrk/proof-server:9.0.1 — ledger 9 / Compact 0.36 circuits need proof server 9, port 6300) or change "proofServer" in midnight.config.json.`
    );
  }
}

/** Re-throws with the failing step named and the raw error logged (wallets often say only "Request failed"). */
async function stage<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    console.error(`[wallet] ${name} failed`, e);
    const detail = compactText(readable(e));
    throw new Error(`${detail} (during ${name})`, { cause: e });
  }
}

export type AppProviders = MidnightProviders<string, string, unknown>;

type Pdp = ReturnType<typeof indexerPublicDataProvider>;

/**
 * Indexer reads with a fallback. Wallets report their own indexer, and not all of them index the same data (Lace in
 * Brave reports Blockfrost's Midnight service; 1AM reports its own): contract state and history can be missing there
 * even though the contract exists. The configured indexer (`midnight.config.json`) is tried first; the wallet's is the
 * fallback. Lookups return the first non-empty answer; "watch" promises resolve with whichever indexer sees the data first.
 */
export function withFallback(primary: Pdp, fallback: Pdp): Pdp {
  const first = async <T,>(a: () => Promise<T>, b: () => Promise<T>): Promise<T> => {
    try {
      const r = await a();
      if (r !== null && r !== undefined) return r;
    } catch {
      /* fall through to the wallet's indexer */
    }
    return b();
  };
  const overrides: Record<string, (...args: never[]) => unknown> = {
    queryContractState: (...a: never[]) => first(() => (primary.queryContractState as never as (...x: never[]) => Promise<unknown>)(...a), () => (fallback.queryContractState as never as (...x: never[]) => Promise<unknown>)(...a)),
    queryUnshieldedBalances: (...a: never[]) => first(() => (primary.queryUnshieldedBalances as never as (...x: never[]) => Promise<unknown>)(...a), () => (fallback.queryUnshieldedBalances as never as (...x: never[]) => Promise<unknown>)(...a)),
    queryDeployContractState: (...a: never[]) => first(() => (primary.queryDeployContractState as never as (...x: never[]) => Promise<unknown>)(...a), () => (fallback.queryDeployContractState as never as (...x: never[]) => Promise<unknown>)(...a)),
    watchForTxData: (...a: never[]) => Promise.any([(primary.watchForTxData as never as (...x: never[]) => Promise<unknown>)(...a), (fallback.watchForTxData as never as (...x: never[]) => Promise<unknown>)(...a)]),
    watchForDeployTxData: (...a: never[]) => Promise.any([(primary.watchForDeployTxData as never as (...x: never[]) => Promise<unknown>)(...a), (fallback.watchForDeployTxData as never as (...x: never[]) => Promise<unknown>)(...a)])
  };
  return new Proxy(primary, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && prop in overrides) return overrides[prop];
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    }
  });
}

/** How long a built transaction stays valid (midnight-js 5 `config.ttlSeconds`). */
const TTL_SECONDS = 3600;

/**
 * Assembles midnight-js 5 providers from a connected wallet. Endpoints and the network id come from the wallet's own
 * configuration (respects the user's network choice); the proof server is the configured local one.
 */
export async function createWalletProviders(session: WalletSession, store: KeyValueStore, sink?: StepSink): Promise<AppProviders> {
  const api: ConnectedAPI = session.api;
  const cfg = await api.getConfiguration();

  const walletIndexer = indexerPublicDataProvider(cfg.indexerUri, cfg.indexerWsUri);
  const publicDataProvider =
    cfg.networkId === networkConfig.networkId
      ? withFallback(indexerPublicDataProvider(indexerHttpUrl(), networkConfig.indexerWS), walletIndexer)
      : walletIndexer;
  // midnight-js 5 checks every artefact against the compiler's contract-manifest.json (served by the /zk route).
  const zkConfigProvider = new FetchZkConfigProvider<string>(`${window.location.origin}${ZK_ASSET_PATH}`, { fetchFunc: fetch.bind(window) as never });
  // Proving always uses the LOCAL proof server from midnight.config.json — never the wallet's hosted one
  // (cfg.proverServerUri) nor the wallet's in-extension prover. A proof request carries the circuit's private inputs
  // (witnesses such as the role secret key), which must not leave this machine. Compact 0.36 circuits are ZKIR v3:
  // the proof server must be version 9 (it proves both the contract's v3 and the wallet's v2 circuits).
  const baseProofProvider = httpClientProofProvider(networkConfig.proofServer, zkConfigProvider);
  // midnight-js order: build unproven tx → prove → balance → submit → confirm. Each wrapper reports its stage.
  const proofProvider: ProofProvider = {
    supportedEras: baseProofProvider.supportedEras,
    proveTx: async (...a: Parameters<ProofProvider['proveTx']>) => {
      await assertProofServerReachable(networkConfig.proofServer);
      sink?.done('build');
      sink?.begin('prove');
      const r = await baseProofProvider.proveTx(...a);
      sink?.done('prove');
      return r;
    }
  };

  // The wallet providers come from midnight-js (one handler per ledger era); this wrapper around the connector adds
  // stage reporting, the DUST diagnosis on a fee failure, and the wallet's recent history on a submit failure. It also
  // hands midnight-js the shielded keys as hex, the form the rest of the app shows and compares.
  const wrapped = {
    getShieldedAddresses: async () => {
      const keys = await api.getShieldedAddresses();
      return {
        ...keys,
        shieldedCoinPublicKey: shieldedKeyToHex(keys.shieldedCoinPublicKey, 'coin', cfg.networkId),
        shieldedEncryptionPublicKey: shieldedKeyToHex(keys.shieldedEncryptionPublicKey, 'encryption', cfg.networkId)
      };
    },
    // The connected wallet selects DUST inputs and pays the fee (payFees defaults to true).
    balanceUnsealedTransaction: async (tx: string, options?: { payFees?: boolean }) => {
      sink?.begin('balance');
      try {
        const r = await stage('wallet.balanceUnsealedTransaction', () => api.balanceUnsealedTransaction(tx, { payFees: true, ...options }));
        sink?.done('balance');
        return r;
      } catch (e) {
        // Fee payment failed: say what the wallet itself reports as spendable DUST, to tell a sync / generation
        // problem (low balance) from a wallet-side sponsoring problem (balance fine but still refused).
        const dust = await readDust(api);
        throw new Error(`${e instanceof Error ? e.message : String(e)} [${describeDust(dust)}]`, { cause: e });
      }
    },
    submitTransaction: async (tx: string) => {
      sink?.begin('submit');
      try {
        await stage('wallet.submitTransaction', () => api.submitTransaction(tx));
      } catch (e) {
        // A node "temporarily banned" / "already imported" rejection usually means an earlier attempt is
        // still pending or was dropped: show what the wallet itself last saw.
        const hist = await api.getTxHistory(0, 5).catch(() => null);
        const recent = hist ? hist.map((h) => `${String(h.txHash).slice(0, 10)}…=${h.txStatus.status}`).join(', ') : 'unavailable';
        console.error('[wallet] submit failed; recent wallet history:', hist);
        throw new Error(`${e instanceof Error ? e.message : String(e)} [wallet recent: ${recent}]`, { cause: e });
      }
      sink?.done('submit');
      sink?.begin('confirm');
    }
  };
  const { walletProvider, midnightProvider } = await dappConnectorWalletProviders(wrapped as never);

  const privateStateProvider: PrivateStateProvider<string, unknown> = persistentPrivateStateProvider(store, vaultSigningKeys(sharedVault()));

  return {
    privateStateProvider,
    publicDataProvider,
    zkConfigProvider,
    proofProvider,
    walletProvider,
    midnightProvider,
    config: { networkId: cfg.networkId, ttlSeconds: TTL_SECONDS }
  };
}
