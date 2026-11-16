import type { HealthProbe, ProbeOutcome } from '@/application/ports';
import type { HealthCheckId } from '@/domain/health';
import type { WalletConnector } from '../wallet/connector';
import { bundleDrift, driftText, proofCircuitsOf } from '../contract/compat';

type FetchFn = typeof fetch;
type WebSocketCtor = new (url: string, protocols?: string | string[]) => WebSocket;

export interface ProbeEnv {
  fetch: FetchFn;
  WebSocket?: WebSocketCtor;
  /** How long the WebSocket probe waits for the GraphQL handshake. */
  wsHandshakeMs?: number;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * "HTTP 502", plus the reason when the body carries one. The same-origin proxies (/api/indexer, /api/casp) answer
 * 502 with `{ errors: [{ message }] }` / `{ error }` when their upstream is unreachable: that reason is what to show.
 */
async function statusInfo(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: unknown; errors?: { message?: unknown }[] } | null;
  const reason = typeof body?.error === 'string' ? body.error : typeof body?.errors?.[0]?.message === 'string' ? body.errors[0].message : null;
  return reason ? `HTTP ${res.status}: ${reason}` : `HTTP ${res.status}`;
}

/**
 * One HTTP check. A browser cannot read why a cross-origin request failed (server down, an error page without CORS
 * headers, or CORS refusing this site all look the same), so on failure an opaque `no-cors` request tells apart
 * "something answers" from "nothing answers".
 * - `readable`: the app itself must read the answer (indexer, proof server) — an unreadable answer is "degraded".
 */
export async function probeHttp(
  env: ProbeEnv,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  opts: { readable: boolean; check?: (res: Response) => Promise<ProbeOutcome> }
): Promise<ProbeOutcome> {
  try {
    const res = await env.fetch(url, { ...init, signal });
    if (res.status >= 500) return { status: 'down', detail: { code: 'http-error', info: await statusInfo(res) } };
    if (!res.ok) return { status: 'degraded', detail: { code: 'http-error', info: await statusInfo(res) } };
    return opts.check ? await opts.check(res) : { status: 'ok' };
  } catch (e) {
    if (signal.aborted) throw e;
    try {
      await env.fetch(url, { method: 'GET', mode: 'no-cors', signal });
    } catch {
      if (signal.aborted) throw e;
      return { status: 'down', detail: { code: 'no-response', info: msg(e) } };
    }
    return opts.readable
      ? { status: 'degraded', detail: { code: 'unreadable' } }
      : { status: 'ok', detail: { code: 'opaque-ok' } };
  }
}

const graphqlOk = async (res: Response): Promise<ProbeOutcome> => {
  const body = (await res.json().catch(() => null)) as { data?: { __typename?: string }; errors?: { message: string }[] } | null;
  if (body?.data?.__typename) return { status: 'ok' };
  return { status: 'degraded', detail: { code: 'not-graphql', info: body?.errors?.[0]?.message } };
};

const GRAPHQL_PING: RequestInit = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '{ __typename }' }) };

/** GraphQL subscriptions endpoint: open + `graphql-transport-ws` handshake (connection_init → connection_ack). */
export function probeWebSocket(env: ProbeEnv, url: string, signal: AbortSignal): Promise<ProbeOutcome> {
  const WS = env.WebSocket;
  if (!WS) return Promise.resolve({ status: 'skipped', detail: { code: 'ws-unavailable' } });
  return new Promise((resolve) => {
    let opened = false;
    let done = false;
    const ws = new WS(url, 'graphql-transport-ws');
    const finish = (o: ProbeOutcome) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      resolve(o);
    };
    const timer = setTimeout(
      () => finish(opened ? { status: 'degraded', detail: { code: 'ws-no-handshake' } } : { status: 'down', detail: { code: 'ws-no-connect' } }),
      env.wsHandshakeMs ?? 5000
    );
    signal.addEventListener('abort', () => finish({ status: 'down', detail: { code: 'timeout' } }));
    ws.onopen = () => {
      opened = true;
      ws.send(JSON.stringify({ type: 'connection_init', payload: {} }));
    };
    ws.onmessage = (ev) => {
      const type = (() => {
        try {
          return (JSON.parse(String(ev.data)) as { type?: string }).type;
        } catch {
          return undefined;
        }
      })();
      if (type === 'connection_ack') finish({ status: 'ok' });
    };
    ws.onerror = () => finish(opened ? { status: 'degraded', detail: { code: 'ws-error' } } : { status: 'down', detail: { code: 'ws-no-connect' } });
    ws.onclose = (ev) => finish({ status: opened ? 'degraded' : 'down', detail: { code: 'ws-closed', info: `code ${ev.code}` } });
  });
}

const probe = (id: HealthCheckId, target: string, critical: boolean, run: HealthProbe['run']): HealthProbe => ({ id, target, critical, run });

export interface ProbeConfig {
  /** Configured indexer, as shown to the user (midnight.config.json). */
  indexer: string;
  /** Where the browser actually sends indexer queries: the same-origin `/api/indexer` proxy (see config/network.ts). */
  indexerHttp: string;
  indexerWS: string;
  proofServer: string;
  nodeRpc: string;
  networkId: string;
  /** Same-origin base of the compiled contract's ZK artefacts, e.g. `/zk/escrow`. */
  zkBase: string;
  /** A circuit that is always compiled, to check the proving keys exist. */
  keyCircuit: string;
  /**
   * The proof circuits this page's code was built with: compared with the server's compiled contract to catch a page
   * or dev server older than the last compile (keys requested for circuits the server no longer has).
   */
  buildCircuits?: readonly string[];
  /** Same-origin CASP simulator proxy (`/api/casp`, see src/app/api/casp). */
  caspBase: string;
}

/** Every infrastructure element the dApp depends on, in display order. */
export function createHealthProbes(cfg: ProbeConfig, connector: WalletConnector, env: ProbeEnv): HealthProbe[] {
  const session = () => {
    const s = connector.getState();
    return s.status === 'connected' ? s.session : null;
  };
  const trim = (u: string) => u.replace(/\/$/, '');

  return [
    probe('indexer-http', cfg.indexer, true, (signal) => probeHttp(env, cfg.indexerHttp, GRAPHQL_PING, signal, { readable: true, check: graphqlOk })),
    probe('indexer-ws', cfg.indexerWS, true, (signal) => probeWebSocket(env, cfg.indexerWS, signal)),
    probe('wallet', 'Lace / 1AM', true, async () => {
      const s = session();
      if (!s) return { status: 'skipped', detail: { code: 'no-wallet' } };
      const st = await s.api.getConnectionStatus();
      const target = `${s.wallet.name} · ${st.status === 'connected' ? st.networkId : 'disconnected'}`;
      if (st.status !== 'connected') return { status: 'down', detail: { code: 'wallet-disconnected' }, target };
      if (st.networkId !== cfg.networkId) return { status: 'down', detail: { code: 'wallet-network', info: `${st.networkId} ≠ ${cfg.networkId}` }, target };
      return { status: 'ok', target };
    }),
    probe('wallet-indexer', "wallet's indexer", true, async (signal) => {
      const s = session();
      if (!s) return { status: 'skipped', detail: { code: 'no-wallet' } };
      const wc = await s.api.getConfiguration();
      const out = await probeHttp(env, wc.indexerUri, GRAPHQL_PING, signal, { readable: true, check: graphqlOk });
      return { ...out, target: wc.indexerUri };
    }),
    probe('proof-server', cfg.proofServer, true, (signal) => probeHttp(env, `${trim(cfg.proofServer)}/health`, { method: 'GET' }, signal, { readable: true })),
    probe('zk-artifacts', cfg.zkBase, true, async (signal) => {
      const manifest = await env.fetch(`${cfg.zkBase}/compiler/contract-manifest.json`, { signal });
      if (!manifest.ok) return { status: 'down', detail: { code: 'not-compiled' } };
      const key = await env.fetch(`${cfg.zkBase}/keys/${cfg.keyCircuit}.verifier`, { signal });
      if (!key.ok) return { status: 'degraded', detail: { code: 'no-keys' } };
      if (cfg.buildCircuits) {
        const info = await env.fetch(`${cfg.zkBase}/compiler/contract-info.json`, { signal, cache: 'no-store' });
        const server = info.ok ? proofCircuitsOf(await info.json().catch(() => null)) : null;
        if (server) {
          const d = bundleDrift(server, cfg.buildCircuits);
          if (d.added.length || d.removed.length) return { status: 'degraded', detail: { code: 'stale-bundle', info: driftText(d) } };
        }
      }
      return { status: 'ok' };
    }),
    probe('casp', `${cfg.caspBase} → CASP simulator`, true, async (signal) => {
      const url = `${trim(cfg.caspBase)}/health`;
      const res = await env.fetch(url, { method: 'GET', signal });
      // The proxy answers 404 "disabled" in production builds without CASP_SIM_ENABLED=1: the KYC steps then fail even
      // though the simulator itself is running, so this is "down" with its own fix, not "not checked".
      if (res.status === 404) return { status: 'down', detail: { code: 'casp-disabled' } };
      if (!res.ok) return { status: 'down', detail: { code: 'http-error', info: await statusInfo(res) } };
      const body = (await res.json().catch(() => null)) as { ok?: boolean; casp?: string } | null;
      if (!body?.ok) return { status: 'degraded', detail: { code: 'http-error', info: 'health: ok=false' } };
      return { status: 'ok', target: `${cfg.caspBase} → ${body.casp ?? 'CASP simulator'}` };
    }),
    probe('node-rpc', cfg.nodeRpc, false, (signal) =>
      probeHttp(env, cfg.nodeRpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'system_health', params: [] }) }, signal, { readable: false })
    )
  ];
}
