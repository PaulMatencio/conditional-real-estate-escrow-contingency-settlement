/**
 * The ZK artefact provider (keys and ZKIR from the /zk route) with two guards, so a contract update never surfaces as
 * a bare "Failed to fetch ZK artifact … 404":
 *  - a circuit this build does not have is refused before any request (an escrow deployed by another build asks for
 *    it): clear `CONTRACT_VERSION` error;
 *  - a circuit this build has but the server lacks means the page's code and the compiled contract differ (the page
 *    or the dev server predates the last compile): clear "restart the dApp and reload" error.
 */
import { FetchZkConfigProvider } from '@midnight-ntwrk/midnight-js-fetch-zk-config-provider';
import { allCircuitIds } from './compiled';
import { ContractVersionError, staleBundleError } from './compat';

const is404 = (e: unknown): boolean => /\b404\b|not found/i.test(e instanceof Error ? e.message : String(e));

export function unknownCircuitError(circuitId: string): ContractVersionError {
  return new ContractVersionError(
    `Circuit ${circuitId} is not part of this build of the contract: the escrow was deployed with another contract version. Archive it in the escrow switcher and use an escrow deployed with the current contract.`,
    'older-contract',
    [circuitId]
  );
}

export class GuardedZkConfigProvider extends FetchZkConfigProvider<string> {
  constructor(
    baseURL: string,
    options: ConstructorParameters<typeof FetchZkConfigProvider<string>>[1],
    private readonly known: () => readonly string[] = allCircuitIds
  ) {
    super(baseURL, options);
  }

  private async guarded<T>(circuitId: string, load: () => Promise<T>): Promise<T> {
    if (!this.known().includes(circuitId)) throw unknownCircuitError(circuitId);
    try {
      return await load();
    } catch (e) {
      throw is404(e) ? staleBundleError([`−${circuitId} on the server`], e) : e;
    }
  }

  override getProverKey(circuitId: string) {
    return this.guarded(circuitId, () => super.getProverKey(circuitId));
  }

  override getVerifierKey(circuitId: string) {
    return this.guarded(circuitId, () => super.getVerifierKey(circuitId));
  }

  override getZKIR(circuitId: string) {
    return this.guarded(circuitId, () => super.getZKIR(circuitId));
  }
}
