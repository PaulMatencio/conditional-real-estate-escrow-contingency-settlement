import type { EscrowView } from './escrowView';

/** The seven on-chain roles plus the permissionless caller ("anyone", e.g. a keeper or CASP broadcaster). */
export const PARTY_ROLES = ['buyer', 'seller', 'inspector', 'lender', 'titleAgent', 'resolver', 'admin'] as const;
export type PartyRole = (typeof PARTY_ROLES)[number];
export type Caller = PartyRole | 'anyone';

/** URL slug of each role page. */
export const ROLE_SLUG: Record<Exclude<PartyRole, 'admin'>, string> = {
  buyer: 'buyer',
  seller: 'seller',
  inspector: 'inspector',
  lender: 'lender',
  titleAgent: 'title-agent',
  resolver: 'resolver'
};

export const roleFromSlug = (slug: string): Exclude<PartyRole, 'admin'> | null =>
  (Object.entries(ROLE_SLUG).find(([, s]) => s === slug)?.[0] as Exclude<PartyRole, 'admin'> | undefined) ?? null;

/**
 * FR-WALLET-03: every role a role id holds in this escrow. One key may legitimately hold several
 * (e.g. a cash buyer who is also the "lender"), hence a list and the multi-role switcher.
 */
export function rolesOf(view: Pick<EscrowView, 'roles'>, roleIdHex: string): PartyRole[] {
  const id = roleIdHex.toLowerCase();
  return PARTY_ROLES.filter((r) => view.roles[r] !== null && view.roles[r]?.toLowerCase() === id);
}
