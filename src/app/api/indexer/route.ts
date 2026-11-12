/**
 * Same-origin proxy for the indexer's GraphQL HTTP endpoint (queries only; subscriptions stay on the direct wss URL).
 *
 * Why: the browser calls the indexer cross-origin. When the indexer or its gateway answers with an error page (rate
 * limit, 5xx, restart) that response carries no CORS headers, so the browser reports a misleading "blocked by CORS
 * policy" and the real status is lost. Going through this route keeps the request same-origin and surfaces the real
 * status. Public data only: the route forwards nothing but the GraphQL body, adds no credentials, and only ever talks
 * to the indexer configured in midnight.config.json.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { networkConfig } from '@/infrastructure/config/network';

export const dynamic = 'force-dynamic';

const MAX_BODY = 64 * 1024;

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!(req.headers.get('content-type') ?? '').includes('application/json')) return NextResponse.json({ errors: [{ message: 'JSON only' }] }, { status: 415 });
  const body = await req.text();
  if (body.length > MAX_BODY) return NextResponse.json({ errors: [{ message: 'Query too large' }] }, { status: 413 });
  try {
    const parsed = JSON.parse(body) as { query?: unknown };
    if (typeof parsed.query !== 'string' || /^\s*(mutation|subscription)\b/.test(parsed.query)) return NextResponse.json({ errors: [{ message: 'Queries only' }] }, { status: 400 });
  } catch {
    return NextResponse.json({ errors: [{ message: 'Invalid JSON' }] }, { status: 400 });
  }
  try {
    const res = await fetch(networkConfig.indexer, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: req.headers.get('accept') ?? 'application/json' },
      body,
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000)
    });
    const text = await res.text();
    return new NextResponse(text, { status: res.status, headers: { 'content-type': res.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' } });
  } catch (e) {
    return NextResponse.json({ errors: [{ message: `Indexer not reachable (${(e as Error).message})` }] }, { status: 502 });
  }
}
