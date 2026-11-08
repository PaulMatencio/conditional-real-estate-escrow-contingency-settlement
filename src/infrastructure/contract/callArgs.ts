/**
 * Converts domain-level circuit arguments and private material into the exact values the compiled contract and its
 * witnesses expect. Shared by the chain gateway and the in-browser simulator so both run identical inputs.
 */
import type { CallMaterial, CircuitArgs } from '@/application/partyPorts';
import { AppError } from '@/domain/errors';
import { CONTINGENCIES, type ContingencyName } from '@/domain/escrowView';
import { hex32ToBytes } from '@/domain/hex';
import type { PartyCircuit } from '@/domain/lifecycle';
import { bundleToWitness, sigFromWire, termsFromWire, vaultCoinOf } from '../crypto/escrowCrypto';
import { Contingency } from './module';
import type { PrivateInputs } from './witnesses';

const contingency = (c: ContingencyName): Contingency => {
  if (!CONTINGENCIES.includes(c)) throw new AppError('VALIDATION', `Unknown contingency ${c}`);
  return Contingency[c];
};

export function contractArgs<C extends PartyCircuit>(circuit: C, args: CircuitArgs[C], ctx: { contractAddress: string; escrowColor: string; material: CallMaterial }): unknown[] {
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
export function witnessInputs(ctx: { contractAddress: string; escrowColor: string; material: CallMaterial }): PrivateInputs {
  const m = ctx.material;
  return {
    secretKey: () => {
      if (!m.secretKey) throw new AppError('MISSING_MATERIAL', 'This action needs your role secret key.');
      return m.secretKey;
    },
    privateTerms: m.terms ? () => termsFromWire(m.terms!) : undefined,
    kycAttestation: m.kyc ? () => bundleToWitness(m.kyc!) : undefined,
    vaultCoin:
      m.terms && m.vaultIndex !== undefined ? () => ({ ...vaultCoinOf(ctx.contractAddress, ctx.escrowColor, m.terms!), mt_index: m.vaultIndex! }) : undefined
  };
}
