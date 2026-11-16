import { describe, expect, it } from 'vitest';
import { createHealthProbes, probeHttp, probeWebSocket, type ProbeEnv } from '@/infrastructure/health/probes';
import type { WalletConnector } from '@/infrastructure/wallet/connector';

const signal = () => new AbortController().signal;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** fetch fake: `cors` answers readable requests; `opaque` decides whether a no-cors request gets through. */
const env = (cors: (url: string) => Response | Error, opaque = true): ProbeEnv => ({
  fetch: (async (url: string, init?: RequestInit) => {
    if (init?.mode === 'no-cors') {
      if (opaque) return new Response(null, { status: 200 });
      throw new TypeError('Failed to fetch');
    }
    const r = cors(String(url));
    if (r instanceof Error) throw r;
    return r;
  }) as typeof fetch
});

describe('probeHttp', () => {
  const ping = { method: 'POST' };
  it('ok when readable and valid', async () => {
    expect(await probeHttp(env(() => json({ ok: true })), 'https://x', ping, signal(), { readable: true })).toEqual({ status: 'ok' });
  });
  it('shows the reason a same-origin proxy gives for a 5xx (indexer / CASP unreachable)', async () => {
    expect(await probeHttp(env(() => json({ errors: [{ message: 'Indexer not reachable (fetch failed)' }] }, 502)), '/api/indexer', ping, signal(), { readable: true })).toEqual({
      status: 'down',
      detail: { code: 'http-error', info: 'HTTP 502: Indexer not reachable (fetch failed)' }
    });
  });
  it('a readable 5xx is down with its status, a 4xx degraded', async () => {
    expect(await probeHttp(env(() => json({}, 503)), 'https://x', ping, signal(), { readable: true })).toEqual({ status: 'down', detail: { code: 'http-error', info: 'HTTP 503' } });
    expect(await probeHttp(env(() => json({}, 404)), 'https://x', ping, signal(), { readable: true })).toMatchObject({ status: 'degraded', detail: { info: 'HTTP 404' } });
  });
  it('unreadable (CORS / error page) but answering: degraded when the app must read it, ok when it need not', async () => {
    const e = env(() => new TypeError('Failed to fetch'), true);
    expect(await probeHttp(e, 'https://x', ping, signal(), { readable: true })).toEqual({ status: 'degraded', detail: { code: 'unreadable' } });
    expect(await probeHttp(e, 'https://x', ping, signal(), { readable: false })).toEqual({ status: 'ok', detail: { code: 'opaque-ok' } });
  });
  it('no answer at all is down', async () => {
    expect(await probeHttp(env(() => new TypeError('Failed to fetch'), false), 'https://x', ping, signal(), { readable: true })).toEqual({ status: 'down', detail: { code: 'no-response', info: 'Failed to fetch' } });
  });
});

/** Minimal WebSocket fake driven by a script. */
function fakeWs(script: 'ack' | 'silent' | 'refuse') {
  return class {
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: ((e: { code: number }) => void) | null = null;
    constructor(public url: string, public protocol?: string) {
      setTimeout(() => (script === 'refuse' ? this.onerror?.() : this.onopen?.()), 5);
    }
    send(m: string) {
      if (script === 'ack' && JSON.parse(m).type === 'connection_init') setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: 'connection_ack' }) }), 5);
    }
    close() {}
  } as unknown as ProbeEnv['WebSocket'];
}

describe('probeWebSocket', () => {
  it('ok after the graphql-transport-ws handshake; degraded without a reply; down when refused', async () => {
    const base = { fetch: fetch, wsHandshakeMs: 100 };
    expect(await probeWebSocket({ ...base, WebSocket: fakeWs('ack') }, 'wss://x', signal())).toEqual({ status: 'ok' });
    expect(await probeWebSocket({ ...base, WebSocket: fakeWs('silent') }, 'wss://x', signal())).toEqual({ status: 'degraded', detail: { code: 'ws-no-handshake' } });
    expect(await probeWebSocket({ ...base, WebSocket: fakeWs('refuse') }, 'wss://x', signal())).toEqual({ status: 'down', detail: { code: 'ws-no-connect' } });
  });
});

describe('createHealthProbes', () => {
  const cfg = { indexer: 'https://idx/graphql', indexerHttp: 'http://localhost:3000/api/indexer', indexerWS: 'wss://idx/ws', proofServer: 'http://127.0.0.1:6300', nodeRpc: 'https://rpc', networkId: 'preview', zkBase: '/zk/escrow', keyCircuit: 'configure', caspBase: '/api/casp' };
  const connector = (state: unknown) => ({ getState: () => state }) as unknown as WalletConnector;
  const byId = (ps: ReturnType<typeof createHealthProbes>, id: string) => ps.find((p) => p.id === id)!;

  it('lists every element, the node RPC as information only', () => {
    const ps = createHealthProbes(cfg, connector({ status: 'idle' }), env(() => json({})));
    expect(ps.map((p) => p.id)).toEqual(['indexer-http', 'indexer-ws', 'wallet', 'wallet-indexer', 'proof-server', 'zk-artifacts', 'casp', 'node-rpc']);
    expect(ps.filter((p) => !p.critical).map((p) => p.id)).toEqual(['node-rpc']);
  });

  it('indexer: queried through the same-origin proxy, shown as the configured indexer', async () => {
    const seen: string[] = [];
    const ps = createHealthProbes(cfg, connector({}), env((u) => (seen.push(u), json({ data: { __typename: 'Query' } }))));
    expect(byId(ps, 'indexer-http').target).toBe('https://idx/graphql');
    expect(await byId(ps, 'indexer-http').run(signal())).toEqual({ status: 'ok' });
    expect(seen).toEqual(['http://localhost:3000/api/indexer']);
  });

  it('indexer: a GraphQL answer is ok, an unreadable one degraded', async () => {
    expect(await byId(createHealthProbes(cfg, connector({}), env(() => json({ data: { __typename: 'Query' } }))), 'indexer-http').run(signal())).toEqual({ status: 'ok' });
    expect(await byId(createHealthProbes(cfg, connector({}), env(() => new TypeError('Failed to fetch'))), 'indexer-http').run(signal())).toMatchObject({ status: 'degraded', detail: { code: 'unreadable' } });
  });

  it('wallet checks are skipped without a wallet, and catch a wrong network', async () => {
    const none = createHealthProbes(cfg, connector({ status: 'idle' }), env(() => json({})));
    expect(await byId(none, 'wallet').run(signal())).toEqual({ status: 'skipped', detail: { code: 'no-wallet' } });
    expect(await byId(none, 'wallet-indexer').run(signal())).toEqual({ status: 'skipped', detail: { code: 'no-wallet' } });
    const api = { getConnectionStatus: async () => ({ status: 'connected', networkId: 'preprod' }), getConfiguration: async () => ({ indexerUri: 'https://wallet-idx/graphql' }) };
    const wrong = createHealthProbes(cfg, connector({ status: 'connected', session: { wallet: { name: 'Lace' }, api } }), env(() => json({ data: { __typename: 'Query' } })));
    expect(await byId(wrong, 'wallet').run(signal())).toMatchObject({ status: 'down', detail: { code: 'wallet-network', info: 'preprod ≠ preview' }, target: 'Lace · preprod' });
    expect(await byId(wrong, 'wallet-indexer').run(signal())).toEqual({ status: 'ok', target: 'https://wallet-idx/graphql' });
  });

  it('compiled contract: missing build is down, a keyless build degraded, a full build ok', async () => {
    const zk = (files: string[]) => byId(createHealthProbes(cfg, connector({}), env((u) => (files.some((f) => u.endsWith(f)) ? json({}) : json({}, 404)))), 'zk-artifacts').run(signal());
    expect(await zk([])).toEqual({ status: 'down', detail: { code: 'not-compiled' } });
    expect(await zk(['contract-manifest.json'])).toEqual({ status: 'degraded', detail: { code: 'no-keys' } });
    expect(await zk(['contract-manifest.json', 'keys/configure.verifier'])).toEqual({ status: 'ok' });
  });

  it('CASP simulator: ok with its name, down with the proxy’s reason, down (own reason) when the proxy is off', async () => {
    const casp = (r: Response) => byId(createHealthProbes(cfg, connector({}), env((u) => (u === '/api/casp/health' ? r : json({}, 500)))), 'casp').run(signal());
    expect(await casp(json({ ok: true, casp: 'EU Test CASP', testOnly: true }))).toEqual({ status: 'ok', target: '/api/casp → EU Test CASP' });
    expect(await casp(json({ error: 'CASP simulator not reachable at http://127.0.0.1:8787 (fetch failed).' }, 502))).toMatchObject({
      status: 'down',
      detail: { code: 'http-error', info: 'HTTP 502: CASP simulator not reachable at http://127.0.0.1:8787 (fetch failed).' }
    });
    expect(await casp(json({ error: 'CASP simulator proxy is disabled in production' }, 404))).toEqual({ status: 'down', detail: { code: 'casp-disabled' } });
  });
});
