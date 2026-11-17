/**
 * Contract-version compatibility (CLAUDE.md "Contract updates must not break the dApp" and "Backward compatibility
 * after a contract upgrade").
 *
 * Every path that opens or reads an escrow goes through here first: it resolves the escrow's contract version among
 * the supported ones (versions.ts), so the caller decodes, calls and proves with that version. An escrow of no
 * supported version stops with ONE clear `CONTRACT_VERSION` error before any midnight-js call, proof or ZK artefact
 * fetch: never a bare 404 or a misread ledger.
 */
import { AppError } from '@/domain/errors';
import type { EscrowView } from '@/domain/escrowView';
import { allCircuitIds } from './compiled';
import { CURRENT_VERSION, circuitsOf, detectVersion, knownCircuits, type ContractVersion } from './versions';

/** Marker carried by every compatibility error, so the UI can tell it from other failures. */
export const OLDER_CONTRACT = 'older-contract' as const;
export const STALE_BUNDLE = 'stale-bundle' as const;

export class ContractVersionError extends AppError {
  constructor(
    message: string,
    readonly kind: typeof OLDER_CONTRACT | typeof STALE_BUNDLE,
    readonly circuits: string[] = [],
    options?: { cause?: unknown }
  ) {
    super('CONTRACT_VERSION', message, options);
    this.name = 'ContractVersionError';
  }
}

/** True for any "this escrow / this bundle does not match the compiled contract" error, also when wrapped. */
export function isContractVersionError(e: unknown, depth = 0): boolean {
  if (depth > 6 || !e || typeof e !== 'object') return false;
  if (e instanceof AppError && e.code === 'CONTRACT_VERSION') return true;
  return isContractVersionError((e as { cause?: unknown }).cause, depth + 1);
}

const short = (address: string) => `${address.replace(/^0x/, '').slice(0, 10)}…`;

/** The error shown for an escrow deployed by another build of the contract. */
export function olderContractError(address: string, circuits: string[], detail?: string, cause?: unknown): ContractVersionError {
  const what = circuits.length ? ` (circuits unknown to this build: ${circuits.join(', ')})` : detail ? ` (${detail})` : '';
  return new ContractVersionError(
    `Escrow ${short(address)} was deployed with a contract version this dApp no longer supports${what}. Archive it in the escrow switcher and use an escrow deployed with a supported contract. Its vault record, keys and terms stay in the vault.`,
    OLDER_CONTRACT,
    circuits,
    cause === undefined ? undefined : { cause }
  );
}

/** On-chain circuits no supported version knows (default: any supported version's circuits count as known). */
export function foreignCircuitsOf(onChain: Iterable<string>, build: readonly string[] = knownCircuits()): string[] {
  return [...onChain].filter((c) => !build.includes(c)).sort();
}

/**
 * The supported contract version of an escrow, from its on-chain circuits (and the version recorded in the vault at
 * deploy, `hint`). Throws the clear `CONTRACT_VERSION` error when no supported version fits.
 */
export function resolveVersion(address: string, onChain: Iterable<string>, hint?: string | null): ContractVersion {
  const ops = [...onChain];
  const v = detectVersion(ops, hint);
  if (v) return v;
  const foreign = foreignCircuitsOf(ops);
  throw olderContractError(address, foreign.length ? foreign : foreignCircuitsOf(ops, circuitsOf(CURRENT_VERSION)));
}

/** Throws when the escrow's circuits fit no supported version (kept for callers that only need the check). */
export function assertCompatible(address: string, onChain: Iterable<string>): void {
  resolveVersion(address, onChain);
}

/**
 * Resolves the version, then decodes the ledger with it. A ledger that does not decode with that version's layout is
 * reported as an unsupported version too, never shown half-read.
 */
export function decodeCompatible(address: string, onChain: Iterable<string>, decode: (v: ContractVersion) => EscrowView, hint?: string | null): EscrowView {
  const v = resolveVersion(address, onChain, hint);
  try {
    return decode(v);
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw olderContractError(address, [], 'its ledger layout differs from this build', e);
  }
}

/** Proof circuits listed in a compiler `contract-info.json` (the server's copy, read by the /zk route). */
export function proofCircuitsOf(info: unknown): string[] | null {
  const circuits = (info as { circuits?: { name?: unknown; proof?: unknown }[] } | null)?.circuits;
  if (!Array.isArray(circuits)) return null;
  return circuits.filter((c) => c.proof === true && typeof c.name === 'string').map((c) => c.name as string).sort();
}

/** Circuits the server's compiled contract has and this bundle lacks (added), and the reverse (removed). */
export function bundleDrift(serverCircuits: readonly string[], build: readonly string[] = allCircuitIds()): { added: string[]; removed: string[] } {
  return {
    added: serverCircuits.filter((c) => !build.includes(c)).sort(),
    removed: build.filter((c) => !serverCircuits.includes(c)).sort()
  };
}

export const driftText = (d: { added: string[]; removed: string[] }) =>
  [...d.added.map((c) => `+${c}`), ...d.removed.map((c) => `−${c}`)].join(', ');

/** The error for a page running code compiled against another contract build than the one the server serves. */
export function staleBundleError(circuits: string[], cause?: unknown): ContractVersionError {
  return new ContractVersionError(
    `This page runs code built for another version of the contract than the one the dApp server serves (${circuits.join(', ')}). Restart the dApp (npm run dev, or npm run build && npm start) and reload the page.`,
    STALE_BUNDLE,
    circuits,
    cause === undefined ? undefined : { cause }
  );
}

const fingerprints = new Map<string, Promise<string>>();

/**
 * Identifies a contract build: SHA-256 (first 16 hex) of the compiler's circuit and ledger description. Stored with
 * each escrow at deploy (`EscrowMeta.build`, with `EscrowMeta.contractVersion`), so a version can be told from
 * "wrong network" without reading the chain.
 */
export function buildFingerprint(version: ContractVersion = CURRENT_VERSION): Promise<string> {
  let f = fingerprints.get(version.id);
  if (!f) {
    f = (async () => {
      const info = version.info as { circuits?: unknown; ledger?: unknown };
      const text = JSON.stringify({ circuits: info.circuits, ledger: info.ledger });
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
    })();
    fingerprints.set(version.id, f);
  }
  return f;
}
