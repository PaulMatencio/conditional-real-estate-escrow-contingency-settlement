import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const midnight = JSON.parse(readFileSync(path.join(here, 'midnight.config.json'), 'utf8'));
const dev = process.env.NODE_ENV !== 'production';

/**
 * Content-Security-Policy. The page talks to: its own origin (incl. /zk circuit keys), the indexer (HTTP + WebSocket —
 * the wallet supplies these URIs, so the Midnight, 1AM and Blockfrost hosts are allowed as well as the configured ones) and the
 * LOCAL proof server. Anything else (exfiltration to an unknown host) is refused. Add hosts with
 * CSP_CONNECT_EXTRA="https://host wss://host"; set CSP_REPORT_ONLY=1 to log violations without blocking.
 * 'unsafe-inline' scripts remain because Next.js emits inline bootstrap scripts (a nonce would need dynamic rendering);
 * 'wasm-unsafe-eval' is required by the Midnight WASM runtime.
 */
function contentSecurityPolicy() {
  const origin = (u) => { try { return new URL(u).origin; } catch { return ''; } };
  const connect = new Set([
    "'self'",
    origin(midnight.indexer), origin(midnight.indexerWS), origin(midnight.nodeRpc), origin(midnight.proofServer),
    'http://127.0.0.1:6300', 'http://localhost:6300',
    'https://*.midnight.network', 'wss://*.midnight.network', 'https://*.1am.xyz', 'wss://*.1am.xyz',
    'https://*.blockfrost.io', 'wss://*.blockfrost.io', // Lace can report Blockfrost's Midnight service as its indexer
    ...(process.env.CSP_CONNECT_EXTRA ?? '').split(/\s+/).filter(Boolean)
  ]);
  if (dev) { connect.add('ws://localhost:*'); connect.add('ws://127.0.0.1:*'); } // Next.js hot reload
  const directives = {
    'default-src': ["'self'"],
    'script-src': ["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'", ...(dev ? ["'unsafe-eval'"] : [])],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:'],
    'font-src': ["'self'", 'data:'],
    'connect-src': [...connect].filter(Boolean),
    'worker-src': ["'self'", 'blob:'],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"]
  };
  return Object.entries(directives).map(([k, v]) => `${k} ${v.join(' ')}`).join('; ');
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Testing several parties in one browser: each http://<name>.localhost:3000 is its own origin, so its own vault
  // (and still a secure context, unlike a LAN IP). Lets the dev server serve its assets to those names.
  allowedDevOrigins: ['*.localhost'],
  poweredByHeader: false,
  // Midnight runtime packages ship WASM; enable async WebAssembly for the client bundle.
  webpack: (config, { isServer }) => {
    config.experiments = { ...config.experiments, asyncWebAssembly: true, layers: true, topLevelAwait: true };
    // Async WASM modules need async functions; every browser we target supports them.
    config.output.environment = { ...config.output.environment, asyncFunction: true };
    config.output.webassemblyModuleFilename = isServer ? '../static/wasm/[modulehash].wasm' : 'static/wasm/[modulehash].wasm';
    // The compiled contract lives in ./contract, which has its own node_modules. Resolve bare imports from the root
    // node_modules first so only one copy of the wasm runtime is loaded; two copies make wasm classes differ
    // ("expected instance of ContractMaintenanceAuthority").
    config.resolve.modules = [path.join(here, 'node_modules'), ...(config.resolve.modules ?? ['node_modules'])];
    if (!isServer) {
      config.resolve.alias = { ...config.resolve.alias, 'isomorphic-ws$': path.join(here, 'src/infrastructure/shims/isomorphic-ws.mjs') };
      config.resolve.fallback = { ...config.resolve.fallback, fs: false, path: false, crypto: false, os: false };
    }
    return config;
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: process.env.CSP_REPORT_ONLY === '1' ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy', value: contentSecurityPolicy() },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' }
        ]
      }
    ];
  }
};

export default nextConfig;
