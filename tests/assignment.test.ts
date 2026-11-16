import { describe, expect, it } from 'vitest';
import { entryOf, withPackageMeta } from '@/application/escrowDirectory';
import { assignmentLink, createAssignment, escrowFromQuery, isAssignment } from '@/domain/assignment';
import { generateRecipientKeyPair, openEnvelope, sealTo } from '@/infrastructure/crypto/aead';

const ADDR = 'ab'.repeat(32);
const ROLE_ID = 'cd'.repeat(32);
const base = { contractAddress: ADDR, role: 'inspector' as const, roleId: ROLE_ID, network: 'preview', closingDeadline: 1800000000n, disputeDeadline: 1800600000n, issuedAt: 1 };

describe('assignment notice', () => {
  it('is created from the on-chain role id and deadlines, and validated on import', () => {
    const n = createAssignment({ ...base, contractAddress: `0x${ADDR.toUpperCase()}`, meta: { label: 'Rue de la Paix 12' } });
    expect(n).toMatchObject({ format: 'EscrowAssignmentV1', contractAddress: ADDR, role: 'inspector', roleId: ROLE_ID, closingDeadline: '1800000000', disputeDeadline: '1800600000' });
    expect(isAssignment(n)).toBe(true);
    expect(isAssignment({ ...n, role: 'buyer' })).toBe(false);
    expect(isAssignment({ ...n, contractAddress: 'xyz' })).toBe(false);
    expect(isAssignment({ ...n, closingDeadline: '-1' })).toBe(false);
  });

  it('refuses a role that is not set on the escrow', () => {
    expect(() => createAssignment({ ...base, roleId: '' })).toThrow(/not set/);
  });

  it('the link carries the address and role page only; the query is parsed back strictly', () => {
    const link = assignmentLink('http://localhost:3000/', ADDR, 'titleAgent');
    expect(link).toBe(`http://localhost:3000/title-agent?escrow=${ADDR}`);
    expect(escrowFromQuery(new URL(link).search)).toBe(ADDR);
    expect(escrowFromQuery('?escrow=123')).toBeNull();
    expect(escrowFromQuery('')).toBeNull();
  });

  it('round-trips sealed to the attestor’s envelope key', async () => {
    const me = await generateRecipientKeyPair();
    const n = createAssignment({ ...base, meta: { label: 'Villa' } });
    expect(await openEnvelope(await sealTo(n, me.publicKey, 'inspector'), me)).toEqual(n);
  });

  it('names the escrow in the attestor’s vault and lists the role in the directory', () => {
    const n = createAssignment({ ...base, meta: { label: 'Villa' } });
    const r = withPackageMeta({ assignment: n }, 5);
    expect(r.meta?.label).toBe('Villa');
    expect(entryOf(ADDR, r).roles).toContain('inspector');
  });
});
