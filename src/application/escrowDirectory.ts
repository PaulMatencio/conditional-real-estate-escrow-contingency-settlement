/**
 * The escrow directory: every escrow this browser's vault holds a record for, with its name, test case and the roles
 * held here. The vault is the registry: no server and nothing on-chain. Records are read only while the vault is
 * unlocked; the metadata is encrypted with the rest of the record.
 */
import { displayLabel, mergeImportedMeta, normalizeWireMeta, type DirectoryEntry, type EscrowMeta, type WireMeta } from '@/domain/escrowMeta';
import { testCase } from '@/domain/testCases';
import { ADMIN_RECORD, IDENTITY_RECORD, TXLOG_RECORD, type Vault, type VaultRecord } from './partyPorts';

const SPECIAL = new Set<string>([IDENTITY_RECORD, ADMIN_RECORD, TXLOG_RECORD]);

/** Roles held for one escrow: the role keys in its record, plus admin when this vault deployed it or holds its authority key. */
export function rolesOf(r: VaultRecord): string[] {
  const roles = new Set(Object.keys(r.roleKeys ?? {}));
  if (r.meta?.source === 'deployed' || r.authorityKey || r.authorityRenouncedAt) roles.add('admin');
  if (r.lenderTerms) roles.add('lender');
  if (r.custody) roles.add('custodian');
  return [...roles];
}

export function entryOf(address: string, r: VaultRecord): DirectoryEntry {
  return { address, meta: r.meta, roles: rolesOf(r), hasTerms: !!r.terms || !!r.custody };
}

/** Every escrow record in the vault (not the identity, admin-key or transaction-log records). */
export async function listDirectory(vault: Vault): Promise<DirectoryEntry[]> {
  if (!vault.unlocked) return [];
  const ids = (await vault.contracts()).filter((id) => !SPECIAL.has(id) && /^[0-9a-f]{64}$/.test(id));
  return Promise.all(ids.map(async (id) => entryOf(id, await vault.load(id))));
}

/** Writes a name/case/description, by the vault's owner (marks it renamed, so a later package import keeps it). */
export function renameMeta(current: EscrowMeta | undefined, wire: Partial<WireMeta>, now: number): EscrowMeta {
  const w = normalizeWireMeta(wire);
  if (!w) throw new Error('A name is required.');
  return { ...(current ?? { createdAt: now, source: 'manual' as const }), ...w, description: w.description, tags: w.tags, renamed: true };
}

/** The metadata a deployment starts with (admin deploy form, or a simulation). */
export function deployedMeta(wire: Partial<WireMeta>, network: string, now: number, decimals?: number): EscrowMeta {
  const w = normalizeWireMeta(wire);
  if (!w) throw new Error('A name is required.');
  return { ...w, network, createdAt: now, source: 'deployed', lastOpenedAt: now, ...(decimals !== undefined ? { decimals } : {}) };
}

/**
 * A record was saved: when it now holds a terms package, lender package or custodian copy carrying a name, adopt it
 * (unless renamed locally). Every import path goes through the vault, so this one rule covers them all.
 */
export function withPackageMeta(r: VaultRecord, now: number): VaultRecord {
  const incoming = r.terms?.meta ?? r.lenderTerms?.meta ?? r.custody?.terms.meta;
  if (!incoming) return r;
  const meta = mergeImportedMeta(r.meta, incoming, now);
  return meta === r.meta ? r : { ...r, meta };
}

/** "Copy test summary": what to paste into the test matrix row or a ticket. */
export function testSummary(address: string, r: VaultRecord, status: string | null, network: string): string {
  const m = r.meta;
  const c = testCase(m?.caseId);
  const lines = [
    `${m?.caseId ? `[${m.caseId}] ` : ''}${displayLabel(address, m)}`,
    `Contract: ${address}`,
    `Network: ${m?.network ?? network}`,
    `Status: ${status ?? m?.lastStatus ?? 'unknown'}`
  ];
  if (m?.description) lines.push(`Description: ${m.description}`);
  if (c) lines.push(`Expected: ${c.expected}`);
  const hist = r.history ?? [];
  if (hist.length) {
    lines.push('Transactions (this browser):');
    for (const h of hist) lines.push(`- ${new Date(h.at).toISOString()} ${h.circuit}${h.role ? ` (${h.role})` : ''} ${h.status} ${h.txHash}`);
  }
  return lines.join('\n');
}
