import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { NextResponse, type NextRequest } from 'next/server';
import { contractConfig } from '@/infrastructure/config/network';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Only the ZK artefacts midnight-js 5's FetchZkConfigProvider requests: keys/*.{prover,verifier}, zkir/*.bzkir, and
 * the compiler's integrity manifest / contract info (compiler/contract-manifest.json, compiler/contract-info.json),
 * from which it checks every artefact's hash and reads the runtime version (ledger era) the contract was built for.
 */
/** Compiler output of every supported contract version, by the name it is served under (/zk/<name>/...). */
const MANAGED_DIRS = new Map<string, string>([
  [contractConfig.name, contractConfig.managedDir],
  ...(contractConfig.previousVersions ?? []).map((v) => [v.name, v.managedDir] as [string, string])
]);

const ALLOWED = /^(keys\/[A-Za-z0-9_]+\.(prover|verifier)|zkir\/[A-Za-z0-9_]+\.bzkir|compiler\/contract-(manifest|info)\.json)$/;

/**
 * A key the compiled contract does not have was asked for: the requesting page runs code built against another
 * compile (opened before the last `compact compile`, or served by a dev server started before it). Say which page,
 * once per page and artefact, so the server log points at the tab to reload (CLAUDE.md "Contract updates must not
 * break the dApp").
 */
const reported = new Set<string>();
function reportStale(req: NextRequest, rel: string) {
  const from = req.headers.get('referer') ?? req.headers.get('origin') ?? 'an unknown page';
  const k = `${from}|${rel}`;
  if (reported.has(k)) return;
  reported.add(k);
  console.warn(`[zk] ${rel} is not in the compiled contract; requested by ${from}. That page runs code from before the last contract compile: reload it (and restart the dev server if it predates the compile).`);
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path: parts } = await ctx.params;
  // parts[0] is the contract version's name (current: contract.name; earlier supported versions: previousVersions).
  const managedDir = MANAGED_DIRS.get(parts[0]);
  if (!managedDir) return new NextResponse('Not found', { status: 404 });
  const rel = parts.slice(1).join('/');
  if (!ALLOWED.test(rel)) return new NextResponse('Not found', { status: 404 });
  const file = path.resolve(process.cwd(), managedDir, rel);
  try {
    const st = statSync(file);
    const stream = Readable.toWeb(createReadStream(file)) as ReadableStream;
    return new NextResponse(stream, {
      headers: {
        'content-type': rel.endsWith('.json') ? 'application/json' : 'application/octet-stream',
        'content-length': String(st.size),
        'cache-control': 'public, max-age=3600',
        'access-control-allow-origin': '*'
      }
    });
  } catch {
    if (rel.startsWith('keys/') || rel.startsWith('zkir/')) reportStale(req, rel);
    return new NextResponse('Not found', { status: 404 });
  }
}
