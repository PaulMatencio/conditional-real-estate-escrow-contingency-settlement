/**
 * Reading a contract's public state with midnight-js 5. The indexer hands back bytes tagged with the ledger era that
 * wrote them; they are decoded here with the compiled contract's own runtime (compact-runtime 0.21, ledger 9), so the
 * generated `ledger()` reader and the maintenance-authority fields work on the same objects.
 */
import * as rt from '@midnight-ntwrk/compact-runtime';
import type { PublicDataProvider } from '@midnight-ntwrk/midnight-js-types';
import { AppError } from '@/domain/errors';

export type ChainContractState = rt.ContractState;

type Serialized = { era: string; deserialize: (decoders: Record<string, { deserialize(b: Uint8Array): unknown }>) => unknown };

/** Decodes one serialized contract state; contracts from the ledger-8 era are reported, not misread. */
export function decodeContractState(s: unknown): ChainContractState {
  const st = s as Serialized;
  if (st.era !== 'v9') {
    throw new AppError(
      'CONTRACT_VERSION',
      `This contract was deployed on the ledger ${st.era.replace(/^v/, '')} era. This build (Compact 0.36, ledger 9) only reads ledger 9 contracts: deploy a new escrow on the current network.`
    );
  }
  return st.deserialize({ v9: rt.ContractState }) as ChainContractState;
}

/** The contract's current public state, or null when the indexer does not know the address. */
export async function readContractState(pdp: PublicDataProvider, address: string): Promise<ChainContractState | null> {
  const r = await pdp.queryContractState(address);
  return r ? decodeContractState(r.contractState) : null;
}

/** Circuit names whose verifier key is registered in a decoded state. */
export const operationNames = (s: ChainContractState): Set<string> =>
  new Set(s.operations().map((o: unknown) => (typeof o === 'string' ? o : new TextDecoder().decode(o as Uint8Array))));
