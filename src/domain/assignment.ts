/**
 * Assignment notice: tells an attestor (inspector, title agent, dispute resolver) which escrow it is assigned to.
 * Everything in it is public on-chain except the escrow's name, so the file is always sealed (to the attestor's
 * envelope key); the link variant carries the address and the role only. Pure: no crypto, no I/O.
 */
import type { WireMeta } from './escrowMeta';
import { ROLE_SLUG } from './roles';

export const ATTESTOR_ROLES = ['inspector', 'titleAgent', 'resolver'] as const;
export type AttestorRole = (typeof ATTESTOR_ROLES)[number];

export interface AssignmentNotice {
  format: 'EscrowAssignmentV1';
  contractAddress: string;
  role: AttestorRole;
  /** The role id the escrow expects for this role (public on-chain); the attestor's key must derive it. */
  roleId: string;
  network: string;
  /** Unix seconds, as decimal strings (JSON has no bigint). */
  closingDeadline: string;
  disputeDeadline: string;
  /** When the admin produced the notice (ms). */
  issuedAt: number;
  /** The escrow's name, test case and description, so the attestor's vault shows the same label. */
  meta?: WireMeta;
}

const HEX64 = /^[0-9a-f]{64}$/;
const DIGITS = /^\d+$/;

export const isAttestorRole = (r: unknown): r is AttestorRole => typeof r === 'string' && (ATTESTOR_ROLES as readonly string[]).includes(r);

export function isAssignment(x: unknown): x is AssignmentNotice {
  const a = x as AssignmentNotice | null;
  return (
    !!a &&
    a.format === 'EscrowAssignmentV1' &&
    typeof a.contractAddress === 'string' &&
    HEX64.test(a.contractAddress) &&
    isAttestorRole(a.role) &&
    typeof a.roleId === 'string' &&
    HEX64.test(a.roleId) &&
    typeof a.network === 'string' &&
    typeof a.closingDeadline === 'string' &&
    DIGITS.test(a.closingDeadline) &&
    typeof a.disputeDeadline === 'string' &&
    DIGITS.test(a.disputeDeadline) &&
    typeof a.issuedAt === 'number'
  );
}

export function createAssignment(i: {
  contractAddress: string;
  role: AttestorRole;
  roleId: string;
  network: string;
  closingDeadline: bigint;
  disputeDeadline: bigint;
  issuedAt: number;
  meta?: WireMeta;
}): AssignmentNotice {
  const contractAddress = i.contractAddress.toLowerCase().replace(/^0x/, '');
  const roleId = i.roleId.toLowerCase().replace(/^0x/, '');
  if (!HEX64.test(contractAddress)) throw new Error('Contract address must be 64 hex characters.');
  if (!HEX64.test(roleId)) throw new Error(`The ${i.role} role id is not set on this escrow.`);
  return {
    format: 'EscrowAssignmentV1',
    contractAddress,
    role: i.role,
    roleId,
    network: i.network,
    closingDeadline: String(i.closingDeadline),
    disputeDeadline: String(i.disputeDeadline),
    issuedAt: i.issuedAt,
    ...(i.meta ? { meta: i.meta } : {})
  };
}

/** Link to the attestor's own page with the escrow preselected. Address and role only: both are public. */
export const assignmentLink = (origin: string, contractAddress: string, role: AttestorRole): string =>
  `${origin.replace(/\/$/, '')}/${ROLE_SLUG[role]}?escrow=${contractAddress.toLowerCase()}`;

/** The escrow address in a page URL's query (`?escrow=<64 hex>`), or null. */
export function escrowFromQuery(search: string): string | null {
  const v = new URLSearchParams(search).get('escrow')?.trim().toLowerCase().replace(/^0x/, '') ?? '';
  return HEX64.test(v) ? v : null;
}
