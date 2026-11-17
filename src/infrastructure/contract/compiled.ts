import { CompiledContract } from '@midnight-ntwrk/compact-js';
import type { ContractState } from '@midnight-ntwrk/compact-runtime';
import { createWitnesses, type PrivateInputs } from './witnesses';
import { CURRENT_VERSION, circuitsOf, zkPathOf, type ContractVersion } from './versions';

/** Route (see src/app/zk) that serves keys/ and zkir/ of the CURRENT compiled contract (earlier versions: zkPathOf). */
export const ZK_ASSET_PATH = zkPathOf(CURRENT_VERSION);

/**
 * midnight-js bundles its own compact-runtime typings, so the compiled
 * contract's structural types don't unify with them; the runtime shapes are
 * identical, hence the single, contained cast below.
 */
/** Copy of `state` that keeps only the named operations (data, authority and balances are carried over). */
export function onlyOperations(state: ContractState, keep: readonly string[]): ContractState {
  // Same class as the original: the constructor's state comes from onchain-runtime, a different WASM module
  // than ledger-v9's ContractState, and their ChargedState/authority objects are not interchangeable.
  const next = new (state.constructor as new () => ContractState)();
  next.data = state.data;
  next.maintenanceAuthority = state.maintenanceAuthority;
  next.balance = state.balance;
  for (const name of state.operations()) {
    const key = typeof name === 'string' ? name : new TextDecoder().decode(name);
    const op = state.operation(name);
    if (op && keep.includes(key)) next.setOperation(name, op);
  }
  return next;
}

/** Every provable circuit of a contract version (default: the current one). */
export function allCircuitIds(version: ContractVersion = CURRENT_VERSION): string[] {
  return circuitsOf(version);
}

/**
 * A Contract that exposes only `keep`'s circuits. midnight-js derives the verifier keys a deploy carries
 * from the contract's provable circuits, so this shrinks the deploy transaction; the omitted circuits are
 * registered afterwards (see ChainGateway.registerCircuit).
 */
function subsetOf(keep: readonly string[], Base: ContractVersion['Contract']) {
  return class SubsetContract extends Base<undefined> {
    constructor(w: ConstructorParameters<ContractVersion['Contract']>[0]) {
      super(w as never);
      const pick = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([k]) => keep.includes(k))) as T;
      this.provableCircuits = pick(this.provableCircuits);
      this.impureCircuits = pick(this.impureCircuits);
    }

    /**
     * The generated constructor registers an (empty) operation for EVERY circuit. Only the kept ones get a
     * verifier key attached, and the node rejects keyless operations ("InvalidTransaction::Custom(110) =
     * VerifierKeyNotSet"). ContractState can't delete an operation, so rebuild it with the kept ones only.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    initialState(...args: any[]): any {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fix = (r: any) => ({ ...r, currentContractState: onlyOperations(r.currentContractState, keep) });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r: any = (super.initialState as any)(...args);
      return r instanceof Promise ? r.then(fix) : fix(r);
    }
  };
}

/** The compiled contract of `version` (default: current), optionally restricted to `circuits`. */
export function makeCompiledContract(
  getSecretKey: () => Uint8Array,
  circuits?: readonly string[],
  extra: Omit<PrivateInputs, 'secretKey'> = {},
  version: ContractVersion = CURRENT_VERSION
): unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const make = CompiledContract.make as any;
  return make(version.name, circuits ? subsetOf(circuits, version.Contract) : version.Contract).pipe(
    (CompiledContract.withWitnesses as any)(createWitnesses({ secretKey: getSecretKey, ...extra })),
    (CompiledContract.withCompiledFileAssets as any)(zkPathOf(version))
  );
}
