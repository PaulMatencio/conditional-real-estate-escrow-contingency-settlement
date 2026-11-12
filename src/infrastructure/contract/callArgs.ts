/**
 * Converts domain-level circuit arguments and private material into the exact values the compiled contract and its
 * witnesses expect. Shared by the chain gateway and the in-browser simulator so both run identical inputs.
 */
import type { CallMaterial, CircuitArgs, LenderTerms } from '@/application/partyPorts';
import { AppError } from '@/domain/errors';
import { CONTINGENCIES, type ContingencyName } from '@/domain/escrowView';
import { hex32ToBytes } from '@/domain/hex';
import type { PartyCircuit } from '@/domain/lifecycle';
import { bundleToWitness, lenderTermsFromWire, loanCoinOf, sigFromWire, termsFromWire, topUpCoinOf, vaultCoinOf } from '../crypto/escrowCrypto';
import { Contingency } from './module';
import type { PrivateInputs } from './witnesses';

const contingency = (c: ContingencyName): Contingency => {
  if (!CONTINGENCIES.includes(c)) throw new AppError('VALIDATION', `Unknown contingency ${c}`);
  return Contingency[c];
};

/** Per-call context. `now` (unix s) is what declineLoan / withdrawLoan pass as the current time (block time ± 10 min). */
export interface CallContext {
  contractAddress: string;
  escrowColor: string;
  material: CallMaterial;
  now?: bigint;
}

/** The lender part of the terms: the lender package, or (any party) cut from the full terms. */
export function lenderPart(m: CallMaterial): LenderTerms | null {
  if (m.lenderTerms) return m.lenderTerms;
  const t = m.terms;
  return t ? { lenderShare: t.lenderShare, lenderShareSalt: t.lenderShareSalt, lenderPayout: t.lenderPayout, lenderPayoutSalt: t.lenderPayoutSalt, refundOnLoss: t.refundOnLoss, loanTermsSalt: t.loanTermsSalt } : null;
}

const needNow = (ctx: CallContext): bigint => {
  if (ctx.now === undefined) throw new AppError('VALIDATION', 'This action needs the current time.');
  return ctx.now;
};

export function contractArgs<C extends PartyCircuit>(circuit: C, args: CircuitArgs[C], ctx: CallContext): unknown[] {
  switch (circuit) {
    case 'acceptConfiguration':
      return [(args as CircuitArgs['acceptConfiguration'])[0]];
    case 'submitInspection':
    case 'submitFinancing':
    case 'submitTitle': {
      const [ok, hash] = args as CircuitArgs['submitInspection'];
      return [ok, hex32ToBytes(hash, 'report hash')];
    }
    case 'waiveContingency':
    case 'voidContingencyResult':
      return [contingency((args as CircuitArgs['waiveContingency'])[0])];
    case 'depositToEscrow': {
      const t = ctx.material.terms;
      if (!t) throw new AppError('MISSING_MATERIAL', 'The deposit coin is built from the private terms, which this browser does not hold.');
      return [vaultCoinOf(ctx.contractAddress, ctx.escrowColor, t)];
    }
    case 'depositLoan': {
      const lt = lenderPart(ctx.material);
      if (!lt) throw new AppError('MISSING_MATERIAL', 'The loan coin is built from the lender terms, which this browser does not hold.');
      return [loanCoinOf(ctx.contractAddress, ctx.escrowColor, lt), hex32ToBytes((args as CircuitArgs['depositLoan'])[0], 'commitment letter hash')];
    }
    case 'declineLoan':
      return [hex32ToBytes((args as CircuitArgs['declineLoan'])[0], 'refusal letter hash'), needNow(ctx)];
    case 'withdrawLoan':
      return [needNow(ctx)];
    case 'depositTopUp': {
      const t = ctx.material.terms;
      if (!t) throw new AppError('MISSING_MATERIAL', 'The top-up coin is built from the private terms, which this browser does not hold.');
      return [topUpCoinOf(ctx.contractAddress, ctx.escrowColor, t)];
    }
    case 'revokeKycAttestation': {
      const [issuer, ref, sig] = args as CircuitArgs['revokeKycAttestation'];
      return [hex32ToBytes(issuer, 'issuer id'), hex32ToBytes(ref, 'attestation reference'), sigFromWire(sig)];
    }
    case 'revokeKycIssuer': {
      const [issuer, sig] = args as CircuitArgs['revokeKycIssuer'];
      return [hex32ToBytes(issuer, 'issuer id'), sigFromWire(sig)];
    }
    default:
      return [];
  }
}

/** Witness thunks for one call. Throw a clear error if a circuit asks for material the caller did not supply. */
export function witnessInputs(ctx: CallContext): PrivateInputs {
  const m = ctx.material;
  const lt = lenderPart(m);
  const second = m.secondCoin;
  return {
    secretKey: () => {
      if (!m.secretKey) throw new AppError('MISSING_MATERIAL', 'This action needs your role secret key.');
      return m.secretKey;
    },
    privateTerms: m.terms ? () => termsFromWire(m.terms!) : undefined,
    kycAttestation: m.kyc ? () => bundleToWitness(m.kyc!) : undefined,
    vaultCoin:
      m.terms && m.vaultIndex !== undefined ? () => ({ ...vaultCoinOf(ctx.contractAddress, ctx.escrowColor, m.terms!), mt_index: m.vaultIndex! }) : undefined,
    lenderTerms: lt ? () => lenderTermsFromWire(lt) : undefined,
    secondCoin: second
      ? () => {
          if (second.kind === 'loan') {
            if (!lt) throw new AppError('MISSING_MATERIAL', 'The loan coin is built from the lender terms, which this browser does not hold.');
            return { ...loanCoinOf(ctx.contractAddress, ctx.escrowColor, lt), mt_index: second.index };
          }
          if (!m.terms) throw new AppError('MISSING_MATERIAL', 'The top-up coin is built from the private terms, which this browser does not hold.');
          return { ...topUpCoinOf(ctx.contractAddress, ctx.escrowColor, m.terms), mt_index: second.index };
        }
      : undefined
  };
}
