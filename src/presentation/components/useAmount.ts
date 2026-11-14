'use client';
import { decimalsOf, formatAmount, parseAmount } from '@/domain/amount';
import type { VaultRecord } from '@/application/partyPorts';
import { useEscrow } from '../providers/EscrowProvider';

/** The token's decimals for an escrow: from its terms or lender package, custodian copy, or the deploy-time name. */
export const recordDecimals = (r: VaultRecord): number =>
  decimalsOf(r.terms?.escrowDecimals, r.lenderTerms?.escrowDecimals, r.custody?.terms.escrowDecimals, r.meta?.decimals);

/**
 * Amounts as people read them: base units (what the contract, the terms and the wallet count) shown as whole tokens,
 * "250,000.00 sEUR". `parse` turns typed whole tokens back into base units.
 */
export function useAmount() {
  const { record, view } = useEscrow();
  const decimals = recordDecimals(record);
  const ticker = view?.escrowTicker ?? record.terms?.escrowTicker ?? record.lenderTerms?.escrowTicker ?? '';
  return {
    decimals,
    ticker,
    fmt: (base: bigint | string | null | undefined, withTicker = true) => formatAmount(base, decimals, withTicker ? ticker || undefined : undefined),
    parse: (text: string) => parseAmount(text, decimals)
  };
}
