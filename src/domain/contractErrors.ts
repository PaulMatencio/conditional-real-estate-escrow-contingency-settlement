/**
 * §3.3 Error-code catalogue: contract assertion messages → stable code + user guidance.
 * Matching is by prefix/substring of the assert text, which is all a failed circuit returns.
 */
export type ContractErrorCode =
  | 'TERMS_MISMATCH'
  | 'DEPOSIT_COIN_MISMATCH'
  | 'VAULT_COIN_MISMATCH'
  | 'VAULT_NOT_FULL'
  | 'NOT_WHITELISTED'
  | 'KYC_EXPIRED'
  | 'KYC_LEVEL_INSUFFICIENT'
  | 'AML_RISK_TOO_HIGH'
  | 'KYC_REVOKED'
  | 'SELLER_KYC_REQUIRED'
  | 'TERMS_COMMITMENT_MISMATCH'
  | 'PHASE_ROLE_DEADLINE'
  | 'UNKNOWN';

export interface ContractErrorInfo {
  code: ContractErrorCode;
  /** The contract's own message (or the client-side one), as matched. */
  message: string;
  guidance: string;
}

const RULES: { test: RegExp; code: ContractErrorCode; guidance: string }[] = [
  { test: /ERROR_TERMS_MISMATCH[^"'\n]*/, code: 'TERMS_MISMATCH', guidance: 'Your local terms package does not match the on-chain commitments. Re-sync the package from the Terms vault (FR-TERMS-04).' },
  { test: /TERMS_COMMITMENT_MISMATCH[^"'\n]*/, code: 'TERMS_COMMITMENT_MISMATCH', guidance: 'The terms you hold do not open the commitments on the ledger. Do not accept; ask the admin for the package that was configured.' },
  { test: /ERROR_DEPOSIT_COIN_MISMATCH/, code: 'DEPOSIT_COIN_MISMATCH', guidance: 'The deposit coin was not built from the terms (FR-FUND-01). Rebuild it from the Terms vault.' },
  { test: /ERROR_VAULT_COIN_MISMATCH/, code: 'VAULT_COIN_MISMATCH', guidance: 'The vault coin or its Merkle index is stale or wrong. Re-run vault tracking (FR-FUND-03).' },
  { test: /Vault must be paid out in full/, code: 'VAULT_NOT_FULL', guidance: 'Internal invariant violated. Report to support with the transaction id.' },
  { test: /ERROR_NOT_WHITELISTED[^"'\n]*/, code: 'NOT_WHITELISTED', guidance: 'Untrusted issuer, bad signature, wrong subject or wrong wallet. Check the attestation was issued for your role id and your committed payout key.' },
  { test: /ERROR_KYC_EXPIRED/, code: 'KYC_EXPIRED', guidance: 'The attestation has expired. Obtain a new one from the CASP.' },
  { test: /ERROR_KYC_LEVEL_INSUFFICIENT/, code: 'KYC_LEVEL_INSUFFICIENT', guidance: 'The KYC level is below the escrow policy. Complete further due diligence with the CASP.' },
  { test: /ERROR_AML_RISK_TOO_HIGH/, code: 'AML_RISK_TOO_HIGH', guidance: 'The AML risk score exceeds the escrow policy. Contact the CASP.' },
  { test: /ERROR_KYC_REVOKED/, code: 'KYC_REVOKED', guidance: 'The attestation was revoked by the CASP. Obtain a new one.' },
  { test: /ERROR_SELLER_KYC_REQUIRED/, code: 'SELLER_KYC_REQUIRED', guidance: 'The seller must prove KYC (submitSellerKyc) before the release.' },
  {
    test: /(Escrow is not [a-z ]+|Caller is not [a-z ,]+|Caller cannot cancel|Dispute window is closed|Closing deadline [a-z ]+|Dispute deadline [a-z ]+|Not in contingency review|Contract is already initialized|Configuration (is incomplete|changed since it was read)|[A-Z][a-z]+ outcome already submitted|No submitted contingency has failed|Contingencies are not all cleared|Seller (cannot withdraw|KYC cannot be submitted)[a-z ]*|Funds already disbursed|Escrow already funded|Escrow cannot (expire|be disputed)[a-z ]*|Buyer and seller must accept the configuration|[A-Za-z ]+ must be (distinct|independent)[a-z ]*|No attested [a-z]+ to void|[A-Z][a-z]+ already (passed|approved|cleared))/,
    code: 'PHASE_ROLE_DEADLINE',
    guidance: 'This action is not allowed in the current phase, for your role, or at this time. Check the status and deadlines.'
  }
];

export function classifyContractError(raw: string): ContractErrorInfo {
  for (const r of RULES) {
    const m = r.test.exec(raw);
    if (m) return { code: r.code, message: m[0].trim(), guidance: r.guidance };
  }
  return { code: 'UNKNOWN', message: raw, guidance: '' };
}
