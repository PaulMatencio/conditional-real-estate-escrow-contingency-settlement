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

/** Tokens to try, in order: a notary route accepts the notary or the officer token (the simulator allows both). */
function tokens(auth: Auth): string[] {
  const all = auth === 'notary' ? [process.env.CASP_NOTARY_TOKEN, process.env.CASP_OFFICER_TOKEN] : [token(auth)];
  return [...new Set(all.filter((t): t is string => !!t))];
}

/**
 * The simulator answered 401 to every token in .env.local: they do not match the running simulator, which makes new
 * random tokens at each start unless CASP_OFFICER_TOKEN / CASP_NOTARY_TOKEN are set in its own environment. Token
 * values are never echoed.
 */
const STALE_TOKEN =
  'the simulator refused the token in .env.local. It makes new tokens at each start: copy the officer and notary tokens it printed into .env.local (CASP_OFFICER_TOKEN, CASP_NOTARY_TOKEN) and restart the dApp, or start the simulator with the same tokens set in its environment.';

async function forward(req: NextRequest, path: string[]): Promise<NextResponse> {
  if (!enabled()) return NextResponse.json({ error: 'CASP simulator proxy is disabled in production (set CASP_SIM_ENABLED=1).' }, { status: 404 });
  const rel = path.map(encodeURIComponent).join('/').replace(/%2F/gi, '/');
  const route = ROUTES.find((r) => r.method === req.method && r.pattern.test(path.join('/')));
  if (!route) return NextResponse.json({ error: `not allowed: ${req.method} /${rel}` }, { status: 404 });
  const candidates = route.auth === 'none' ? [undefined] : tokens(route.auth);
  if (candidates.length === 0) return NextResponse.json({ error: `Set CASP_${route.auth === 'officer' ? 'OFFICER' : 'NOTARY'}_TOKEN in .env.local (printed by the simulator at start).` }, { status: 401 });
  const body = req.method === 'GET' ? undefined : await req.text();
  try {
    let res: Response | null = null;
    for (const tok of candidates) {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (tok) headers.authorization = `Bearer ${tok}`;
      res = await fetch(`${BASE}/${rel}`, { method: req.method, headers, body, cache: 'no-store', signal: AbortSignal.timeout(15_000) });
      if (res.status !== 401) break;
    }
    if (route.auth !== 'none' && res!.status === 401) return NextResponse.json({ error: STALE_TOKEN }, { status: 401 });
    const text = await res!.text();
    return new NextResponse(text, { status: res!.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
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
