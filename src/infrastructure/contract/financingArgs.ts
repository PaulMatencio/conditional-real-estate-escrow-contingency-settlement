import type { FinancingTerms } from '@/domain/escrow';
import { hex32ToBytes } from '@/domain/hex';
import { FinancingMode } from './module';

type Maybe<T> = { is_some: boolean; value: T };
const some = <T,>(value: T): Maybe<T> => ({ is_some: true, value });
const none = <T,>(value: T): Maybe<T> => ({ is_some: false, value });
const ZERO32 = new Uint8Array(32);

/** `configureFinancing` Maybe<…> arguments, in contract order (wallet gateway and simulator share it). */
export function maybeFinancingArgs(f: FinancingTerms): unknown[] {
  const b = (h: string | undefined, what: string) => (h ? some(hex32ToBytes(h, what)) : none(ZERO32));
  const n = (v?: bigint) => (v !== undefined ? some(v) : none(0n));
  return [
    f.mode ? some(f.mode === 'deposited' ? FinancingMode.Deposited : FinancingMode.Attested) : none(FinancingMode.Attested),
    b(f.priceCommitment, 'price commitment'),
    b(f.lenderShareCommitment, 'loan amount commitment'),
    b(f.lenderPayoutCommitment, 'lender payout commitment'),
    b(f.loanTermsCommitment, 'loan terms commitment'),
    n(f.loanOfferExpiry),
    n(f.topUpWindow)
  ];
}
