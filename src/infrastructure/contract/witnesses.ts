import type { KycAttestation, LenderTerms, PrivateTerms, SchnorrSignature, Witnesses } from './module';

const TWO_248 = 1n << 248n;

/** What a role's circuits may need from the local (never on-chain) world. Admin circuits need only the key. */
export interface PrivateInputs {
  secretKey: () => Uint8Array;
  privateTerms?: () => PrivateTerms;
  vaultCoin?: () => { nonce: Uint8Array; color: Uint8Array; value: bigint; mt_index: bigint };
  /** v2: the second coin the contract holds (the lender's loan coin or the buyer's top-up coin). */
  secondCoin?: () => { nonce: Uint8Array; color: Uint8Array; value: bigint; mt_index: bigint };
  /** v2: the lender package (lender circuits, and parties refunding the lender). */
  lenderTerms?: () => LenderTerms;
  /** Cooling-off: the penalty coin kept back by the withdrawal refund. */
  penaltyCoin?: () => { nonce: Uint8Array; color: Uint8Array; value: bigint; mt_index: bigint };
  kycAttestation?: () => [KycAttestation, SchnorrSignature, Uint8Array];
}

const missing = (what: string) => () => {
  throw new Error(`This action needs ${what}, which this page does not hold.`);
};

/**
 * Witness bundle. The contract has no on-chain private state (PS = undefined). Inputs are thunks so secrets never
 * live in long-lived module state and callers can swap identities between calls.
 */
export function createWitnesses(inputs: PrivateInputs): Witnesses<undefined> {
  return {
    localSecretKey: (ctx) => [ctx.privateState, inputs.secretKey()],
    schnorrReduction: (ctx, c) => [ctx.privateState, [c / TWO_248, c % TWO_248]],
    privateTerms: (ctx) => [ctx.privateState, (inputs.privateTerms ?? missing('the private terms'))()],
    vaultCoin: (ctx) => [ctx.privateState, (inputs.vaultCoin ?? missing('the vault coin'))()],
    secondCoin: (ctx) => [ctx.privateState, (inputs.secondCoin ?? missing('the loan or top-up coin'))()],
    lenderTerms: (ctx) => [ctx.privateState, (inputs.lenderTerms ?? missing('the lender terms'))()],
    penaltyCoin: (ctx) => [ctx.privateState, (inputs.penaltyCoin ?? missing('the penalty coin'))()],
    kycAttestation: (ctx) => [ctx.privateState, (inputs.kycAttestation ?? missing('a KYC attestation'))()]
  };
}
