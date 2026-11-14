/** Escrow directory: names in the vault, propagated through packages, run labels, search, test summary, presets. */
import { describe, expect, it } from 'vitest';
import { deployedMeta, entryOf, listDirectory, renameMeta, testSummary, withPackageMeta } from '@/application/escrowDirectory';
import { ADMIN_RECORD, IDENTITY_RECORD, TXLOG_RECORD, type Vault, type VaultRecord } from '@/application/partyPorts';
import { createTermsPackage, lenderPackageOf } from '@/application/termsService';
import { mergeRecord } from '@/application/vaultBackup';
import { displayLabel, matchesSearch, mergeImportedMeta, normalizeWireMeta, runLabels, sortEntries } from '@/domain/escrowMeta';
import { TEST_CASES, metaForCase, presetValues, testCase, testMatrixMarkdown } from '@/domain/testCases';
import { termsCrypto } from '@/infrastructure/crypto/termsCrypto';
import { BUYER_KEY, LENDER_KEY, SELLER_KEY, hex } from './helpers/fixtures';

const A = hex(0xa1);
const B = hex(0xb2);
const C = hex(0xc3);

function memoryVault(records: Record<string, VaultRecord>): Vault {
  const m = new Map(Object.entries(records));
  return {
    unlocked: true,
    unlock: async () => {},
    lock: () => {},
    load: async (id) => m.get(id) ?? {},
    save: async (id, r) => void m.set(id, r),
    erase: async (id) => void m.delete(id),
    contracts: async () => [...m.keys()]
  };
}

describe('metadata', () => {
  it('normalizes input: trims, caps, upper-cases the case ID, dedups tags, needs a label', () => {
    expect(normalizeWireMeta({ label: '  T07 run ', caseId: ' t07 ', tags: ['Loan', 'loan', ' cooling-off '] })).toEqual({ label: 'T07 run', caseId: 'T07', description: undefined, tags: ['loan', 'cooling-off'] });
    expect(normalizeWireMeta({ label: '   ' })).toBeNull();
    expect(normalizeWireMeta({ label: 'x'.repeat(200) })!.label).toHaveLength(80);
    expect(displayLabel(A)).toBe(`Unnamed escrow ${A.slice(0, 4)}…${A.slice(-4)}`);
  });

  it('adopts a package name unless the vault owner renamed the escrow', () => {
    const imported = mergeImportedMeta(undefined, { label: 'Cash deal', caseId: 'T01' }, 5);
    expect(imported).toMatchObject({ label: 'Cash deal', caseId: 'T01', source: 'package', createdAt: 5 });
    const renamed = renameMeta(imported, { label: 'My name' }, 6);
    expect(renamed).toMatchObject({ label: 'My name', renamed: true, createdAt: 5 });
    expect(mergeImportedMeta(renamed, { label: 'Admin name' }, 7)).toBe(renamed);
    expect(() => renameMeta(undefined, { label: '' }, 1)).toThrow(/name is required/);
  });

  it('numbers repeated runs of the same case, searches and sorts', () => {
    const e = [
      { address: A, meta: { ...deployedMeta({ label: 'first', caseId: 'T07', tags: ['cooling-off'] }, 'preview', 1), lastOpenedAt: 10 }, roles: ['admin'], hasTerms: true },
      { address: B, meta: { ...deployedMeta({ label: 'second', caseId: 'T07' }, 'preview', 2), lastOpenedAt: 30 }, roles: ['buyer'], hasTerms: true },
      { address: C, meta: undefined, roles: [], hasTerms: false }
    ];
    expect(runLabels(e)).toEqual({ [A]: 'T07 · run 1', [B]: 'T07 · run 2' });
    expect(e.filter((x) => matchesSearch(x, 'cooling')).map((x) => x.address)).toEqual([A]);
    expect(e.filter((x) => matchesSearch(x, C.slice(0, 6))).map((x) => x.address)).toEqual([C]);
    expect([...e].sort(sortEntries).map((x) => x.address)).toEqual([B, A, C]);
  });
});

describe('directory', () => {
  it('lists escrow records only, with the roles held here', async () => {
    const v = memoryVault({
      [A]: { meta: deployedMeta({ label: 'Mine' }, 'preview', 1) },
      [B]: { roleKeys: { buyer: hex(1), seller: hex(2) } },
      [IDENTITY_RECORD]: {},
      [ADMIN_RECORD]: {},
      [TXLOG_RECORD]: {}
    });
    const d = await listDirectory(v);
    expect(d.map((e) => e.address).sort()).toEqual([A, B].sort());
    expect(d.find((e) => e.address === A)!.roles).toEqual(['admin']);
    expect(d.find((e) => e.address === B)!.roles.sort()).toEqual(['buyer', 'seller']);
    expect(entryOf(C, { lenderTerms: {} as never }).roles).toEqual(['lender']);
  });

  it('names an escrow from the terms package, the lender package or a custodian copy', () => {
    const pkg = { ...createTermsPackage(termsCrypto, { price: '250000', buyerDeposit: '100000', buyerPayout: BUYER_KEY, sellerPayout: SELLER_KEY, lenderPayout: LENDER_KEY, mode: 'deposited' }), meta: metaForCase(testCase('T02')!) };
    expect(withPackageMeta({ terms: pkg }, 9).meta).toMatchObject({ label: 'Loan funded, release two coins', caseId: 'T02', source: 'package' });
    const lp = lenderPackageOf(pkg);
    expect(lp.meta?.caseId).toBe('T02');
    expect(withPackageMeta({ lenderTerms: lp }, 9).meta?.caseId).toBe('T02');
    expect(withPackageMeta({ custody: { terms: pkg, receivedAt: 1 } }, 9).meta?.caseId).toBe('T02');
    const r: VaultRecord = { terms: { ...pkg, meta: undefined } };
    expect(withPackageMeta(r, 9)).toBe(r);
  });

  it('keeps the local name on a vault restore and fills a missing one', () => {
    const local = deployedMeta({ label: 'Local' }, 'preview', 1);
    const other = deployedMeta({ label: 'Backup' }, 'preview', 1);
    expect(mergeRecord({ meta: local }, { meta: other }, A).record.meta?.label).toBe('Local');
    expect(mergeRecord({ meta: local }, { meta: other }, A).conflicts.join()).toMatch(/name differs/);
    expect(mergeRecord({}, { meta: other }, A).record.meta?.label).toBe('Backup');
  });

  it('writes a test summary with the expected outcome and the transactions', () => {
    const r: VaultRecord = {
      meta: deployedMeta({ ...metaForCase(testCase('T07')!) }, 'preview', 1),
      history: [{ at: 0, circuit: 'buyerWithdraw', txHash: 'abc', status: 'confirmed', role: 'buyer' }]
    };
    const s = testSummary(A, r, 'Withdrawn', 'preview');
    expect(s).toContain('[T07] Cooling-off 1.5 %, withdraw inside');
    expect(s).toContain(`Contract: ${A}`);
    expect(s).toContain('Status: Withdrawn');
    expect(s).toContain('Expected: Closed: 246250 to the buyer, 3750 to the seller');
    expect(s).toContain('buyerWithdraw (buyer) confirmed abc');
  });
});

describe('test matrix and presets', () => {
  it('has unique case IDs and exports one Markdown row per case', () => {
    expect(new Set(TEST_CASES.map((c) => c.id)).size).toBe(TEST_CASES.length);
    const md = testMatrixMarkdown().split('\n');
    expect(md).toHaveLength(TEST_CASES.length + 2);
    expect(md[2]).toMatch(/^\| T01 \| Cash deal, happy path \| cash \|/);
  });

  it('turns a preset into valid terms whose numbers match the expected outcome', () => {
    for (const c of TEST_CASES) {
      const v = presetValues(c, 1_000_000);
      const rate = Math.round(Number(v.penaltyPct) * 100).toString();
      const pkg = createTermsPackage(termsCrypto, {
        price: v.price,
        buyerDeposit: v.deposit,
        buyerPayout: BUYER_KEY,
        sellerPayout: SELLER_KEY,
        lenderPayout: v.mode === 'deposited' ? LENDER_KEY : undefined,
        refundOnLoss: v.refundOnLoss,
        penaltyRate: rate,
        coolingOff: v.coolingOffDays > 0,
        mode: v.mode
      });
      expect(v.closingDeadline < v.disputeDeadline).toBe(true);
      if (v.mode === 'deposited') expect(v.loanOfferExpiry <= v.closingDeadline).toBe(true);
      if (c.id === 'T07') expect([pkg.terms.penalty, BigInt(pkg.terms.amount) - BigInt(pkg.terms.penalty)].map(String)).toEqual(['3750', '246250']);
      if (c.id === 'T02') expect([pkg.terms.amount, pkg.terms.lenderShare]).toEqual(['100000', '150000']);
    }
  });
});

describe('token amounts (whole tokens on screen, base units in the terms)', () => {
  it('formats exactly, with at least two decimals and no rounding', async () => {
    const { formatAmount, parseAmount, toBase, decimalsOf } = await import('@/domain/amount');
    expect(formatAmount(250_000_000_000n, 6, 'sEUR')).toBe('250,000.00 sEUR');
    expect(formatAmount('259999750000', 6, 'sEUR')).toBe('259,999.75 sEUR');
    expect(formatAmount(250_000n, 6)).toBe('0.25');
    expect(formatAmount(3_750n, 6)).toBe('0.00375');
    expect(formatAmount(5n, 0)).toBe('5');
    expect(parseAmount('250000', 6)).toBe(250_000_000_000n);
    expect(parseAmount('250,000.5', 6)).toBe(250_000_500_000n);
    expect(parseAmount('250 000,50', 6)).toBe(250_000_500_000n);
    expect(parseAmount('1.1234567', 6)).toBeNull();
    // European grouping (review finding): the last separator is the decimal mark.
    expect(parseAmount('250.000,50', 6)).toBe(250_000_500_000n);
    expect(parseAmount('1.000,5', 6)).toBe(1_000_500_000n);
    expect(parseAmount('250.000.000', 6)).toBe(250_000_000_000_000n);
    expect(parseAmount('250,000', 6)).toBe(250_000_000_000n);
    expect(parseAmount('1,5', 6)).toBe(1_500_000n);
    expect(parseAmount('0.25', 6)).toBe(250_000n);
    expect(parseAmount('25,00,000', 6)).toBeNull();
    expect(parseAmount('1,2.5', 6)).toBeNull();
    expect(parseAmount('-1', 6)).toBeNull();
    expect(toBase('246250')).toBe(246_250_000_000n);
    expect(decimalsOf(undefined, 19, 8)).toBe(8);
    expect(decimalsOf()).toBe(6);
  });
});
