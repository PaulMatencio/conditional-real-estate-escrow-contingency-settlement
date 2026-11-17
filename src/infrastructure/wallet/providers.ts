import type { ConnectedAPI } from '@midnightntwrk/dapp-connector-api';
import { dappConnectorWalletProviders } from '@midnight-ntwrk/midnight-js-dapp-connector-proof-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import type { MidnightProviders, PrivateStateProvider, ProofProvider } from '@midnight-ntwrk/midnight-js-types';
import { MidnightBech32m, ShieldedCoinPublicKey, ShieldedEncryptionPublicKey } from '@midnightntwrk/wallet-sdk-address-format';
import type { KeyValueStore } from '@/application/ports';
import type { StepSink } from '@/application/deployProgress';
import { compactText, deepMessage } from '@/domain/errors';
import { indexerHttpUrl, networkConfig } from '../config/network';
import { CURRENT_VERSION, circuitsOf, zkPathOf, type ContractVersion } from '../contract/versions';
import { GuardedZkConfigProvider } from '../contract/guardedZkConfig';
import { isUserRejection, submitWithRetry, walletErrorText } from './submitRetry';
import { withFallback } from '../indexer/fallbackIndexer';
import { sharedIndexerBreaker, type IndexerBreaker } from '../indexer/indexerBreaker';
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

export type AppProviders = MidnightProviders<string, string, unknown> & {
  /**
   * The same providers with the ZK artefacts (keys, ZKIR) and prover of another supported contract version: an escrow
   * is always proved with the version it was deployed with (CLAUDE.md "Backward compatibility after a contract
   * upgrade"). Absent on providers built outside createWalletProviders (tests).
   */
  forVersion?: (v: ContractVersion) => AppProviders;
};

/** Providers for an escrow of `v` (the base providers when they cannot switch, or for the current version). */
export const providersFor = (p: AppProviders, v: ContractVersion): AppProviders => (v.current || !p.forVersion ? p : p.forVersion(v));

/** How long a built transaction stays valid (midnight-js 5 `config.ttlSeconds`). */
const TTL_SECONDS = 3600;

/**
 * Assembles midnight-js 5 providers from a connected wallet. Endpoints and the network id come from the wallet's own
 * configuration (respects the user's network choice); the proof server is the configured local one.
 *
 * `indexerBreaker` (shared by default): while the configured indexer is failing, reads go straight to the wallet's
 * indexer for a cooldown instead of failing — and logging — on every query.
 */
export async function createWalletProviders(session: WalletSession, store: KeyValueStore, sink?: StepSink, indexerBreaker: IndexerBreaker = sharedIndexerBreaker()): Promise<AppProviders> {
  const api: ConnectedAPI = session.api;
  const cfg = await api.getConfiguration();

  const walletIndexer = indexerPublicDataProvider(cfg.indexerUri, cfg.indexerWsUri);
  const publicDataProvider =
    cfg.networkId === networkConfig.networkId
      ? withFallback(indexerPublicDataProvider(indexerHttpUrl(), networkConfig.indexerWS), walletIndexer, indexerBreaker)
      : walletIndexer;
  // midnight-js 5 checks every artefact against the compiler's contract-manifest.json (served by the /zk route).
  // One ZK artefact provider and prover per contract version (keys under /zk/<version name>).
  const zkFor = (v: ContractVersion) => {
    // Guarded: a circuit the version lacks, or a key the server lacks, is a clear contract-version error, not a 404.
    const zkConfigProvider = new GuardedZkConfigProvider(`${window.location.origin}${zkPathOf(v)}`, { fetchFunc: fetch.bind(window) as never }, () => circuitsOf(v));
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
    return { zkConfigProvider, proofProvider };
  };
  const { zkConfigProvider, proofProvider } = zkFor(CURRENT_VERSION);

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
        // A first submit sometimes fails while the wallet is still settling (it then reports an opaque
        // "object: [object Object]"); the same proved transaction is resubmitted once, so no new proof is needed.
        await submitWithRetry(() => api.submitTransaction(tx), {
          onRetry: (_n, reason) => console.warn(`[wallet] submitTransaction failed (${reason}); retrying the same transaction once`)
        });
      } catch (e) {
        // A node "temporarily banned" / "already imported" rejection usually means an earlier attempt is
        // still pending or was dropped: show what the wallet itself last saw.
        console.error('[wallet] wallet.submitTransaction failed', e);
        const hist = await api.getTxHistory(0, 5).catch(() => null);
        const recent = hist ? hist.map((h) => `${String(h.txHash).slice(0, 10)}…=${h.txStatus.status}`).join(', ') : 'unavailable';
        console.error('[wallet] submit failed; recent wallet history:', hist);
        const hint = isUserRejection(e) ? '' : ' The wallet refused it twice: check the wallet is synced and has DUST, then run the action again (a new attempt usually goes through).';
        throw new Error(`${compactText(walletErrorText(e))} (during wallet.submitTransaction) [wallet recent: ${recent}]${hint}`, { cause: e });
      }
      sink?.done('submit');
      sink?.begin('confirm');
    }
  };
  const { walletProvider, midnightProvider } = await dappConnectorWalletProviders(wrapped as never);

  const privateStateProvider: PrivateStateProvider<string, unknown> = persistentPrivateStateProvider(store, vaultSigningKeys(sharedVault()));

  const base: AppProviders = {
    privateStateProvider,
    publicDataProvider,
    zkConfigProvider,
    proofProvider,
    walletProvider,
    midnightProvider,
    config: { networkId: cfg.networkId, ttlSeconds: TTL_SECONDS }
  };
  const byVersion = new Map<string, AppProviders>();
  base.forVersion = (v) => {
    if (v.current) return base;
    let p = byVersion.get(v.id);
    if (!p) {
      p = { ...base, ...zkFor(v) };
      byVersion.set(v.id, p);
    }
    return p;
  };
  return base;
}
