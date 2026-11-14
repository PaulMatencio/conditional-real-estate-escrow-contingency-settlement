/**
 * The test matrix: one row per scenario the v2 escrow must handle. A deployment picks a case ID at deploy time; the
 * preset then pre-fills the Initialize deadlines, the Financing card and the terms form (the admin still reviews and
 * commits every value), and the switcher's "Copy test summary" quotes the expected outcome next to what happened.
 */
import type { WireMeta } from './escrowMeta';

export interface TestCasePreset {
  /** Total price in WHOLE tokens (the terms form converts to base units with the escrow's decimals). */
  price: string;
  /** Loan deals: buyer deposit as a percentage of the price (the rest is the loan). Cash deals: absent. */
  depositPct?: number;
  refundOnLoss?: boolean;
  /** Days from now. */
  closingDays: number;
  disputeDays: number;
  offerExpiryDays?: number;
  topUpDays?: number;
  coolingOffDays: number;
  /** Cooling-off penalty, % of the price (two decimals at most). */
  penaltyPct: number;
}

export interface TestCase {
  id: string;
  label: string;
  tags: string[];
  /** The steps to run, in order. */
  steps: string;
  /** Final status and payouts the run must end with. */
  expected: string;
  preset: TestCasePreset;
}

const CASH = { price: '250000', closingDays: 30, disputeDays: 45, coolingOffDays: 0, penaltyPct: 0 };
const LOAN = { ...CASH, depositPct: 40, refundOnLoss: true, offerExpiryDays: 20, topUpDays: 7 };

export const TEST_CASES: readonly TestCase[] = [
  {
    id: 'T01',
    label: 'Cash deal, happy path',
    tags: ['cash'],
    steps: 'Deposit → open review → inspection, financing and title pass → seller KYC → release.',
    expected: 'Closed: 250000 to the seller.',
    preset: CASH
  },
  {
    id: 'T02',
    label: 'Loan funded, release two coins',
    tags: ['loan'],
    steps: 'Deposit 100000 → review → lender funds 150000 → inspection and title pass → seller KYC → release.',
    expected: 'Closed: 100000 + 150000 to the seller (two coins).',
    preset: LOAN
  },
  {
    id: 'T03',
    label: 'Loan refused, refund term on, buyer tops up',
    tags: ['loan', 'refund-on', 'top-up'],
    steps: 'Deposit → review → lender refuses → buyer tops up 150000 inside the window → other contingencies pass → release.',
    expected: 'Closed: deposit + top-up to the seller.',
    preset: LOAN
  },
  {
    id: 'T04',
    label: 'Loan refused, refund term on, no top-up',
    tags: ['loan', 'refund-on'],
    steps: 'Deposit → review → lender refuses → window ends → anyone ends the window → refund buyer.',
    expected: 'Closed: 100000 back to the buyer.',
    preset: LOAN
  },
  {
    id: 'T05',
    label: 'Loan refused, refund term off → forfeit',
    tags: ['loan', 'refund-off', 'forfeit'],
    steps: 'Deposit → review → lender refuses → no top-up → closing deadline → expire → seller KYC → claim forfeit.',
    expected: 'Closed: 100000 to the seller (Forfeited first).',
    preset: { ...LOAN, refundOnLoss: false, closingDays: 2, disputeDays: 4, offerExpiryDays: 1 }
  },
  {
    id: 'T06',
    label: 'Lender withdraws after the offer expiry',
    tags: ['loan', 'withdraw-loan'],
    steps: 'Deposit → review → lender funds → offer expiry passes → lender withdraws → buyer gives up the window → refund buyer.',
    expected: 'Closed: 150000 back to the lender at the withdrawal, 100000 back to the buyer.',
    preset: { ...LOAN, offerExpiryDays: 1 }
  },
  {
    id: 'T07',
    label: 'Cooling-off 1.5 %, withdraw inside',
    tags: ['cash', 'cooling-off'],
    steps: 'Deposit → buyer withdraws inside the period → refund the withdrawal → seller KYC → claim the penalty.',
    expected: 'Closed: 246250 to the buyer, 3750 to the seller (Withdrawn first).',
    preset: { ...CASH, coolingOffDays: 10, penaltyPct: 1.5 }
  },
  {
    id: 'T08',
    label: 'Cooling-off, withdraw after the period → forfeit',
    tags: ['cash', 'cooling-off', 'forfeit'],
    steps: 'Deposit → wait for the end of a 1-day period → buyer withdraws → seller KYC → claim forfeit.',
    expected: 'Closed: 250000 to the seller (Forfeited first).',
    preset: { ...CASH, coolingOffDays: 1, penaltyPct: 1.5 }
  },
  {
    id: 'T09',
    label: 'Cooling-off with no penalty',
    tags: ['cash', 'cooling-off'],
    steps: 'Deposit → buyer withdraws inside the period → refund the withdrawal.',
    expected: 'Closed: 250000 back to the buyer, nothing to claim.',
    preset: { ...CASH, coolingOffDays: 10, penaltyPct: 0 }
  },
  {
    id: 'T10',
    label: 'Failed inspection → full refund',
    tags: ['cash', 'refund'],
    steps: 'Deposit → review → inspection fails → buyer cancels and refunds → refund buyer.',
    expected: 'Closed: 250000 back to the buyer.',
    preset: CASH
  },
  {
    id: 'T11',
    label: 'Dispute, voided result, re-attested',
    tags: ['cash', 'dispute'],
    steps: 'Deposit → review → inspection fails → seller disputes → resolver voids → inspector passes → dismiss → release.',
    expected: 'Closed: 250000 to the seller.',
    preset: CASH
  },
  {
    id: 'T12',
    label: 'Seller withdraws, loan held',
    tags: ['loan', 'seller-withdraw'],
    steps: 'Deposit → review → lender funds → seller withdraws → refund buyer → refund the lender.',
    expected: 'Closed: 100000 back to the buyer, 150000 back to the lender.',
    preset: LOAN
  }
];

export const testCase = (id: string | undefined): TestCase | undefined => (id ? TEST_CASES.find((c) => c.id === id.toUpperCase()) : undefined);

/** Default metadata for a deployment of a case. */
export const metaForCase = (c: TestCase): WireMeta => ({ label: c.label, caseId: c.id, description: `${c.steps} Expected: ${c.expected}`, tags: c.tags });

const DAY = 86_400;

/** The preset turned into the admin forms' values, relative to `nowSec`. */
export function presetValues(c: TestCase, nowSec: number) {
  const p = c.preset;
  const loan = p.depositPct !== undefined;
  // Whole tokens, as typed in the terms form.
  const deposit = loan ? ((BigInt(p.price) * BigInt(p.depositPct!)) / 100n).toString() : p.price;
  return {
    mode: loan ? ('deposited' as const) : ('attested' as const),
    closingDeadline: BigInt(nowSec + p.closingDays * DAY),
    disputeDeadline: BigInt(nowSec + p.disputeDays * DAY),
    loanOfferExpiry: loan ? BigInt(nowSec + (p.offerExpiryDays ?? 20) * DAY) : 0n,
    topUpDays: p.topUpDays ?? 7,
    coolingOffDays: p.coolingOffDays,
    price: p.price,
    deposit,
    refundOnLoss: p.refundOnLoss ?? true,
    /** As typed in the terms form ("1.5"). */
    penaltyPct: String(p.penaltyPct)
  };
}

/** The matrix as Markdown, to paste into a shared document or a ticket. */
export function testMatrixMarkdown(cases: readonly TestCase[] = TEST_CASES): string {
  const esc = (s: string) => s.replace(/\|/g, '\\|');
  const terms = (c: TestCase) => {
    const p = c.preset;
    const parts = [p.depositPct !== undefined ? `loan, deposit ${p.depositPct} %, refund term ${p.refundOnLoss ? 'on' : 'off'}` : 'cash'];
    if (p.coolingOffDays > 0) parts.push(`cooling-off ${p.coolingOffDays} d, penalty ${p.penaltyPct} %`);
    return parts.join('; ');
  };
  return [
    '| Case | Scenario | Terms | Steps | Expected |',
    '|---|---|---|---|---|',
    ...cases.map((c) => `| ${c.id} | ${esc(c.label)} | ${esc(terms(c))} | ${esc(c.steps)} | ${esc(c.expected)} |`)
  ].join('\n');
}
