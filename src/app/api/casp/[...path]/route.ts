/**
 * Same-origin proxy to the eu-counterparty-simulator CASP REST server (TEST ONLY).
 *
 * Why a proxy: the simulator sends no CORS headers, and its officer / notary bearer tokens must not reach the
 * browser. The route forwards an allow-listed set of paths to CASP_SIM_URL (default http://127.0.0.1:8787) and
 * attaches CASP_OFFICER_TOKEN / CASP_NOTARY_TOKEN server-side for the routes that need them.
 *
 * Disabled in production builds unless CASP_SIM_ENABLED=1: a real CASP integration would go through the CASP's own
 * authenticated API, not a simulator.
 */
import { NextResponse, type NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

const BASE = (process.env.CASP_SIM_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const enabled = () => process.env.NODE_ENV !== 'production' || process.env.CASP_SIM_ENABLED === '1';

type Auth = 'none' | 'officer' | 'notary';
const SEG = '[^/]+';
const ROUTES: { method: string; pattern: RegExp; auth: Auth }[] = [
  { method: 'GET', pattern: /^health$/, auth: 'none' },
  { method: 'GET', pattern: /^\.well-known\/casp-keys$/, auth: 'none' },
  { method: 'POST', pattern: new RegExp(`^test/personas/${SEG}/attestation$`), auth: 'none' },
  { method: 'POST', pattern: /^customers$/, auth: 'none' },
  { method: 'POST', pattern: new RegExp(`^customers/${SEG}/(wallet-challenge|wallet-proof|attestations)$`), auth: 'none' },
  { method: 'POST', pattern: new RegExp(`^attestations/${SEG}/revoke$`), auth: 'officer' },
  { method: 'POST', pattern: new RegExp(`^issuer/keys/${SEG}/revoke$`), auth: 'officer' },
  { method: 'GET', pattern: new RegExp(`^attestations/${SEG}$`), auth: 'notary' },
  { method: 'GET', pattern: new RegExp(`^travel-rule/${SEG}$`), auth: 'notary' }
];

function token(auth: Auth): string | undefined {
  if (auth === 'officer') return process.env.CASP_OFFICER_TOKEN;
  if (auth === 'notary') return process.env.CASP_NOTARY_TOKEN ?? process.env.CASP_OFFICER_TOKEN;
  return undefined;
}

async function forward(req: NextRequest, path: string[]): Promise<NextResponse> {
  if (!enabled()) return NextResponse.json({ error: 'CASP simulator proxy is disabled in production (set CASP_SIM_ENABLED=1).' }, { status: 404 });
  const rel = path.map(encodeURIComponent).join('/').replace(/%2F/gi, '/');
  const route = ROUTES.find((r) => r.method === req.method && r.pattern.test(path.join('/')));
  if (!route) return NextResponse.json({ error: `not allowed: ${req.method} /${rel}` }, { status: 404 });
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const tok = token(route.auth);
  if (route.auth !== 'none') {
    if (!tok) return NextResponse.json({ error: `Set CASP_${route.auth === 'officer' ? 'OFFICER' : 'NOTARY'}_TOKEN in .env.local (printed by the simulator at start).` }, { status: 401 });
    headers.authorization = `Bearer ${tok}`;
  }
  try {
    const res = await fetch(`${BASE}/${rel}`, {
      method: req.method,
      headers,
      body: req.method === 'GET' ? undefined : await req.text(),
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000)
    });
    const body = await res.text();
    return new NextResponse(body, { status: res.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  } catch (e) {
    return NextResponse.json({ error: `CASP simulator not reachable at ${BASE} (${(e as Error).message}). Start it with "npm run start-server" in eu-counterparty-simulator.` }, { status: 502 });
  }
}

type Ctx = { params: Promise<{ path: string[] }> };
export async function GET(req: NextRequest, ctx: Ctx) {
  return forward(req, (await ctx.params).path);
}
export async function POST(req: NextRequest, ctx: Ctx) {
  return forward(req, (await ctx.params).path);
}
